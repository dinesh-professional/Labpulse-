/**
 * Instruments (Phase 05 / Module 06) — spec §7 + §15.
 * GET /instruments(+/:id, /:id/availability) — any authenticated role (students see status, never fee controls).
 * POST/PATCH/DELETE — admin only (status/lockout/fee/qualification management).
 * Booking stays FREE: breakageFee here is confirmed-damage config only (§11), never a usage charge.
 * Backed by instrumentRepository, bookingRepository, calibrationRepository, maintenanceRepository, breakageRepository.
 */
const express = require('express');
const {
  instrumentRepository,
  bookingRepository,
  calibrationRepository,
  maintenanceRepository,
  breakageRepository,
} = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { logAudit } = require('../utils/audit');
const { parseDayUTC, toDayString } = require('../utils/time');
const { findMaintenanceBlock } = require('../utils/bookingGates');
const { isValidId } = require('../utils/idValidation');

const {
  validateLifecycleTransition,
  validateOperationalTransition,
  handleInstrumentUnavailability,
  authorizeReturnToService,
  getInstrumentLifecycleHistory,
  findAffectedBookings,
} = require('../services/instrumentLifecycle');

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

const WRITE_FIELDS = [
  'name', 'category', 'model', 'serialNumber', 'status', 'breakageFee',
  'lastCalibrationDate', 'nextCalibrationDue', 'calibrationFrequencyDays',
  'requiredQualificationLevel', 'laboratoryId',
  'lifecycleState', 'assetTag', 'manufacturer', 'location', 'responsiblePerson',
  'installationDate', 'decommissionedDate', 'operationalRestrictions', 'unavailabilityReason', 'notes',
];
const STATUSES = ['AVAILABLE', 'IN_SESSION', 'UNDER_CALIBRATION', 'UNDER_MAINTENANCE', 'OUT_OF_ORDER', 'LOCKED'];

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}.` : null;
}

function isDup(err) {
  return err && (err.code === 11000 || err.code === '23505' || (err.message && err.message.includes('unique')));
}

const { parsePagination, parseSort, sanitizeSearchTerm } = require('../utils/queryParser');
const { toCsv } = require('../utils/csv');

const ALLOWED_INSTRUMENT_SORTS = {
  name: 'name',
  category: 'category',
  status: 'status',
  lifecycleState: 'lifecycle_state',
  createdAt: 'created_at',
  nextCalibrationDue: 'next_calibration_due',
  updatedAt: 'updated_at',
};

/* ---------------- EXPORT (CSV) ---------------- */
router.get('/export', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.category) filter.category = String(req.query.category).slice(0, 80);
    if (req.query.status && STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (req.query.laboratoryId && isValidId(req.query.laboratoryId)) filter.laboratoryId = req.query.laboratoryId;
    if (req.query.lifecycleState) filter.lifecycleState = String(req.query.lifecycleState).slice(0, 50);

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_INSTRUMENT_SORTS, 'name', 'asc');

    // Bounded export limit
    const rows = await instrumentRepository.list(filter, {
      page: 1,
      limit: 1000,
      sortBy,
      sortOrder,
      role: req.user.role,
    });

    const columns = [
      { key: 'name', label: 'Instrument Name' },
      { key: 'assetTag', label: 'Asset Tag' },
      { key: 'category', label: 'Category' },
      { key: 'model', label: 'Model' },
      { key: 'manufacturer', label: 'Manufacturer' },
      { key: 'serialNumber', label: 'Serial Number' },
      { key: 'status', label: 'Status' },
      { key: 'lifecycleState', label: 'Lifecycle State' },
      { key: 'location', label: 'Location' },
      { key: 'requiredQualificationLevel', label: 'Required Qualification Level' },
      { key: 'nextCalibrationDue', label: 'Next Calibration Due' },
    ];

    if (req.user.role !== 'student') {
      columns.push({ key: 'breakageFee', label: 'Breakage Fee' });
    }

    const csvData = toCsv(rows, columns);

    await logAudit({
      userId: req.user._id || req.user.id,
      actorRole: req.user.role,
      action: 'INSTRUMENTS_EXPORTED',
      resource: 'Instrument',
      status: 'SUCCESS',
      details: { count: rows.length, filter },
      req,
    });

    const filename = `instruments-${new Date().toISOString().slice(0, 10)}.csv`;
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
    if (req.query.category) filter.category = String(req.query.category).slice(0, 80);
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      filter.status = req.query.status;
    }
    if (req.query.laboratoryId) {
      if (!isValidId(req.query.laboratoryId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid laboratoryId.' } });
      }
      filter.laboratoryId = req.query.laboratoryId;
    }
    if (req.query.lifecycleState) {
      filter.lifecycleState = String(req.query.lifecycleState).slice(0, 50);
    }
    if (req.query.requiredQualificationLevel !== undefined) {
      const lvl = parseInt(req.query.requiredQualificationLevel, 10);
      if (!Number.isNaN(lvl)) filter.requiredQualificationLevel = lvl;
    }

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { page, limit } = parsePagination(req.query, 20, 100);
    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_INSTRUMENT_SORTS, 'name', 'asc');

    const [total, rows] = await Promise.all([
      instrumentRepository.count(filter),
      instrumentRepository.list(filter, { page, limit, sortBy, sortOrder, role: req.user.role }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;
    return res.json({
      success: true,
      data: {
        instruments: rows,
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

/* ---------------- AVAILABILITY ---------------- */
router.get('/:id/availability', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const instrument = await instrumentRepository.findById(req.params.id);
    if (!instrument) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instrument not found.' } });
    const from = parseDayUTC(String(req.query.date || ''));
    if (!from) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'date (YYYY-MM-DD) is required.' } });
    }
    const days = Math.min(31, Math.max(1, parseInt(req.query.days || '1', 10) || 1));
    const hardBlock = ['OUT_OF_ORDER', 'LOCKED', 'UNDER_MAINTENANCE', 'UNDER_CALIBRATION'].includes(instrument.status);
    const out = [];
    const instId = instrument.id || instrument._id;

    for (let i = 0; i < days; i += 1) {
      const day = new Date(from.getTime() + i * 86400000);
      const dateStr = toDayString(day);
      const blocks = [];
      if (hardBlock) {
        blocks.push({ type: 'status', reason: instrument.status });
      } else {
        const [cal, maint, clash] = await Promise.all([
          calibrationRepository.findBlockingCalibration(instId, dateStr, '00:00', '23:59'),
          findMaintenanceBlock(instId, dateStr, '00:00', '23:59'),
          bookingRepository.list({ instrumentId: instId }, { limit: 100 }),
        ]);
        if (cal) blocks.push({ type: 'calibration', from: cal.startTime, to: cal.endTime });
        if (maint) blocks.push({ type: 'maintenance', from: maint.startTime || null, to: maint.endTime || null });
        for (const b of (clash || [])) {
          const bDate = toDayString(b.date);
          if (bDate === dateStr && ['CONFIRMED', 'PENDING_APPROVAL', 'CHECKED_IN'].includes(b.status)) {
            blocks.push({ type: 'booking', from: b.startTime, to: b.endTime });
          }
        }
      }
      out.push({ date: dateStr, available: blocks.length === 0, blocks });
    }
    return res.json({ success: true, data: { instrument, days: out } });
  } catch (err) { return next(err); }
});

/* ---------------- DETAIL ---------------- */
router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await instrumentRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instrument not found.' } });
    if (req.user.role === 'student') {
      delete row.breakageFee;
    }
    return res.json({ success: true, data: { instrument: row } });
  } catch (err) { return next(err); }
});

function coerceWrite(body) {
  const v = {};
  for (const f of ['name', 'category', 'model', 'serialNumber']) {
    if (body[f] !== undefined) {
      if (typeof body[f] !== 'string' || !body[f].trim()) return { status: 400, code: 'VALIDATION_ERROR', message: `${f} must be a non-empty string.` };
      v[f] = body[f].trim();
    }
  }
  if (body.laboratoryId !== undefined) {
    v.laboratoryId = body.laboratoryId;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return { status: 400, code: 'VALIDATION_ERROR', message: 'Invalid status.' };
    v.status = body.status;
  }
  if (body.breakageFee !== undefined) {
    if (typeof body.breakageFee !== 'number' || body.breakageFee < 0) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'breakageFee must be a number >= 0.' };
    }
    v.breakageFee = body.breakageFee;
  }
  if (body.requiredQualificationLevel !== undefined) {
    if (!Number.isInteger(body.requiredQualificationLevel) || body.requiredQualificationLevel < 0 || body.requiredQualificationLevel > 4) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'requiredQualificationLevel must be an integer 0–4.' };
    }
    v.requiredQualificationLevel = body.requiredQualificationLevel;
  }
  for (const f of ['lastCalibrationDate', 'nextCalibrationDue']) {
    if (body[f] !== undefined) {
      const d = new Date(body[f]);
      if (Number.isNaN(d.getTime())) return { status: 400, code: 'VALIDATION_ERROR', message: `${f} must be a valid date.` };
      v[f] = d;
    }
  }
  if (body.calibrationFrequencyDays !== undefined) {
    if (typeof body.calibrationFrequencyDays !== 'number' || body.calibrationFrequencyDays < 0 || body.calibrationFrequencyDays > 3650) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'calibrationFrequencyDays must be 0–3650.' };
    }
    v.calibrationFrequencyDays = body.calibrationFrequencyDays;
  }
  if (body.lifecycleState !== undefined) {
    if (!['COMMISSIONED', 'DECOMMISSIONED', 'RETIRED', 'DISPOSED'].includes(body.lifecycleState)) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'Invalid lifecycleState.' };
    }
    v.lifecycleState = body.lifecycleState;
  }
  for (const f of ['assetTag', 'manufacturer', 'location', 'responsiblePerson', 'operationalRestrictions', 'unavailabilityReason', 'notes']) {
    if (body[f] !== undefined) {
      v[f] = typeof body[f] === 'string' ? body[f].trim() : body[f];
    }
  }
  for (const f of ['installationDate', 'decommissionedDate']) {
    if (body[f] !== undefined && body[f] !== null && body[f] !== '') {
      const d = new Date(body[f]);
      if (Number.isNaN(d.getTime())) return { status: 400, code: 'VALIDATION_ERROR', message: `${f} must be a valid date.` };
      v[f] = d;
    }
  }
  return { value: v };
}

/* ---------------- CREATE ---------------- */
router.post('/', adminOnly, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, WRITE_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    if (!req.body.name || !req.body.category || !req.body.serialNumber) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name, category, and serialNumber are required.' } });
    }
    const c = coerceWrite(req.body);
    if (c.status) return res.status(c.status).json({ success: false, error: { code: c.code, message: c.message } });
    const row = await instrumentRepository.create(c.value);
    await logAudit({ userId: req.user._id || req.user.id, action: 'INSTRUMENT_CREATED', resource: 'Instrument', resourceId: row.id || row._id, details: {}, req });
    return res.status(201).json({ success: true, data: { instrument: row } });
  } catch (err) {
    if (isDup(err)) return res.status(409).json({ success: false, error: { code: 'DUPLICATE_SERIAL', message: 'Serial number is already registered.' } });
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- UPDATE (status/lockout/fee/qualification) ---------------- */
router.patch('/:id', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const bad = allowOnly(req.body, WRITE_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const c = coerceWrite(req.body);
    if (c.status) return res.status(c.status).json({ success: false, error: { code: c.code, message: c.message } });
    const row = await instrumentRepository.updateById(req.params.id, c.value);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instrument not found.' } });
    await logAudit({ userId: req.user._id || req.user.id, action: 'INSTRUMENT_UPDATED', resource: 'Instrument', resourceId: row.id || row._id, details: { changed: Object.keys(c.value) }, req });
    return res.json({ success: true, data: { instrument: row } });
  } catch (err) {
    if (isDup(err)) return res.status(409).json({ success: false, error: { code: 'DUPLICATE_SERIAL', message: 'Serial number is already registered.' } });
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- LIFECYCLE HISTORY ---------------- */
router.get('/:id/history', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const history = await getInstrumentLifecycleHistory(req.params.id, { role: req.user.role });
    if (!history) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instrument not found.' } });
    return res.json({ success: true, data: history });
  } catch (err) { return next(err); }
});

/* ---------------- AFFECTED BOOKINGS ---------------- */
router.get('/:id/affected-bookings', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const bookings = await findAffectedBookings(req.params.id);
    return res.json({ success: true, data: { affectedBookings: bookings, count: bookings.length } });
  } catch (err) { return next(err); }
});

/* ---------------- OPERATIONAL STATUS TRANSITION ---------------- */
router.post('/:id/status', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const targetStatus = req.body.status;
    const reason = req.body.reason ? String(req.body.reason).trim() : null;
    if (!targetStatus || !STATUSES.includes(targetStatus)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid status is required.' } });
    }
    const instrument = await instrumentRepository.findById(req.params.id);
    if (!instrument) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instrument not found.' } });

    const check = await validateOperationalTransition(instrument, targetStatus, req.user);
    if (!check.valid) {
      return res.status(check.status || 422).json({ success: false, error: { code: check.code, message: check.message } });
    }

    const instId = instrument.id || instrument._id;
    if (['OUT_OF_ORDER', 'UNDER_MAINTENANCE', 'UNDER_CALIBRATION', 'LOCKED'].includes(targetStatus)) {
      const result = await handleInstrumentUnavailability({
        instrumentId: instId,
        newStatus: targetStatus,
        reason: reason || `Operational status changed to ${targetStatus}`,
        req,
      });
      return res.json({
        success: true,
        data: { instrument: result.instrument, affectedBookings: result.affectedBookings },
        message: `Instrument marked ${targetStatus}. ${result.affectedCount} future booking(s) flagged.`,
      });
    }

    const updated = await instrumentRepository.updateById(instId, {
      status: targetStatus,
      unavailabilityReason: null,
    });
    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'INSTRUMENT_STATUS_CHANGED',
      resource: 'Instrument',
      resourceId: instId,
      details: { fromStatus: instrument.status, toStatus: targetStatus, reason },
      req,
    });
    return res.json({ success: true, data: { instrument: updated }, message: `Instrument status updated to ${targetStatus}.` });
  } catch (err) { return next(err); }
});

/* ---------------- LIFECYCLE TRANSITION ---------------- */
router.post('/:id/lifecycle', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const targetState = req.body.lifecycleState;
    const reason = req.body.reason ? String(req.body.reason).trim() : null;
    const instrument = await instrumentRepository.findById(req.params.id);
    if (!instrument) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instrument not found.' } });

    const currentState = instrument.lifecycleState || 'COMMISSIONED';
    const check = validateLifecycleTransition(currentState, targetState, req.user);
    if (!check.valid) {
      return res.status(check.status || 422).json({ success: false, error: { code: check.code, message: check.message } });
    }

    const instId = instrument.id || instrument._id;
    const updatePayload = { lifecycleState: targetState };
    if (['DECOMMISSIONED', 'RETIRED', 'DISPOSED'].includes(targetState)) {
      updatePayload.decommissionedDate = req.body.decommissionedDate ? new Date(req.body.decommissionedDate) : new Date();
      updatePayload.status = 'LOCKED';
      updatePayload.unavailabilityReason = `Lifecycle changed to ${targetState}: ${reason || 'Asset deactivated'}`;
    } else if (targetState === 'COMMISSIONED') {
      updatePayload.decommissionedDate = null;
      updatePayload.unavailabilityReason = null;
    }

    const updated = await instrumentRepository.updateById(instId, updatePayload);

    let affectedCount = 0;
    if (['DECOMMISSIONED', 'RETIRED', 'DISPOSED'].includes(targetState)) {
      const result = await handleInstrumentUnavailability({
        instrumentId: instId,
        newStatus: 'LOCKED',
        reason: `Lifecycle changed to ${targetState}`,
        req,
      });
      affectedCount = result ? result.affectedCount : 0;
    }

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'INSTRUMENT_LIFECYCLE_CHANGED',
      resource: 'Instrument',
      resourceId: instId,
      details: { fromState: currentState, toState: targetState, reason, affectedCount },
      req,
    });

    return res.json({
      success: true,
      data: { instrument: updated },
      message: `Instrument lifecycle updated to ${targetState}.${affectedCount > 0 ? ` ${affectedCount} future booking(s) flagged.` : ''}`,
    });
  } catch (err) { return next(err); }
});

/* ---------------- AUTHORIZE RETURN TO SERVICE ---------------- */
router.post('/:id/return-to-service', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const result = await authorizeReturnToService({
      instrumentId: req.params.id,
      adminUser: req.user,
      resolutionNotes: req.body.notes,
      req,
    });
    if (!result.success) {
      return res.status(result.status || 422).json({ success: false, error: { code: result.code, message: result.message } });
    }
    return res.json({ success: true, data: { instrument: result.instrument }, message: 'Instrument successfully returned to active service.' });
  } catch (err) { return next(err); }
});

/* ---------------- DELETE (blocked by live or historical dependencies) ---------------- */
router.delete('/:id', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await instrumentRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Instrument not found.' } });
    const instId = row.id || row._id;
    const [bookingsCount, calCount, maintCount, breakCount] = await Promise.all([
      bookingRepository.count({ instrumentId: instId }),
      calibrationRepository.count({ instrumentId: instId }),
      maintenanceRepository.count({ instrumentId: instId }),
      breakageRepository.count({ instrumentId: instId }),
    ]);
    if (bookingsCount + calCount + maintCount + breakCount > 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'INSTRUMENT_IN_USE',
          message: 'Instrument has historical bookings, calibrations, maintenance, or incident records and cannot be permanently deleted. Transition to RETIRED or DECOMMISSIONED lifecycle state instead.',
        },
      });
    }
    await instrumentRepository.deleteById(instId);
    await logAudit({ userId: req.user._id || req.user.id, action: 'INSTRUMENT_DELETED', resource: 'Instrument', resourceId: instId, details: {}, req });
    return res.status(204).end();
  } catch (err) { return next(err); }
});

module.exports = router;
