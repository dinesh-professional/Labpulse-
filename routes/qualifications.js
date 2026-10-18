/**
 * Operator Qualifications Management (Module 12) — spec §3, §5, §6, §7, §13.
 *
 * Full Lifecycle:
 *   1. Qualification requested: POST /request (status: PENDING)
 *   2. Pending queue review: GET /queue
 *   3. Approved: POST /:id/approve (status: ACTIVE, enforces SELF_APPROVAL_BLOCKED)
 *   4. Rejected: POST /:id/reject (status: REJECTED, enforces SELF_APPROVAL_BLOCKED)
 *   5. Renewed: POST /:id/renew (status: ACTIVE, extends expiresAt, enforces SELF_APPROVAL_BLOCKED)
 *   6. Suspended: POST /:id/suspend (status: SUSPENDED)
 *   7. Revoked: POST /:id/revoke (status: REVOKED)
 *
 * Integrated with:
 *   - Audit logging (logAudit)
 *   - Notification service (notifyUser)
 *   - Authorization (admin & faculty reviews, IDOR protection, self-approval guards)
 */
const express = require('express');
const {
  qualificationRepository,
  userRepository,
  instrumentRepository,
} = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { logAudit } = require('../utils/audit');
const { notifyUser } = require('../services/notify');
const { isValidId } = require('../utils/idValidation');
const { parsePagination, parseSort, sanitizeSearchTerm } = require('../utils/queryParser');
const { toCsv } = require('../utils/csv');

const router = express.Router();

function requireDB(req, res, next) {
  if (getActiveDataBackend() === 'supabase') return next();
  if (dbState() !== 1) {
    return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
  }
  return next();
}
router.use(requireDB, requireAuth);

const ALLOWED_QUALIFICATION_SORTS = {
  createdAt: { dbField: 'created_at', mongoField: 'createdAt' },
  expiresAt: { dbField: 'expires_at', mongoField: 'expiresAt' },
  level: { dbField: 'level', mongoField: 'level' },
  status: { dbField: 'status', mongoField: 'status' },
};

const CREATE_FIELDS = ['userId', 'instrumentId', 'scope', 'level', 'expiresAt', 'status', 'evidenceUrl', 'evidenceNotes'];
const REQUEST_FIELDS = ['instrumentId', 'scope', 'level', 'evidenceUrl', 'evidenceNotes'];
const PATCH_FIELDS = ['scope', 'level', 'expiresAt', 'status', 'evidenceUrl', 'evidenceNotes'];
const QUAL_STATUSES = ['ACTIVE', 'EXPIRED', 'SUSPENDED', 'PENDING', 'REJECTED', 'REVOKED'];

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}.` : null;
}

function isDup(err) {
  return err && (err.code === 11000 || err.code === '23505');
}

/* ============================================================================
   1. GET /mine or /my — User's Own Qualifications
   ============================================================================ */
router.get('/mine', async (req, res, next) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const rows = await qualificationRepository.list({ userId: currentUserId });
    return res.json({ success: true, data: { qualifications: rows } });
  } catch (err) { return next(err); }
});

router.get('/my', async (req, res, next) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const rows = await qualificationRepository.list({ userId: currentUserId });
    return res.json({ success: true, data: { qualifications: rows } });
  } catch (err) { return next(err); }
});

/* ============================================================================
   2. GET /queue — Pending Qualification Verification Queue (Admin / Faculty)
   ============================================================================ */
router.get('/queue', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));

    const [total, rows] = await Promise.all([
      qualificationRepository.count({ status: 'PENDING' }),
      qualificationRepository.list({ status: 'PENDING' }, { page, limit }),
    ]);

    return res.json({
      success: true,
      data: {
        qualifications: rows,
        page,
        limit,
        total,
      },
    });
  } catch (err) { return next(err); }
});

/* ============================================================================
   3. POST /request — Submit Qualification Request with Evidence
   ============================================================================ */
router.post('/request', async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'JSON body is required.' } });
    }
    const bad = allowOnly(req.body, REQUEST_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });

    let instrument = null;
    if (req.body.instrumentId !== undefined) {
      if (!isValidId(req.body.instrumentId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid instrumentId.' } });
      }
      instrument = await instrumentRepository.findById(req.body.instrumentId);
      if (!instrument) {
        return res.status(404).json({ success: false, error: { code: 'INSTRUMENT_NOT_FOUND', message: 'Instrument not found.' } });
      }
    }

    const level = Number.isInteger(req.body.level) ? req.body.level : 1;
    if (level < 1 || level > 4) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'level must be an integer between 1 and 4.' } });
    }

    const currentUserId = req.user._id || req.user.id;
    const instId = instrument ? (instrument._id || instrument.id) : undefined;
    const scope = typeof req.body.scope === 'string' ? req.body.scope.trim().slice(0, 160) : undefined;
    const evidenceUrl = typeof req.body.evidenceUrl === 'string' ? req.body.evidenceUrl.trim().slice(0, 500) : null;
    const evidenceNotes = typeof req.body.evidenceNotes === 'string' ? req.body.evidenceNotes.trim().slice(0, 1000) : null;

    const row = await qualificationRepository.create({
      userId: currentUserId,
      ...(instId ? { instrumentId: instId } : {}),
      ...(scope ? { scope } : {}),
      level,
      status: 'PENDING',
      evidenceUrl,
      evidenceNotes,
    });

    const rowId = row._id || row.id;
    await logAudit({
      userId: currentUserId,
      action: 'QUALIFICATION_REQUESTED',
      resource: 'OperatorQualification',
      resourceId: rowId,
      details: { instrumentId: instId ? String(instId) : null, level },
      req,
    });

    await notifyUser({
      userId: currentUserId,
      type: 'qualification-submitted',
      title: 'Qualification Request Submitted',
      message: `Your Level ${level} qualification application has been received and is pending faculty review.`,
      entityType: 'qualification',
      entityId: String(rowId),
      dedupKey: `qual-request-${rowId}`,
    });

    return res.status(201).json({ success: true, data: { qualification: row }, message: 'Qualification application submitted successfully.' });
  } catch (err) {
    if (isDup(err)) {
      return res.status(409).json({ success: false, error: { code: 'DUPLICATE_QUALIFICATION', message: 'A qualification record already exists for this user and instrument.' } });
    }
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ============================================================================
   4. GET /export — Export Qualifications to CSV (Admin / Faculty)
   ============================================================================ */
router.get('/export', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.userId && isValidId(req.query.userId)) filter.userId = req.query.userId;
    if (req.query.instrumentId && isValidId(req.query.instrumentId)) filter.instrumentId = req.query.instrumentId;
    if (req.query.status && QUAL_STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (req.query.level) {
      const lvl = parseInt(req.query.level, 10);
      if (lvl >= 1 && lvl <= 4) filter.level = lvl;
    }

    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_QUALIFICATION_SORTS, 'createdAt', 'desc');

    const rows = await qualificationRepository.list(filter, {
      page: 1,
      limit: 1000,
      sortBy,
      sortOrder,
    });

    const columns = [
      { key: '_id', label: 'ID' },
      { key: 'userId', label: 'User ID' },
      { key: 'instrumentId', label: 'Instrument ID' },
      { key: 'level', label: 'Level' },
      { key: 'status', label: 'Status' },
      { key: 'scope', label: 'Scope' },
      { key: 'certifiedBy', label: 'Certified By' },
      { key: 'certifiedAt', label: 'Certified At' },
      { key: 'expiresAt', label: 'Expires At' },
      { key: 'createdAt', label: 'Created At' },
    ];

    const csvData = toCsv(rows, columns);

    await logAudit({
      userId: req.user._id || req.user.id,
      actorRole: req.user.role,
      action: 'QUALIFICATIONS_EXPORTED',
      resource: 'OperatorQualification',
      status: 'SUCCESS',
      details: { count: rows.length, filter },
      req,
    });

    const filename = `qualifications-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvData);
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   5. GET / — Paginated Qualification List with Filters (Admin / Faculty)
   ============================================================================ */
router.get('/', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.userId) {
      if (!isValidId(req.query.userId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid userId.' } });
      }
      filter.userId = req.query.userId;
    }
    if (req.query.instrumentId) {
      if (!isValidId(req.query.instrumentId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid instrumentId.' } });
      }
      filter.instrumentId = req.query.instrumentId;
    }
    if (req.query.status) {
      if (!QUAL_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      filter.status = req.query.status;
    }
    if (req.query.level) {
      const lvl = parseInt(req.query.level, 10);
      if (lvl >= 1 && lvl <= 4) filter.level = lvl;
    }

    const { page, limit } = parsePagination(req.query, 20, 100);
    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_QUALIFICATION_SORTS, 'createdAt', 'desc');

    const [total, rows] = await Promise.all([
      qualificationRepository.count(filter),
      qualificationRepository.list(filter, { page, limit, sortBy, sortOrder }),
    ]);
    const totalPages = Math.ceil(total / limit) || 1;
    return res.json({
      success: true,
      data: {
        qualifications: rows,
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

/* ============================================================================
   5. POST / — Direct Grant (Admin / Faculty)
   ============================================================================ */
router.post('/', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'JSON body is required.' } });
    }
    const bad = allowOnly(req.body, CREATE_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    if (!isValidId(req.body.userId)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'userId must be a valid id.' } });
    }
    const user = await userRepository.findById(req.body.userId);
    if (!user) return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });

    let instrument = null;
    if (req.body.instrumentId !== undefined) {
      if (!isValidId(req.body.instrumentId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid instrumentId.' } });
      }
      instrument = await instrumentRepository.findById(req.body.instrumentId);
      if (!instrument) return res.status(404).json({ success: false, error: { code: 'INSTRUMENT_NOT_FOUND', message: 'Instrument not found.' } });
    }
    if (!Number.isInteger(req.body.level) || req.body.level < 1 || req.body.level > 4) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'level must be an integer 1–4.' } });
    }
    let expiresAt;
    if (req.body.expiresAt !== undefined) {
      expiresAt = new Date(req.body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'expiresAt must be a valid date.' } });
      }
    }
    const status = req.body.status || 'ACTIVE';
    if (!QUAL_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
    }

    const currentUserId = req.user._id || req.user.id;
    const targetUserId = user._id || user.id;
    const instId = instrument ? (instrument._id || instrument.id) : undefined;

    const row = await qualificationRepository.create({
      userId: targetUserId,
      ...(instId ? { instrumentId: instId } : {}),
      ...(typeof req.body.scope === 'string' ? { scope: req.body.scope.trim().slice(0, 160) } : {}),
      level: req.body.level,
      certifiedBy: currentUserId,
      certifiedAt: new Date(),
      ...(expiresAt ? { expiresAt } : {}),
      status,
      evidenceUrl: req.body.evidenceUrl || null,
      evidenceNotes: req.body.evidenceNotes || null,
    });

    const rowId = row._id || row.id;
    await logAudit({
      userId: currentUserId,
      action: 'QUALIFICATION_GRANTED',
      resource: 'OperatorQualification',
      resourceId: rowId,
      details: { userId: String(targetUserId), level: row.level },
      req,
    });

    await notifyUser({
      userId: targetUserId,
      type: 'qualification-granted',
      title: 'Qualification Granted',
      message: `You have been granted Level ${row.level} qualification.`,
      entityType: 'qualification',
      entityId: String(rowId),
      dedupKey: `qual-grant-${rowId}`,
    });

    return res.status(201).json({ success: true, data: { qualification: row } });
  } catch (err) {
    if (isDup(err)) return res.status(409).json({ success: false, error: { code: 'DUPLICATE_QUALIFICATION', message: 'User already has a qualification record for this instrument.' } });
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ============================================================================
   6. GET /:id — Detail View (Owner, Faculty, Admin)
   ============================================================================ */
router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await qualificationRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Qualification not found.' } });

    const ownerId = row.userId && (row.userId._id || row.userId.id || row.userId);
    const currentUserId = req.user._id || req.user.id;
    if (req.user.role === 'student' && String(ownerId) !== String(currentUserId)) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You can only view your own qualifications.' } });
    }

    return res.json({ success: true, data: { qualification: row } });
  } catch (err) { return next(err); }
});

/* ============================================================================
   7. POST /:id/approve — Verify & Approve (Admin / Faculty, Self-Approval Guard)
   ============================================================================ */
router.post('/:id/approve', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await qualificationRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Qualification not found.' } });

    const currentUserId = req.user._id || req.user.id;
    const targetUserId = row.userId && (row.userId._id || row.userId.id || row.userId);

    // CRITICAL: Prevent self-approval
    if (String(targetUserId) === String(currentUserId)) {
      return res.status(403).json({
        success: false,
        error: { code: 'SELF_APPROVAL_BLOCKED', message: 'Authorized personnel cannot approve their own operator qualifications.' },
      });
    }

    let expiresAt;
    if (req.body && req.body.expiresAt !== undefined) {
      expiresAt = new Date(req.body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'expiresAt must be a valid date.' } });
      }
    }

    let level;
    if (req.body && req.body.level !== undefined) {
      if (!Number.isInteger(req.body.level) || req.body.level < 1 || req.body.level > 4) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'level must be an integer between 1 and 4.' } });
      }
      level = req.body.level;
    }

    const notes = req.body && typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 1000) : undefined;
    const rowId = row._id || row.id;

    const updated = await qualificationRepository.approve(rowId, {
      certifiedBy: currentUserId,
      level,
      expiresAt,
      notes,
    });

    await logAudit({
      userId: currentUserId,
      action: 'QUALIFICATION_APPROVED',
      resource: 'OperatorQualification',
      resourceId: rowId,
      details: { targetUserId: String(targetUserId), level: updated.level },
      req,
    });

    await notifyUser({
      userId: targetUserId,
      type: 'qualification-approved',
      title: 'Operator Qualification Approved',
      message: `Your Level ${updated.level} operator qualification has been verified and approved.`,
      entityType: 'qualification',
      entityId: String(rowId),
      dedupKey: `qual-approved-${rowId}`,
    });

    return res.json({ success: true, data: { qualification: updated }, message: 'Qualification approved successfully.' });
  } catch (err) { return next(err); }
});

/* ============================================================================
   8. POST /:id/reject — Reject Application (Admin / Faculty, Self-Approval Guard)
   ============================================================================ */
router.post('/:id/reject', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await qualificationRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Qualification not found.' } });

    const currentUserId = req.user._id || req.user.id;
    const targetUserId = row.userId && (row.userId._id || row.userId.id || row.userId);

    // CRITICAL: Prevent self-rejection / self-review
    if (String(targetUserId) === String(currentUserId)) {
      return res.status(403).json({
        success: false,
        error: { code: 'SELF_APPROVAL_BLOCKED', message: 'Authorized personnel cannot review their own operator qualifications.' },
      });
    }

    const reason = (req.body && typeof req.body.reason === 'string' && req.body.reason.trim())
      ? req.body.reason.trim().slice(0, 500)
      : 'Prerequisite criteria or documentation not met.';

    const rowId = row._id || row.id;
    const updated = await qualificationRepository.reject(rowId, {
      certifiedBy: currentUserId,
      reason,
    });

    await logAudit({
      userId: currentUserId,
      action: 'QUALIFICATION_REJECTED',
      resource: 'OperatorQualification',
      resourceId: rowId,
      details: { targetUserId: String(targetUserId), reason },
      req,
    });

    await notifyUser({
      userId: targetUserId,
      type: 'qualification-rejected',
      title: 'Qualification Request Rejected',
      message: `Your qualification application was rejected: ${reason}`,
      entityType: 'qualification',
      entityId: String(rowId),
      dedupKey: `qual-rejected-${rowId}`,
    });

    return res.json({ success: true, data: { qualification: updated }, message: 'Qualification rejected.' });
  } catch (err) { return next(err); }
});

/* ============================================================================
   9. POST /:id/renew — Renew Qualification (Admin / Faculty, Self-Approval Guard)
   ============================================================================ */
router.post('/:id/renew', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await qualificationRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Qualification not found.' } });

    const currentUserId = req.user._id || req.user.id;
    const targetUserId = row.userId && (row.userId._id || row.userId.id || row.userId);

    if (String(targetUserId) === String(currentUserId)) {
      return res.status(403).json({
        success: false,
        error: { code: 'SELF_APPROVAL_BLOCKED', message: 'Authorized personnel cannot renew their own operator qualifications.' },
      });
    }

    if (!req.body || !req.body.expiresAt) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'expiresAt is required for renewal.' } });
    }
    const expiresAt = new Date(req.body.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'expiresAt must be a valid future date.' } });
    }

    let level;
    if (req.body.level !== undefined) {
      if (!Number.isInteger(req.body.level) || req.body.level < 1 || req.body.level > 4) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'level must be an integer between 1 and 4.' } });
      }
      level = req.body.level;
    }

    const rowId = row._id || row.id;
    const updated = await qualificationRepository.renew(rowId, {
      certifiedBy: currentUserId,
      expiresAt,
      level,
    });

    await logAudit({
      userId: currentUserId,
      action: 'QUALIFICATION_RENEWED',
      resource: 'OperatorQualification',
      resourceId: rowId,
      details: { targetUserId: String(targetUserId), expiresAt: expiresAt.toISOString() },
      req,
    });

    await notifyUser({
      userId: targetUserId,
      type: 'qualification-renewed',
      title: 'Operator Qualification Renewed',
      message: `Your operator qualification has been renewed through ${expiresAt.toISOString().slice(0, 10)}.`,
      entityType: 'qualification',
      entityId: String(rowId),
      dedupKey: `qual-renew-${rowId}-${Date.now()}`,
    });

    return res.json({ success: true, data: { qualification: updated }, message: 'Qualification renewed successfully.' });
  } catch (err) { return next(err); }
});

/* ============================================================================
   10. POST /:id/suspend — Suspend Qualification (Admin / Faculty)
   ============================================================================ */
router.post('/:id/suspend', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await qualificationRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Qualification not found.' } });

    const currentUserId = req.user._id || req.user.id;
    const targetUserId = row.userId && (row.userId._id || row.userId.id || row.userId);

    const reason = (req.body && typeof req.body.reason === 'string' && req.body.reason.trim())
      ? req.body.reason.trim().slice(0, 500)
      : 'Qualification temporarily suspended pending administrative review.';

    const rowId = row._id || row.id;
    const updated = await qualificationRepository.suspend(rowId, {
      certifiedBy: currentUserId,
      reason,
    });

    await logAudit({
      userId: currentUserId,
      action: 'QUALIFICATION_SUSPENDED',
      resource: 'OperatorQualification',
      resourceId: rowId,
      details: { targetUserId: String(targetUserId), reason },
      req,
    });

    await notifyUser({
      userId: targetUserId,
      type: 'qualification-suspended',
      title: 'Operator Qualification Suspended',
      message: `Your qualification has been temporarily suspended: ${reason}`,
      entityType: 'qualification',
      entityId: String(rowId),
      dedupKey: `qual-suspend-${rowId}-${Date.now()}`,
    });

    return res.json({ success: true, data: { qualification: updated }, message: 'Qualification suspended.' });
  } catch (err) { return next(err); }
});

/* ============================================================================
   11. POST /:id/revoke — Revoke Qualification (Admin / Faculty)
   ============================================================================ */
router.post('/:id/revoke', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await qualificationRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Qualification not found.' } });

    const currentUserId = req.user._id || req.user.id;
    const targetUserId = row.userId && (row.userId._id || row.userId.id || row.userId);

    const reason = (req.body && typeof req.body.reason === 'string' && req.body.reason.trim())
      ? req.body.reason.trim().slice(0, 500)
      : 'Qualification permanently revoked by laboratory administration.';

    const rowId = row._id || row.id;
    const updated = await qualificationRepository.revoke(rowId, {
      certifiedBy: currentUserId,
      reason,
    });

    await logAudit({
      userId: currentUserId,
      action: 'QUALIFICATION_REVOKED',
      resource: 'OperatorQualification',
      resourceId: rowId,
      details: { targetUserId: String(targetUserId), reason },
      req,
    });

    await notifyUser({
      userId: targetUserId,
      type: 'qualification-revoked',
      title: 'Operator Qualification Revoked',
      message: `Your qualification has been revoked: ${reason}`,
      entityType: 'qualification',
      entityId: String(rowId),
      dedupKey: `qual-revoke-${rowId}-${Date.now()}`,
    });

    return res.json({ success: true, data: { qualification: updated }, message: 'Qualification revoked.' });
  } catch (err) { return next(err); }
});

/* ============================================================================
   12. PATCH /:id — Admin Direct Update
   ============================================================================ */
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const bad = allowOnly(req.body || {}, PATCH_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const row = await qualificationRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Qualification not found.' } });

    const updatePayload = {};
    if (req.body.level !== undefined) {
      if (!Number.isInteger(req.body.level) || req.body.level < 1 || req.body.level > 4) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'level must be an integer 1–4.' } });
      }
      updatePayload.level = req.body.level;
    }
    if (req.body.status !== undefined) {
      if (!QUAL_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      updatePayload.status = req.body.status;
    }
    if (req.body.expiresAt !== undefined) {
      if (req.body.expiresAt === null) {
        updatePayload.expiresAt = null;
      } else {
        const d = new Date(req.body.expiresAt);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'expiresAt must be a valid date.' } });
        }
        updatePayload.expiresAt = d;
      }
    }
    if (req.body.scope !== undefined) {
      updatePayload.scope = typeof req.body.scope === 'string' ? req.body.scope.trim().slice(0, 160) : undefined;
    }
    if (req.body.evidenceUrl !== undefined) {
      updatePayload.evidenceUrl = typeof req.body.evidenceUrl === 'string' ? req.body.evidenceUrl.trim().slice(0, 500) : null;
    }
    if (req.body.evidenceNotes !== undefined) {
      updatePayload.evidenceNotes = typeof req.body.evidenceNotes === 'string' ? req.body.evidenceNotes.trim().slice(0, 1000) : null;
    }

    const rowId = row._id || row.id;
    const updated = await qualificationRepository.updateById(rowId, updatePayload);
    await logAudit({ userId: req.user._id || req.user.id, action: 'QUALIFICATION_UPDATED', resource: 'OperatorQualification', resourceId: rowId, details: {}, req });
    return res.json({ success: true, data: { qualification: updated } });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ============================================================================
   13. DELETE /:id — Admin Hard Delete
   ============================================================================ */
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await qualificationRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Qualification not found.' } });
    const rowId = row._id || row.id;
    await qualificationRepository.deleteById(rowId);
    await logAudit({ userId: req.user._id || req.user.id, action: 'QUALIFICATION_DELETED', resource: 'OperatorQualification', resourceId: rowId, details: {}, req });
    return res.status(204).end();
  } catch (err) { return next(err); }
});

module.exports = router;
