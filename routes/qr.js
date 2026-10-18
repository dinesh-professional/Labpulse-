/**
 * QR Access Pass Routes (Module 09) — spec §12 + §15.
 *
 * Endpoints:
 *   POST   /check-in        — Atomic single-use token redemption (uses DB stored procedure)
 *   GET    /booking/:id      — Retrieve active QR pass status for a booking
 *   POST   /revoke/:id       — Explicitly revoke an active pass
 *   POST   /validate         — Dry-run validation (checks pass + booking without consuming)
 *
 * Security:
 *   - Tokens are opaque high-entropy random (32 bytes hex), only sha256 hashes stored.
 *   - Redemption is atomic (PostgreSQL row-level locking via redeem_qr_pass()).
 *   - Owner or admin authorization enforced on all endpoints.
 *   - No sensitive data (token hashes, internal IDs) leaked in responses.
 */
const express = require('express');
const {
  qrRepository,
  bookingRepository,
  userRepository,
  instrumentRepository,
  qualificationRepository,
} = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { logAudit } = require('../utils/audit');
const { hashOpaqueToken } = require('../utils/tokens');
const { isValidId } = require('../utils/idValidation');
const { notifyUser } = require('../services/notify');

const router = express.Router();

function requireDB(req, res, next) {
  if (getActiveDataBackend() === 'supabase') return next();
  if (dbState() !== 1) {
    return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
  }
  return next();
}
router.use(requireDB, requireAuth);

const EARLY_GRACE_MS = 15 * 60000;

function windowOf(booking) {
  const day = new Date(booking.date).toISOString().slice(0, 10);
  return { start: new Date(`${day}T${booking.startTime}:00Z`), end: new Date(`${day}T${booking.endTime}:00Z`) };
}

function sanitizePassResponse(pass) {
  if (!pass) return null;
  return {
    id: pass.id || pass._id,
    bookingId: pass.bookingId,
    status: pass.status,
    expiresAt: pass.expiresAt,
    checkedInAt: pass.checkedInAt || null,
    createdAt: pass.createdAt,
  };
}

/* ============================================================================
   POST /check-in — Atomic single-use token redemption
   ============================================================================ */
router.post('/check-in', async (req, res, next) => {
  try {
    const token = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    if (!token) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'token is required.' } });
    }
    const tokenHash = hashOpaqueToken(token);
    const pass = await qrRepository.findByTokenHash(tokenHash);
    if (!pass) return res.status(404).json({ success: false, error: { code: 'QR_NOT_FOUND', message: 'Access pass not recognized.' } });
    if (pass.status === 'REVOKED') {
      return res.status(410).json({ success: false, error: { code: 'QR_REVOKED', message: 'Access pass was revoked.' } });
    }
    if (pass.status === 'USED') {
      return res.status(409).json({ success: false, error: { code: 'QR_ALREADY_USED', message: 'Access pass already used (replay rejected).' } });
    }
    if (pass.status === 'EXPIRED' || pass.expiresAt < new Date()) {
      if (pass.status === 'ACTIVE') {
        await qrRepository.updateById(pass.id || pass._id, { status: 'EXPIRED' });
      }
      return res.status(410).json({ success: false, error: { code: 'QR_EXPIRED', message: 'Access pass expired.' } });
    }

    const booking = await bookingRepository.findById(pass.bookingId);
    if (!booking) return res.status(410).json({ success: false, error: { code: 'BOOKING_GONE', message: 'Booking no longer exists.' } });
    if (booking.status === 'CANCELLED') {
      return res.status(410).json({ success: false, error: { code: 'BOOKING_CANCELLED', message: 'Booking was cancelled.' } });
    }
    if (booking.status === 'CHECKED_IN' || booking.status === 'COMPLETED') {
      return res.status(409).json({ success: false, error: { code: 'ALREADY_CHECKED_IN', message: 'Booking already checked in.' } });
    }

    const bookingOwnerId = booking.userId && (booking.userId._id || booking.userId.id || booking.userId);
    const currentUserId = req.user._id || req.user.id;
    if (req.user.role !== 'admin' && String(bookingOwnerId) !== String(currentUserId)) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'This pass belongs to another user.' } });
    }

    // Point-of-use revalidation: verify booking owner account is active
    const owner = await userRepository.findById(bookingOwnerId);
    if (!owner || owner.isActive === false) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_DEACTIVATED', message: 'User account is deactivated or suspended. Check-in denied.' },
      });
    }

    // Point-of-use revalidation: verify operator qualification if instrument requires it
    const instId = booking.instrumentId && (booking.instrumentId._id || booking.instrumentId.id || booking.instrumentId);
    const instrument = await instrumentRepository.findById(instId);
    if (instrument && instrument.requiredQualificationLevel > 0 && owner.role !== 'admin') {
      const isQualified = await qualificationRepository.checkUserQualification(
        bookingOwnerId,
        instId,
        instrument.requiredQualificationLevel
      );
      if (!isQualified) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'QUALIFICATION_INVALID',
            message: 'Operator qualification is no longer valid, expired, or has been revoked/suspended. Access denied.',
          },
        });
      }
    }

    const now = new Date();
    const { start, end } = windowOf(booking);
    if (now < new Date(start.getTime() - EARLY_GRACE_MS)) {
      return res.status(422).json({ success: false, error: { code: 'TOO_EARLY', message: 'Check-in opens 15 minutes before the slot.' } });
    }
    if (now > end) {
      await qrRepository.updateById(pass.id || pass._id, { status: 'EXPIRED' });
      return res.status(422).json({ success: false, error: { code: 'WINDOW_PAST', message: 'Booking window has ended.' } });
    }

    // --- Atomic redemption via stored procedure (race-condition safe) ---
    const operatorId = req.user._id || req.user.id;
    let redeemResult;
    try {
      redeemResult = await qrRepository.redeemPassAtomic(tokenHash, operatorId);
    } catch (redeemErr) {
      // Fallback for non-Supabase (MongoDB) — the method handles its own atomicity
      if (redeemErr.code === 'QR_ALREADY_USED' || redeemErr.error === 'QR_ALREADY_USED') {
        return res.status(409).json({ success: false, error: { code: 'QR_ALREADY_USED', message: 'Access pass already used (replay rejected).' } });
      }
      throw redeemErr;
    }

    // Handle stored procedure error responses
    if (redeemResult && redeemResult.success === false) {
      const errorMap = {
        QR_NOT_FOUND: { status: 404, code: 'QR_NOT_FOUND', message: 'Access pass not recognized.' },
        INVALID_TOKEN: { status: 404, code: 'QR_NOT_FOUND', message: 'Access pass not recognized.' },
        QR_REVOKED: { status: 410, code: 'QR_REVOKED', message: 'Access pass was revoked.' },
        QR_ALREADY_USED: { status: 409, code: 'QR_ALREADY_USED', message: 'Access pass already used (replay rejected).' },
        ALREADY_USED: { status: 409, code: 'QR_ALREADY_USED', message: 'Access pass already used (replay rejected).' },
        QR_EXPIRED: { status: 410, code: 'QR_EXPIRED', message: 'Access pass expired.' },
        EXPIRED: { status: 410, code: 'QR_EXPIRED', message: 'Access pass expired.' },
        BOOKING_GONE: { status: 410, code: 'BOOKING_GONE', message: 'Booking no longer exists.' },
        BOOKING_NOT_FOUND: { status: 410, code: 'BOOKING_GONE', message: 'Booking no longer exists.' },
        BOOKING_CANCELLED: { status: 410, code: 'BOOKING_CANCELLED', message: 'Booking was cancelled.' },
        ALREADY_CHECKED_IN: { status: 409, code: 'ALREADY_CHECKED_IN', message: 'Booking already checked in.' },
        INVALID_BOOKING_STATE: { status: 409, code: 'ALREADY_CHECKED_IN', message: 'Booking is not in confirmed state.' },
      };
      const mapped = errorMap[redeemResult.error] || { status: 422, code: redeemResult.error || 'REDEMPTION_FAILED', message: redeemResult.message || 'Pass redemption failed.' };
      return res.status(mapped.status).json({ success: false, error: { code: mapped.code, message: mapped.message } });
    }

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'QR_CHECKED_IN',
      resource: 'Booking',
      resourceId: booking.id || booking._id,
      details: { passId: String(pass.id || pass._id) },
      req,
    });

    const instName = (booking.instrumentId && booking.instrumentId.name) || 'Instrument';
    const checkedInAt = (redeemResult && redeemResult.checked_in_at) || now.toISOString();

    await notifyUser({
      userId: bookingOwnerId,
      type: 'qr-check-in-success',
      title: 'Laboratory check-in confirmed',
      message: `Checked in successfully for ${instName} (${booking.startTime}–${booking.endTime}). Interlock engaged.`,
      entityType: 'booking',
      entityId: String(booking.id || booking._id),
      dedupKey: `qr-checkin-${pass.id || pass._id}`,
    });

    return res.json({
      success: true,
      data: {
        booking: {
          id: booking.id || booking._id,
          instrument: instName,
          date: new Date(booking.date).toISOString().slice(0, 10),
          startTime: booking.startTime,
          endTime: booking.endTime,
          status: 'CHECKED_IN',
        },
        interlock: { power: 'ON', interlock: 'ENGAGED', checkedInAt },
      },
      message: 'Checked in. Interlock engaged.',
    });
  } catch (err) { return next(err); }
});

/* ============================================================================
   GET /booking/:id — Retrieve active QR pass for a booking
   ============================================================================ */
router.get('/booking/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid booking id.' } });
    }

    const booking = await bookingRepository.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found.' } });
    }

    // Authorization: owner or admin/faculty
    const bookingOwnerId = booking.userId && (booking.userId._id || booking.userId.id || booking.userId);
    const currentUserId = req.user._id || req.user.id;
    if (req.user.role === 'student' && String(bookingOwnerId) !== String(currentUserId)) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You can only view your own booking passes.' } });
    }

    const pass = await qrRepository.findActiveByBookingId(req.params.id);
    if (!pass) {
      return res.json({ success: true, data: { pass: null }, message: 'No active pass for this booking.' });
    }

    return res.json({ success: true, data: { pass: sanitizePassResponse(pass) } });
  } catch (err) { return next(err); }
});

/* ============================================================================
   POST /revoke/:id — Explicitly revoke an active pass
   ============================================================================ */
router.post('/revoke/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid pass id.' } });
    }

    const pass = await qrRepository.findById(req.params.id);
    if (!pass) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Access pass not found.' } });
    }

    if (pass.status !== 'ACTIVE') {
      return res.status(422).json({ success: false, error: { code: 'INVALID_STATE', message: `Pass is already ${pass.status}. Only ACTIVE passes can be revoked.` } });
    }

    // Authorization: booking owner, faculty, or admin
    const booking = await bookingRepository.findById(pass.bookingId);
    if (booking) {
      const bookingOwnerId = booking.userId && (booking.userId._id || booking.userId.id || booking.userId);
      const currentUserId = req.user._id || req.user.id;
      if (req.user.role === 'student' && String(bookingOwnerId) !== String(currentUserId)) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You can only revoke your own passes.' } });
      }
    }

    await qrRepository.updateById(pass.id || pass._id, { status: 'REVOKED' });

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'QR_REVOKED',
      resource: 'QrAccessPass',
      resourceId: pass.id || pass._id,
      details: { bookingId: String(pass.bookingId), revokedBy: String(req.user._id || req.user.id) },
      req,
    });

    const targetUserId = booking ? (booking.userId && (booking.userId._id || booking.userId.id || booking.userId)) : (req.user._id || req.user.id);
    if (targetUserId) {
      await notifyUser({
        userId: targetUserId,
        type: 'qr-pass-revoked',
        title: 'QR access pass revoked',
        message: `Your access pass for booking has been revoked.`,
        entityType: 'qr_pass',
        entityId: String(pass.id || pass._id),
        dedupKey: `qr-revoked-${pass.id || pass._id}`,
      });
    }

    return res.json({ success: true, message: 'Access pass revoked.' });
  } catch (err) { return next(err); }
});

/* ============================================================================
   POST /validate — Dry-run validation (does NOT consume the pass)
   ============================================================================ */
router.post('/validate', async (req, res, next) => {
  try {
    const token = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    if (!token) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'token is required.' } });
    }

    // Only admin/faculty can validate (kiosk/terminal operators)
    if (req.user.role !== 'admin' && req.user.role !== 'faculty') {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only staff can validate passes.' } });
    }

    const tokenHash = hashOpaqueToken(token);
    const pass = await qrRepository.findByTokenHash(tokenHash);
    if (!pass) {
      return res.json({ success: true, data: { valid: false, reason: 'QR_NOT_FOUND', message: 'Access pass not recognized.' } });
    }

    if (pass.status !== 'ACTIVE') {
      return res.json({ success: true, data: { valid: false, reason: `QR_${pass.status}`, message: `Pass status is ${pass.status}.` } });
    }

    if (pass.expiresAt < new Date()) {
      return res.json({ success: true, data: { valid: false, reason: 'QR_EXPIRED', message: 'Access pass has expired.' } });
    }

    const booking = await bookingRepository.findById(pass.bookingId);
    if (!booking) {
      return res.json({ success: true, data: { valid: false, reason: 'BOOKING_GONE', message: 'Associated booking not found.' } });
    }

    if (booking.status === 'CANCELLED') {
      return res.json({ success: true, data: { valid: false, reason: 'BOOKING_CANCELLED', message: 'Booking was cancelled.' } });
    }

    if (booking.status !== 'CONFIRMED') {
      return res.json({ success: true, data: { valid: false, reason: 'INVALID_BOOKING_STATE', message: `Booking is in ${booking.status} state.` } });
    }

    // Point-of-use revalidation: verify booking owner account is active
    const bookingOwnerId = booking.userId && (booking.userId._id || booking.userId.id || booking.userId);
    const owner = await userRepository.findById(bookingOwnerId);
    if (!owner || owner.isActive === false) {
      return res.json({ success: true, data: { valid: false, reason: 'ACCOUNT_DEACTIVATED', message: 'User account is deactivated or suspended.' } });
    }

    // Point-of-use revalidation: verify operator qualification if instrument requires it
    const instId = booking.instrumentId && (booking.instrumentId._id || booking.instrumentId.id || booking.instrumentId);
    const instrument = await instrumentRepository.findById(instId);
    if (instrument && instrument.requiredQualificationLevel > 0 && owner.role !== 'admin') {
      const isQualified = await qualificationRepository.checkUserQualification(
        bookingOwnerId,
        instId,
        instrument.requiredQualificationLevel
      );
      if (!isQualified) {
        return res.json({
          success: true,
          data: {
            valid: false,
            reason: 'QUALIFICATION_INVALID',
            message: 'Operator qualification is no longer valid, expired, or has been revoked/suspended.',
          },
        });
      }
    }

    const now = new Date();
    const { start, end } = windowOf(booking);
    const withinWindow = now >= new Date(start.getTime() - EARLY_GRACE_MS) && now <= end;
    const instName = (booking.instrumentId && booking.instrumentId.name) || 'Instrument';

    return res.json({
      success: true,
      data: {
        valid: true,
        withinWindow,
        pass: sanitizePassResponse(pass),
        booking: {
          id: booking.id || booking._id,
          instrument: instName,
          date: new Date(booking.date).toISOString().slice(0, 10),
          startTime: booking.startTime,
          endTime: booking.endTime,
          status: booking.status,
        },
      },
    });
  } catch (err) { return next(err); }
});

module.exports = router;
