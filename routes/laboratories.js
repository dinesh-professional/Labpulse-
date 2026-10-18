/**
 * Laboratories (Phase 12 / Module 06) — spec §3 + §15.
 * GET /laboratories(+/:id) — any authenticated role (faculty/student browse + filter).
 * POST/PATCH/DELETE — admin only. DELETE refused while active schedules reference the lab.
 * Backed by laboratoryRepository and scheduleRepository.
 */
const express = require('express');
const { laboratoryRepository, scheduleRepository } = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { logAudit } = require('../utils/audit');
const { isValidId } = require('../utils/idValidation');

const router = express.Router();

function requireDB(req, res, next) {
  if (getActiveDataBackend() === 'supabase') return next();
  if (dbState() !== 1) {
    return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
  }
  return next();
}
router.use(requireDB, requireAuth);

const adminOnly = requireRole('admin');
const STATUSES = ['AVAILABLE', 'UNAVAILABLE', 'UNDER_MAINTENANCE', 'CLOSED'];
const WRITE_FIELDS = ['name', 'department', 'building', 'roomNumber', 'capacity', 'status'];

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}.` : null;
}

function coerceWrite(body) {
  const v = {};
  for (const f of ['name', 'department', 'building', 'roomNumber']) {
    if (body[f] !== undefined) {
      if (typeof body[f] !== 'string' || !body[f].trim()) return { status: 400, code: 'VALIDATION_ERROR', message: `${f} must be a non-empty string.` };
      v[f] = body[f].trim().slice(0, f === 'name' ? 160 : 120);
    }
  }
  if (body.capacity !== undefined) {
    if (typeof body.capacity !== 'number' || body.capacity < 0 || body.capacity > 10000) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'capacity must be a number 0–10000.' };
    }
    v.capacity = body.capacity;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return { status: 400, code: 'VALIDATION_ERROR', message: 'Invalid status.' };
    v.status = body.status;
  }
  return { value: v };
}

router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      filter.status = req.query.status;
    }
    if (req.query.department) filter.department = String(req.query.department).slice(0, 120);
    if (req.query.q) filter.q = String(req.query.q).slice(0, 80);

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
    const [total, rows] = await Promise.all([
      laboratoryRepository.count(filter),
      laboratoryRepository.list(filter, { page, limit }),
    ]);
    return res.json({ success: true, data: { laboratories: rows, page, limit, total } });
  } catch (err) { return next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await laboratoryRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Laboratory not found.' } });
    return res.json({ success: true, data: { laboratory: row } });
  } catch (err) { return next(err); }
});

router.post('/', adminOnly, async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'JSON body is required.' } });
    }
    const bad = allowOnly(req.body, WRITE_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    if (!req.body.name) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name is required.' } });
    }
    const c = coerceWrite(req.body);
    if (c.status) return res.status(c.status).json({ success: false, error: { code: c.code, message: c.message } });
    const row = await laboratoryRepository.create(c.value);
    await logAudit({ userId: req.user._id || req.user.id, action: 'LAB_CREATED', resource: 'Laboratory', resourceId: row.id || row._id, details: {}, req });
    return res.status(201).json({ success: true, data: { laboratory: row } });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

router.patch('/:id', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const bad = allowOnly(req.body || {}, WRITE_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const c = coerceWrite(req.body || {});
    if (c.status) return res.status(c.status).json({ success: false, error: { code: c.code, message: c.message } });
    const row = await laboratoryRepository.updateById(req.params.id, c.value);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Laboratory not found.' } });
    await logAudit({ userId: req.user._id || req.user.id, action: 'LAB_UPDATED', resource: 'Laboratory', resourceId: row.id || row._id, details: { changed: Object.keys(c.value) }, req });
    return res.json({ success: true, data: { laboratory: row } });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

router.delete('/:id', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await laboratoryRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Laboratory not found.' } });
    const labId = row.id || row._id;
    const live = await scheduleRepository.count({ laboratoryId: labId });
    if (live > 0) {
      return res.status(409).json({ success: false, error: { code: 'LAB_IN_USE', message: 'Laboratory has live schedules and cannot be deleted.' } });
    }
    await laboratoryRepository.deleteById(labId);
    await logAudit({ userId: req.user._id || req.user.id, action: 'LAB_DELETED', resource: 'Laboratory', resourceId: labId, details: {}, req });
    return res.status(204).end();
  } catch (err) { return next(err); }
});

module.exports = router;
