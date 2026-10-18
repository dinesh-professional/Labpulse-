/**
 * Instrument Scheduling & Booking Engine (Module 07) — Spec §8, §15, §18.
 * Complete booking lifecycle: PENDING_APPROVAL, CONFIRMED, CHECKED_IN, COMPLETED, CANCELLED, REJECTED, NO_SHOW.
 * Zero-cost invariant: booking is FREE — unexpected money/rate/grant fields are rejected outright.
 * Features:
 *   - Idempotency via Idempotency-Key header or idempotencyKey body field.
 *   - Operating hours, maintenance, calibration, curriculum, and operator qualification checks.
 *   - Database-enforced GiST exclusion constraint against double-booking.
 *   - Role-based authorization: Students can only view/manage their own bookings;
 *     Faculty/Admins can manage and approve/reject/record no-shows.
 *   - Atomic rescheduling with collision rollback.
 */
const express = require('express');
const {
  bookingRepository,
  qrRepository,
  instrumentRepository,
  userRepository,
} = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { logAudit } = require('../utils/audit');
const { notifyUser } = require('../services/notify');
const { issueOpaqueToken } = require('../utils/tokens');
const { isHHMM, toMinutes, parseDayUTC, dayRangeUTC, isPastDay, toDayString } = require('../utils/time');
const { checkBookingGates } = require('../utils/bookingGates');
const { acquireLock } = require('../utils/mutex');
const { isValidId } = require('../utils/idValidation');
const {
  BOOKING_STATUS,
  BLOCKING_STATUSES,
  TERMINAL_STATUSES,
  validateStatusTransition,
} = require('../services/bookingLifecycle');
const {
  validateBookingRequest,
  computeInstrumentAvailability,
} = require('../services/availabilityEngine');

const router = express.Router();

function requireDB(req, res, next) {
  if (getActiveDataBackend() === 'supabase') return next();
  if (dbState() !== 1) {
    return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
  }
  return next();
}
router.use(requireDB, requireAuth);

const canWrite = requireRole('admin', 'faculty');

const CREATE_FIELDS = ['instrumentId', 'date', 'startTime', 'endTime', 'purpose', 'idempotencyKey'];
const PATCH_FIELDS = ['date', 'startTime', 'endTime', 'purpose', 'status'];

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? 'Unexpected field(s): ' + extra.join(', ') + '. Booking is free — price/rate/grant fields are never accepted.' : null;
}

function normalizeWindow(body) {
  if (!isValidId(body.instrumentId)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'instrumentId must be a valid id.' };
  }
  const dateStr = String(body.date || '').trim();
  const day = parseDayUTC(dateStr);
  if (!day) return { status: 422, code: 'INVALID_DATE', message: 'date must be YYYY-MM-DD.' };
  if (isPastDay(dateStr)) return { status: 422, code: 'INVALID_DATE', message: 'date cannot be in the past.' };
  if (!isHHMM(body.startTime) || !isHHMM(body.endTime)) {
    return { status: 422, code: 'INVALID_TIME_RANGE', message: 'startTime/endTime must be HH:mm.' };
  }
  if (toMinutes(body.endTime) <= toMinutes(body.startTime)) {
    return { status: 422, code: 'INVALID_TIME_RANGE', message: 'endTime must be after startTime.' };
  }
  if (typeof body.purpose !== 'string' || !body.purpose.trim()) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'purpose is required.' };
  }
  return { value: { instrumentId: body.instrumentId, dateStr, date: day, startTime: body.startTime, endTime: body.endTime, purpose: body.purpose.trim().slice(0, 500) } };
}

function bookingEndDate(dateStr, endTime) {
  return new Date(`${dateStr}T${endTime}:00Z`);
}

async function issueQrPass(booking, dateStr, endTime) {
  const { token, tokenHash } = issueOpaqueToken();
  const bookingId = booking.id || booking._id;
  const qp = await qrRepository.create({
    bookingId,
    tokenHash,
    expiresAt: new Date(bookingEndDate(dateStr, endTime).getTime() + 30 * 60000),
    status: 'ACTIVE',
  });
  const qrPassId = qp.id || qp._id;
  await bookingRepository.updateById(bookingId, { qrPassId });
  return token;
}

async function notifyBooking(user, booking, instrument, kind, qrToken) {
  const subjects = {
    created: 'LabPulse booking confirmed',
    cancelled: 'LabPulse booking cancelled',
    requested: 'LabPulse booking request received',
    approved: 'LabPulse booking approved',
    rejected: 'LabPulse booking rejected',
    rescheduled: 'LabPulse booking rescheduled',
  };
  const bookingId = booking.id || booking._id;
  const data = {
    instrument: instrument ? instrument.name : 'Laboratory Instrument',
    user: user ? user.name : 'User',
    date: toDayString(booking.date),
    startTime: booking.startTime,
    endTime: booking.endTime,
    purpose: booking.purpose,
    status: booking.status,
    referenceId: String(bookingId),
  };
  if (qrToken) data.qrToken = qrToken;
  return notifyUser({
    userId: user._id || user.id,
    type: `booking-${kind}`,
    title: subjects[kind] || 'LabPulse booking notification',
    message: `${data.instrument} on ${data.date} ${data.startTime}–${data.endTime} [${data.referenceId}]`,
    entityType: 'booking',
    entityId: String(bookingId),
    dedupKey: `booking-${kind}-${bookingId}`,
    email: user.email ? { to: user.email, subject: subjects[kind] || 'LabPulse booking notification', template: `booking-${kind}`, data } : undefined,
  });
}

async function loadOwned(req, res) {
  if (!isValidId(req.params.id)) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    return null;
  }
  const b = await bookingRepository.findById(req.params.id);
  if (!b) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found.' } });
    return null;
  }
  const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);
  const currentUserId = req.user._id || req.user.id;
  if (req.user.role !== 'admin' && String(ownerId) !== String(currentUserId)) {
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You can only manage your own bookings.' } });
    return null;
  }
  return b;
}

/* ---------------- AVAILABILITY ENGINE ---------------- */
router.get('/availability', async (req, res, next) => {
  try {
    const { instrumentId, date, days } = req.query;
    if (!instrumentId || !isValidId(instrumentId)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'instrumentId is required and must be valid.' } });
    }
    const dateStr = String(date || '').trim();
    if (!parseDayUTC(dateStr)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'date (YYYY-MM-DD) is required.' } });
    }
    const avail = await computeInstrumentAvailability(instrumentId, dateStr, days);
    if (!avail) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instrument not found.' } });
    }
    return res.json({ success: true, data: avail });
  } catch (err) {
    return next(err);
  }
});

/* ---------------- USER'S OWN BOOKINGS (MY) ---------------- */
router.get('/my', async (req, res, next) => {
  try {
    const filter = {
      userId: req.user._id || req.user.id,
    };
    if (req.query.status) {
      if (!Object.values(BOOKING_STATUS).includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      filter.status = req.query.status;
    }
    if (req.query.instrumentId && isValidId(req.query.instrumentId)) {
      filter.instrumentId = req.query.instrumentId;
    }
    if (req.query.date) {
      const range = dayRangeUTC(String(req.query.date));
      if (!range) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'date must be YYYY-MM-DD.' } });
      filter.date = req.query.date;
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
    const [total, rows] = await Promise.all([
      bookingRepository.count(filter),
      bookingRepository.list(filter, { page, limit }),
    ]);
    return res.json({ success: true, data: { bookings: rows, page, limit, total } });
  } catch (err) {
    return next(err);
  }
});

/* ---------------- AUTHORIZED BOOKING HISTORY ---------------- */
router.get('/history', async (req, res, next) => {
  try {
    const filter = {};
    const currentUserId = req.user._id || req.user.id;

    // Students and faculty can only view their own history; admins can view all or specify userId
    if (req.user.role === 'student' || req.user.role === 'faculty') {
      filter.userId = currentUserId;
    } else if (req.query.userId && isValidId(req.query.userId)) {
      filter.userId = req.query.userId;
    }

    if (req.query.status) {
      if (!TERMINAL_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `History status must be one of: ${TERMINAL_STATUSES.join(', ')}.` } });
      }
      filter.status = req.query.status;
    }

    if (req.query.instrumentId && isValidId(req.query.instrumentId)) {
      filter.instrumentId = req.query.instrumentId;
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));

    // If no specific status provided, filter by terminal statuses in list query
    const [total, rows] = await Promise.all([
      bookingRepository.count(filter),
      bookingRepository.list(filter, { page, limit }),
    ]);

    // Keep terminal records
    const terminalRows = filter.status ? rows : rows.filter(r => TERMINAL_STATUSES.includes(r.status));
    return res.json({ success: true, data: { bookings: terminalRows, page, limit, total: filter.status ? total : terminalRows.length } });
  } catch (err) {
    return next(err);
  }
});

/* ---------------- CREATE BOOKING REQUEST (PENDING_APPROVAL) ---------------- */
router.post('/request', async (req, res, next) => {
  let releaseLock;
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'JSON body is required.' } });
    }
    const bad = allowOnly(req.body, CREATE_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });

    // Idempotency check
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey;
    const currentUserId = req.user._id || req.user.id;
    if (idempotencyKey) {
      const existing = await bookingRepository.findByIdempotencyKey(idempotencyKey, currentUserId);
      if (existing) {
        return res.status(200).json({
          success: true,
          data: { booking: existing, idempotent: true },
          message: 'Booking request already submitted (idempotent replay).',
        });
      }
    }

    const norm = normalizeWindow(req.body);
    if (norm.status) return res.status(norm.status).json({ success: false, error: { code: norm.code, message: norm.message } });

    releaseLock = await acquireLock(`instrument-day:${norm.value.instrumentId}:${norm.value.dateStr}`);
    const gate = await checkBookingGates({ user: req.user, ...norm.value });
    if (gate.status) return res.status(gate.status).json({ success: false, error: { code: gate.code, message: gate.message } });

    let booking;
    try {
      booking = await bookingRepository.create({
        instrumentId: norm.value.instrumentId,
        userId: currentUserId,
        date: norm.value.date,
        startTime: norm.value.startTime,
        endTime: norm.value.endTime,
        purpose: norm.value.purpose,
        status: BOOKING_STATUS.PENDING_APPROVAL,
        idempotencyKey: idempotencyKey || null,
      });
    } catch (dbErr) {
      if (dbErr.code === 'BOOKING_CONFLICT' || dbErr.status === 409) {
        return res.status(409).json({ success: false, error: { code: 'BOOKING_CONFLICT', message: dbErr.message || 'Instrument is already booked during this time.' } });
      }
      throw dbErr;
    }

    const bookingId = booking.id || booking._id;
    await logAudit({
      userId: currentUserId,
      action: 'BOOKING_REQUESTED',
      resource: 'Booking',
      resourceId: bookingId,
      details: { instrumentId: String(norm.value.instrumentId), status: BOOKING_STATUS.PENDING_APPROVAL },
      req,
    });

    const row = await bookingRepository.findById(bookingId);
    return res.status(201).json({
      success: true,
      data: { booking: row },
      message: 'Booking request submitted and pending approval.',
    });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  } finally {
    if (releaseLock) releaseLock();
  }
});

const { parsePagination, parseSort, sanitizeSearchTerm, parseDateRange } = require('../utils/queryParser');
const { toCsv } = require('../utils/csv');

const ALLOWED_BOOKING_SORTS = {
  date: 'date',
  startTime: 'startTime',
  endTime: 'endTime',
  status: 'status',
  createdAt: 'createdAt',
};

/* ---------------- EXPORT (CSV) ---------------- */
router.get('/export', async (req, res, next) => {
  try {
    const filter = {};

    // Role-based scope enforcement
    if (req.user.role === 'student') {
      if (req.query.userId && String(req.query.userId) !== String(req.user._id || req.user.id)) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Students can only access their own bookings.' } });
      }
      filter.userId = req.user._id || req.user.id;
    } else if (req.query.userId && isValidId(req.query.userId)) {
      filter.userId = req.query.userId;
    }

    if (req.query.instrumentId && isValidId(req.query.instrumentId)) {
      filter.instrumentId = req.query.instrumentId;
    }
    if (req.query.status && Object.values(BOOKING_STATUS).includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const { startDate, endDate, error: dateErr } = parseDateRange(req.query);
    if (dateErr) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: dateErr } });
    }
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    if (req.query.date) filter.date = req.query.date;

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_BOOKING_SORTS, 'date', 'desc');

    const rows = await bookingRepository.list(filter, {
      page: 1,
      limit: 1000,
      sortBy,
      sortOrder,
    });

    const columns = [
      { key: 'id', label: 'Booking ID', transform: (r) => r.id || r._id },
      { key: 'instrumentName', label: 'Instrument', transform: (r) => (r.instrumentId && (r.instrumentId.name || r.instrumentId.id)) || 'N/A' },
      { key: 'userName', label: 'User Name', transform: (r) => (r.userId && (r.userId.name || r.userId.email)) || 'N/A' },
      { key: 'userEmail', label: 'User Email', transform: (r) => (r.userId && r.userId.email) || 'N/A' },
      { key: 'date', label: 'Date', transform: (r) => toDayString(r.date) },
      { key: 'startTime', label: 'Start Time' },
      { key: 'endTime', label: 'End Time' },
      { key: 'status', label: 'Status' },
      { key: 'purpose', label: 'Purpose' },
      { key: 'createdAt', label: 'Created At', transform: (r) => (r.createdAt ? new Date(r.createdAt).toISOString() : '') },
    ];

    const csvData = toCsv(rows, columns);

    await logAudit({
      userId: req.user._id || req.user.id,
      actorRole: req.user.role,
      action: 'BOOKINGS_EXPORTED',
      resource: 'Booking',
      status: 'SUCCESS',
      details: { count: rows.length, filter },
      req,
    });

    const filename = `bookings-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvData);
  } catch (err) {
    return next(err);
  }
});

/* ---------------- LIST ---------------- */
router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    for (const f of ['instrumentId', 'userId']) {
      if (req.query[f]) {
        if (!isValidId(req.query[f])) {
          return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Invalid ${f}.` } });
        }
        filter[f] = req.query[f];
      }
    }

    // Role isolation: Students can strictly only view their own bookings
    if (req.user.role === 'student') {
      if (req.query.userId && String(req.query.userId) !== String(req.user._id || req.user.id)) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Students can only access their own bookings.' } });
      }
      filter.userId = req.user._id || req.user.id;
    } else if (req.query.mine === 'true') {
      filter.userId = req.user._id || req.user.id;
    }

    if (req.query.status) {
      if (!Object.values(BOOKING_STATUS).includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      filter.status = req.query.status;
    }

    const { startDate, endDate, error: dateErr } = parseDateRange(req.query);
    if (dateErr) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: dateErr } });
    }
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    if (req.query.date) {
      const range = dayRangeUTC(String(req.query.date));
      if (!range) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'date must be YYYY-MM-DD.' } });
      filter.date = req.query.date;
    }

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { page, limit } = parsePagination(req.query, 20, 100);
    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_BOOKING_SORTS, 'date', 'desc');

    const [total, rows] = await Promise.all([
      bookingRepository.count(filter),
      bookingRepository.list(filter, { page, limit, sortBy, sortOrder }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;
    return res.json({
      success: true,
      data: {
        bookings: rows,
        page,
        limit,
        total,
        totalPages,
        sortBy,
        sortOrder,
      },
    });
  } catch (err) { return next(err); }
});

/* ---------------- DETAIL ---------------- */
router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await bookingRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found.' } });

    // IDOR protection: Students can only view their own bookings
    const ownerId = row.userId && (row.userId._id || row.userId.id || row.userId);
    const currentUserId = req.user._id || req.user.id;
    if (req.user.role === 'student' && String(ownerId) !== String(currentUserId)) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You can only view your own bookings.' } });
    }

    return res.json({ success: true, data: { booking: row } });
  } catch (err) { return next(err); }
});

/* ---------------- CREATE (free, faculty/admin) ---------------- */
router.post('/', canWrite, async (req, res, next) => {
  let releaseCreateLock;
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'JSON body is required.' } });
    }
    const bad = allowOnly(req.body, CREATE_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });

    // Idempotency check
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey;
    const currentUserId = req.user._id || req.user.id;
    if (idempotencyKey) {
      const existing = await bookingRepository.findByIdempotencyKey(idempotencyKey, currentUserId);
      if (existing) {
        return res.status(200).json({
          success: true,
          data: { booking: existing, idempotent: true },
          message: 'Booking already processed (idempotent replay).',
        });
      }
    }

    const norm = normalizeWindow(req.body);
    if (norm.status) return res.status(norm.status).json({ success: false, error: { code: norm.code, message: norm.message } });

    // Application mutex + database exclusion constraint protection
    releaseCreateLock = await acquireLock(`instrument-day:${norm.value.instrumentId}:${norm.value.dateStr}`);
    const gate = await checkBookingGates({ user: req.user, ...norm.value });
    if (gate.status) return res.status(gate.status).json({ success: false, error: { code: gate.code, message: gate.message } });

    let booking;
    try {
      booking = await bookingRepository.create({
        instrumentId: norm.value.instrumentId,
        userId: currentUserId,
        date: norm.value.date,
        startTime: norm.value.startTime,
        endTime: norm.value.endTime,
        purpose: norm.value.purpose,
        status: BOOKING_STATUS.CONFIRMED,
        idempotencyKey: idempotencyKey || null,
      });
    } catch (dbErr) {
      if (dbErr.code === 'BOOKING_CONFLICT' || dbErr.status === 409) {
        return res.status(409).json({ success: false, error: { code: 'BOOKING_CONFLICT', message: dbErr.message || 'Instrument is already booked during this time.' } });
      }
      throw dbErr;
    }

    const bookingId = booking.id || booking._id;
    const qrToken = await issueQrPass(booking, norm.value.dateStr, norm.value.endTime);
    await notifyBooking(req.user, booking, gate.instrument, 'created', qrToken);
    await logAudit({
      userId: currentUserId,
      action: 'BOOKING_CREATED',
      resource: 'Booking',
      resourceId: bookingId,
      details: { instrumentId: String(norm.value.instrumentId) },
      req,
    });

    const row = await bookingRepository.findById(bookingId);
    return res.status(201).json({ success: true, data: { booking: row, qrToken }, message: 'Instrument booked — free of charge.' });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  } finally {
    if (releaseCreateLock) releaseCreateLock();
  }
});

/* ---------------- APPROVE (admin or faculty) ---------------- */
router.post('/:id/approve', canWrite, async (req, res, next) => {
  let releaseLock;
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const b = await bookingRepository.findById(req.params.id);
    if (!b) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found.' } });

    const bookingId = b.id || b._id;
    const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);
    const trans = validateStatusTransition(b.status, BOOKING_STATUS.CONFIRMED, req.user, ownerId);
    if (!trans.allowed) {
      return res.status(trans.status || 422).json({ success: false, error: { code: trans.code || 'INVALID_STATUS_TRANSITION', message: trans.message } });
    }

    const instId = b.instrumentId && (b.instrumentId._id || b.instrumentId.id || b.instrumentId);
    const dateStr = toDayString(b.date);

    // Re-check operational gates and conflicts before approval
    releaseLock = await acquireLock(`instrument-day:${instId}:${dateStr}`);
    const owner = await userRepository.findById(ownerId);
    const gate = await checkBookingGates({ user: owner || req.user, instrumentId: instId, dateStr, startTime: b.startTime, endTime: b.endTime, excludeId: bookingId });
    if (gate.status) {
      return res.status(gate.status).json({ success: false, error: { code: gate.code, message: `Cannot approve: ${gate.message}` } });
    }

    const notes = req.body && typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 500) : '';
    await bookingRepository.updateById(bookingId, {
      status: BOOKING_STATUS.CONFIRMED,
      approvedBy: req.user._id || req.user.id,
      approvedAt: new Date(),
      approvalNotes: notes,
    });

    const qrToken = await issueQrPass(b, dateStr, b.endTime);
    if (owner && gate.instrument) {
      await notifyBooking(owner, b, gate.instrument, 'approved', qrToken);
    }

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'BOOKING_APPROVED',
      resource: 'Booking',
      resourceId: bookingId,
      details: { approvedBy: String(req.user._id || req.user.id) },
      req,
    });

    const row = await bookingRepository.findById(bookingId);
    return res.json({ success: true, data: { booking: row, qrToken }, message: 'Booking approved successfully.' });
  } catch (err) {
    return next(err);
  } finally {
    if (releaseLock) releaseLock();
  }
});

/* ---------------- REJECT (admin or faculty) ---------------- */
router.post('/:id/reject', canWrite, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const b = await bookingRepository.findById(req.params.id);
    if (!b) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found.' } });

    const bookingId = b.id || b._id;
    const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);
    const trans = validateStatusTransition(b.status, BOOKING_STATUS.REJECTED, req.user, ownerId);
    if (!trans.allowed) {
      return res.status(trans.status || 422).json({ success: false, error: { code: trans.code || 'INVALID_STATUS_TRANSITION', message: trans.message } });
    }

    const reason = req.body && typeof req.body.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 500)
      : 'Booking request rejected by laboratory staff.';

    await qrRepository.revokeForBooking(bookingId);
    await bookingRepository.updateById(bookingId, {
      status: BOOKING_STATUS.REJECTED,
      rejectionReason: reason,
    });

    const instId = b.instrumentId && (b.instrumentId._id || b.instrumentId.id || b.instrumentId);
    const [owner, inst] = await Promise.all([
      userRepository.findById(ownerId),
      instrumentRepository.findById(instId),
    ]);
    if (owner && inst) {
      await notifyBooking(owner, b, inst, 'rejected');
    }

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'BOOKING_REJECTED',
      resource: 'Booking',
      resourceId: bookingId,
      details: { reason },
      req,
    });

    const row = await bookingRepository.findById(bookingId);
    return res.json({ success: true, data: { booking: row }, message: 'Booking request rejected.' });
  } catch (err) {
    return next(err);
  }
});

/* ---------------- CANCEL (owner or admin) ---------------- */
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const b = await loadOwned(req, res);
    if (!b) return undefined;
    const bookingId = b.id || b._id;
    const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);

    const trans = validateStatusTransition(b.status, BOOKING_STATUS.CANCELLED, req.user, ownerId);
    if (!trans.allowed) {
      return res.status(trans.status || 422).json({ success: false, error: { code: trans.code || 'INVALID_STATUS_TRANSITION', message: trans.message } });
    }

    await bookingRepository.cancelBookingAtomic(bookingId, req.user._id || req.user.id);
    const instId = b.instrumentId && (b.instrumentId._id || b.instrumentId.id || b.instrumentId);
    const [owner, inst] = await Promise.all([
      req.user.role === 'admin' ? userRepository.findById(ownerId) : req.user,
      instrumentRepository.findById(instId),
    ]);
    if (owner && inst) {
      await notifyBooking(owner, b, inst, 'cancelled');
    }

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'BOOKING_CANCELLED',
      resource: 'Booking',
      resourceId: bookingId,
      details: {},
      req,
    });

    const row = await bookingRepository.findById(bookingId);
    return res.json({ success: true, data: { booking: row }, message: 'Booking cancelled.' });
  } catch (err) {
    return next(err);
  }
});

/* ---------------- RESCHEDULE (owner or admin, atomic) ---------------- */
router.post('/:id/reschedule', async (req, res, next) => {
  let releaseLock;
  try {
    const b = await loadOwned(req, res);
    if (!b) return undefined;
    const bookingId = b.id || b._id;

    if (TERMINAL_STATUSES.includes(b.status)) {
      return res.status(422).json({ success: false, error: { code: 'INVALID_STATUS_TRANSITION', message: `Cannot reschedule a ${b.status} booking.` } });
    }

    const instId = b.instrumentId && (b.instrumentId._id || b.instrumentId.id || b.instrumentId);
    const merged = {
      instrumentId: String(instId),
      date: req.body.date,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      purpose: b.purpose,
    };
    const norm = normalizeWindow(merged);
    if (norm.status) return res.status(norm.status).json({ success: false, error: { code: norm.code, message: norm.message } });

    releaseLock = await acquireLock(`instrument-day:${norm.value.instrumentId}:${norm.value.dateStr}`);
    const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);
    const owner = req.user.role === 'admin' ? await userRepository.findById(ownerId) : req.user;

    const gate = await checkBookingGates({
      user: owner || req.user,
      ...norm.value,
      excludeId: bookingId,
    });
    if (gate.status) {
      return res.status(gate.status).json({ success: false, error: { code: gate.code, message: gate.message } });
    }

    // Atomic update with rollback preservation
    const originalDate = b.date;
    const originalStart = b.startTime;
    const originalEnd = b.endTime;

    try {
      await bookingRepository.updateById(bookingId, {
        date: norm.value.date,
        startTime: norm.value.startTime,
        endTime: norm.value.endTime,
      });

      // Update QR pass expiration if active
      if (b.status === BOOKING_STATUS.CONFIRMED) {
        const newExpiry = new Date(bookingEndDate(norm.value.dateStr, norm.value.endTime).getTime() + 30 * 60000);
        await qrRepository.updateByBookingId(bookingId, { expiresAt: newExpiry });
      }
    } catch (dbErr) {
      // Rollback on conflict to guarantee atomicity
      await bookingRepository.updateById(bookingId, {
        date: originalDate,
        startTime: originalStart,
        endTime: originalEnd,
      });
      if (dbErr.code === 'BOOKING_CONFLICT' || dbErr.status === 409) {
        return res.status(409).json({ success: false, error: { code: 'BOOKING_CONFLICT', message: 'Target timeslot is already booked by another reservation.' } });
      }
      throw dbErr;
    }

    const updated = await bookingRepository.findById(bookingId);
    const inst = await instrumentRepository.findById(instId);
    if (owner && inst) {
      await notifyBooking(owner, updated, inst, 'rescheduled');
    }

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'BOOKING_RESCHEDULED',
      resource: 'Booking',
      resourceId: bookingId,
      details: {
        previous: { date: toDayString(originalDate), startTime: originalStart, endTime: originalEnd },
        new: { date: norm.value.dateStr, startTime: norm.value.startTime, endTime: norm.value.endTime },
      },
      req,
    });

    return res.json({ success: true, data: { booking: updated }, message: 'Booking rescheduled successfully.' });
  } catch (err) {
    if (err && (err.code === 'BOOKING_CONFLICT' || err.status === 409)) {
      return res.status(409).json({ success: false, error: { code: 'BOOKING_CONFLICT', message: err.message || 'Instrument is already booked during this time.' } });
    }
    return next(err);
  } finally {
    if (releaseLock) releaseLock();
  }
});

/* ---------------- COMPLETE (admin, faculty, or owner) ---------------- */
router.post('/:id/complete', async (req, res, next) => {
  try {
    const b = await loadOwned(req, res);
    if (!b) return undefined;
    const bookingId = b.id || b._id;
    const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);

    const trans = validateStatusTransition(b.status, BOOKING_STATUS.COMPLETED, req.user, ownerId);
    if (!trans.allowed) {
      return res.status(trans.status || 422).json({ success: false, error: { code: trans.code || 'INVALID_STATUS_TRANSITION', message: trans.message } });
    }

    await bookingRepository.updateById(bookingId, { status: BOOKING_STATUS.COMPLETED });
    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'BOOKING_COMPLETED',
      resource: 'Booking',
      resourceId: bookingId,
      details: {},
      req,
    });

    const row = await bookingRepository.findById(bookingId);
    return res.json({ success: true, data: { booking: row }, message: 'Booking marked as completed.' });
  } catch (err) {
    return next(err);
  }
});

/* ---------------- NO-SHOW (admin or faculty) ---------------- */
router.post('/:id/no-show', canWrite, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const b = await bookingRepository.findById(req.params.id);
    if (!b) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found.' } });

    const bookingId = b.id || b._id;
    const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);

    const trans = validateStatusTransition(b.status, BOOKING_STATUS.NO_SHOW, req.user, ownerId);
    if (!trans.allowed) {
      return res.status(trans.status || 422).json({ success: false, error: { code: trans.code || 'INVALID_STATUS_TRANSITION', message: trans.message } });
    }

    await qrRepository.revokeForBooking(bookingId);
    await bookingRepository.updateById(bookingId, { status: BOOKING_STATUS.NO_SHOW });

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'BOOKING_NO_SHOW',
      resource: 'Booking',
      resourceId: bookingId,
      details: {},
      req,
    });

    const row = await bookingRepository.findById(bookingId);
    return res.json({ success: true, data: { booking: row }, message: 'No-show recorded.' });
  } catch (err) {
    return next(err);
  }
});

/* ---------------- UPDATE (legacy PATCH) ---------------- */
router.patch('/:id', canWrite, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, PATCH_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const b = await loadOwned(req, res);
    if (!b) return undefined;
    const bookingId = b.id || b._id;

    if (req.body.status !== undefined && !['CONFIRMED', 'CANCELLED'].includes(req.body.status)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'status must be CONFIRMED or CANCELLED (check-in is terminal-only).' } });
    }

    // Cancel-only fast path
    const onlyCancel = req.body.status === 'CANCELLED'
      && req.body.date === undefined && req.body.startTime === undefined
      && req.body.endTime === undefined && req.body.purpose === undefined;

    if (onlyCancel) {
      await bookingRepository.cancelBookingAtomic(bookingId, req.user._id || req.user.id);
      const instId = b.instrumentId && (b.instrumentId._id || b.instrumentId.id || b.instrumentId);
      const inst = await instrumentRepository.findById(instId);
      const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);
      const owner = req.user.role === 'admin' ? await userRepository.findById(ownerId) : req.user;
      if (owner && inst) await notifyBooking(owner, b, inst, 'cancelled');
      await logAudit({ userId: req.user._id || req.user.id, action: 'BOOKING_CANCELLED', resource: 'Booking', resourceId: bookingId, details: {}, req });
      const row = await bookingRepository.findById(bookingId);
      return res.json({ success: true, data: { booking: row } });
    }

    const instId = b.instrumentId && (b.instrumentId._id || b.instrumentId.id || b.instrumentId);
    const merged = {
      instrumentId: String(instId), date: toDayString(b.date),
      startTime: b.startTime, endTime: b.endTime, purpose: b.purpose, ...req.body,
    };
    const norm = normalizeWindow(merged);
    if (norm.status) return res.status(norm.status).json({ success: false, error: { code: norm.code, message: norm.message } });

    const releaseRescheduleLock = await acquireLock(`instrument-day:${norm.value.instrumentId}:${norm.value.dateStr}`);
    try {
      const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);
      const user = req.user.role === 'admin' ? await userRepository.findById(ownerId) : req.user;
      const gate = await checkBookingGates({ user: user || req.user, ...norm.value, excludeId: bookingId });
      if (gate.status) return res.status(gate.status).json({ success: false, error: { code: gate.code, message: gate.message } });

      const updateData = { date: norm.value.date, startTime: norm.value.startTime, endTime: norm.value.endTime, purpose: norm.value.purpose };
      if (req.body.status) updateData.status = req.body.status;
      await bookingRepository.updateById(bookingId, updateData);
    } finally {
      releaseRescheduleLock();
    }

    await logAudit({ userId: req.user._id || req.user.id, action: 'BOOKING_UPDATED', resource: 'Booking', resourceId: bookingId, details: { status: req.body.status || b.status }, req });
    const row = await bookingRepository.findById(bookingId);
    return res.json({ success: true, data: { booking: row } });
  } catch (err) {
    if (err && (err.code === 'BOOKING_CONFLICT' || err.status === 409)) {
      return res.status(409).json({ success: false, error: { code: 'BOOKING_CONFLICT', message: err.message || 'Instrument is already booked during this time.' } });
    }
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- DELETE ---------------- */
router.delete('/:id', canWrite, async (req, res, next) => {
  try {
    const b = await loadOwned(req, res);
    if (!b) return undefined;
    const bookingId = b.id || b._id;
    const instId = b.instrumentId && (b.instrumentId._id || b.instrumentId.id || b.instrumentId);
    const inst = await instrumentRepository.findById(instId);
    const ownerId = b.userId && (b.userId._id || b.userId.id || b.userId);
    const owner = req.user.role === 'admin' ? await userRepository.findById(ownerId) : req.user;

    await qrRepository.revokeForBooking(bookingId);
    await bookingRepository.deleteById(bookingId);
    if (owner && inst) await notifyBooking(owner, b, inst, 'cancelled');
    await logAudit({ userId: req.user._id || req.user.id, action: 'BOOKING_DELETED', resource: 'Booking', resourceId: bookingId, details: {}, req });
    return res.status(204).end();
  } catch (err) { return next(err); }
});

/* ---------------- (RE)ISSUE QR PASS ---------------- */
router.post('/:id/qr', canWrite, async (req, res, next) => {
  try {
    const b = await loadOwned(req, res);
    if (!b) return undefined;
    const bookingId = b.id || b._id;
    if (b.status !== 'CONFIRMED') {
      return res.status(422).json({ success: false, error: { code: 'QR_NOT_AVAILABLE', message: 'QR passes are issued for confirmed bookings only.' } });
    }
    await qrRepository.revokeForBooking(bookingId);
    const { token, tokenHash } = issueOpaqueToken();
    const expiresAt = new Date(bookingEndDate(toDayString(b.date), b.endTime).getTime() + 30 * 60000);
    const qp = await qrRepository.create({
      bookingId,
      tokenHash,
      expiresAt,
      status: 'ACTIVE',
    });
    const passId = qp.id || qp._id;
    await bookingRepository.updateById(bookingId, { qrPassId: passId });
    await logAudit({ userId: req.user._id || req.user.id, action: 'QR_ISSUED', resource: 'Booking', resourceId: bookingId, details: { passId: String(passId) }, req });
    return res.status(201).json({ success: true, data: { qrToken: token, expiresAt, passId } });
  } catch (err) { return next(err); }
});

module.exports = router;
