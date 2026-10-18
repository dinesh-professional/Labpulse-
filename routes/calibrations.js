/**
 * Calibration scheduling (Phase 06 / Module 06) — spec §9 + §15.
 * GET /calibrations(+/:id) — any authenticated role.
 * POST/PATCH — admin only (faculty/students never manage calibration).
 * Backed by calibrationRepository, instrumentRepository, userRepository, bookingRepository, maintenanceRepository.
 */
const express = require('express');
const {
  calibrationRepository,
  instrumentRepository,
  userRepository,
  bookingRepository,
  maintenanceRepository,
} = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { logAudit } = require('../utils/audit');
const { notifyUser } = require('../services/notify');
const { isHHMM, toMinutes, parseDayUTC, dayRangeUTC, isPastDay, toDayString } = require('../utils/time');
const { findMaintenanceBlock, findBookingConflict } = require('../utils/bookingGates');
const { restoreInstrument } = require('../utils/restore');
const { acquireLock } = require('../utils/mutex');
const { isValidId } = require('../utils/idValidation');
const { handleInstrumentUnavailability } = require('../services/instrumentLifecycle');
const { parsePagination, parseSort, sanitizeSearchTerm, parseDateRange } = require('../utils/queryParser');
const { toCsv } = require('../utils/csv');

const router = express.Router();

const ALLOWED_CALIBRATION_SORTS = {
  date: { dbField: 'date', mongoField: 'date' },
  startTime: { dbField: 'start_time', mongoField: 'startTime' },
  status: { dbField: 'status', mongoField: 'status' },
  result: { dbField: 'result', mongoField: 'result' },
  createdAt: { dbField: 'created_at', mongoField: 'createdAt' },
};

function requireDB(req, res, next) {
  if (getActiveDataBackend() === 'supabase') return next();
  if (dbState() !== 1) {
    return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
  }
  return next();
}
router.use(requireDB, requireAuth);

const adminOnly = requireRole('admin');

const CREATE_FIELDS = ['instrumentId', 'calibrationType', 'date', 'startTime', 'endTime', 'technicianId', 'standard', 'notes'];
const PATCH_FIELDS = [
  'calibrationType', 'date', 'startTime', 'endTime', 'technicianId', 'standard',
  'status', 'result', 'performedDate', 'referenceStandard', 'certificateNumber',
  'drift', 'tolerance', 'certificateUrl', 'notes',
];

const TRANSITIONS = {
  CALIBRATION_SCHEDULED: ['UNDER_CALIBRATION'],
  UNDER_CALIBRATION: ['CALIBRATED', 'CERTIFICATE_PENDING'],
  CERTIFICATE_PENDING: ['CALIBRATED'],
  CALIBRATION_DUE: ['CALIBRATION_SCHEDULED', 'UNDER_CALIBRATION', 'CALIBRATED'],
  CALIBRATION_OVERDUE: ['CALIBRATION_SCHEDULED', 'UNDER_CALIBRATION', 'CALIBRATED'],
  CALIBRATED: [],
};

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}.` : null;
}

function normalizeWindow(body) {
  if (!isValidId(body.instrumentId)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'instrumentId must be a valid id.' };
  }
  if (typeof body.calibrationType !== 'string' || !body.calibrationType.trim()) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'calibrationType is required.' };
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
  return { value: { dateStr, date: day, startTime: body.startTime, endTime: body.endTime } };
}

async function findCalibrationClash(instrumentId, dateStr, startTime, endTime, excludeId) {
  return calibrationRepository.findBlockingCalibration(instrumentId, dateStr, startTime, endTime);
}

async function resolveTechnician(technicianId) {
  if (technicianId === undefined || technicianId === null || technicianId === '') return { value: undefined };
  if (!isValidId(technicianId)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'technicianId must be a valid id.' };
  }
  const tech = await userRepository.findById(technicianId);
  if (!tech) return { status: 404, code: 'TECHNICIAN_NOT_FOUND', message: 'Technician not found.' };
  return { value: tech._id || tech.id };
}

async function notifyTechnician(techId, record, instrument, kind, req) {
  if (!techId) return { emailSent: false, emailAttempts: 0 };
  try {
    const tech = await userRepository.findById(techId);
    if (!tech) return { emailSent: false, emailAttempts: 0 };
    const recordId = record._id || record.id;
    const data = {
      instrument: instrument.name, calibrationType: record.calibrationType,
      date: toDayString(record.date), startTime: record.startTime, endTime: record.endTime,
      status: record.status, referenceId: String(recordId),
    };
    return notifyUser({
      userId: tech._id || tech.id,
      type: `calibration-${kind}`,
      title: `LabPulse calibration ${kind}`,
      message: `${data.instrument} ${data.calibrationType} on ${data.date} ${data.startTime}–${data.endTime} [${data.referenceId}]`,
      email: { to: tech.email, subject: `LabPulse calibration ${kind}`, template: `calibration-${kind}`, data },
    });
  } catch (err) {
    console.warn('[notify] calibration notification failed:', err.message);
    return { emailSent: false, emailAttempts: 0 };
  }
}

/* ---------------- EXPORT ---------------- */
router.get('/export', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.instrumentId && isValidId(req.query.instrumentId)) filter.instrumentId = req.query.instrumentId;
    if (req.query.status && Object.keys(TRANSITIONS).includes(req.query.status)) filter.status = req.query.status;
    if (req.query.result && ['PASSED', 'FAILED', 'PENDING'].includes(req.query.result)) filter.result = req.query.result;

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { startDate, endDate } = parseDateRange(req.query);
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_CALIBRATION_SORTS, 'date', 'desc');

    const rows = await calibrationRepository.list(filter, {
      page: 1,
      limit: 1000,
      sortBy,
      sortOrder,
    });

    const columns = [
      { key: '_id', label: 'ID' },
      { key: 'instrumentId', label: 'Instrument ID' },
      { key: 'calibrationType', label: 'Calibration Type' },
      { key: 'status', label: 'Status' },
      { key: 'result', label: 'Result' },
      { key: 'date', label: 'Date' },
      { key: 'startTime', label: 'Start Time' },
      { key: 'endTime', label: 'End Time' },
      { key: 'standard', label: 'Standard' },
      { key: 'technicianId', label: 'Technician ID' },
      { key: 'performedDate', label: 'Performed Date' },
      { key: 'referenceStandard', label: 'Reference Standard' },
      { key: 'certificateNumber', label: 'Certificate Number' },
      { key: 'drift', label: 'Drift' },
      { key: 'tolerance', label: 'Tolerance' },
      { key: 'createdAt', label: 'Created At' },
    ];

    const csvData = toCsv(rows, columns);

    await logAudit({
      userId: req.user._id || req.user.id,
      actorRole: req.user.role,
      action: 'CALIBRATIONS_EXPORTED',
      resource: 'Calibration',
      status: 'SUCCESS',
      details: { count: rows.length, filter },
      req,
    });

    const filename = `calibrations-${new Date().toISOString().slice(0, 10)}.csv`;
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
    if (req.query.instrumentId) {
      if (!isValidId(req.query.instrumentId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid instrumentId.' } });
      }
      filter.instrumentId = req.query.instrumentId;
    }
    if (req.query.status) {
      if (!Object.keys(TRANSITIONS).includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      filter.status = req.query.status;
    }
    if (req.query.result) {
      if (!['PASSED', 'FAILED', 'PENDING'].includes(req.query.result)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid result.' } });
      }
      filter.result = req.query.result;
    }
    if (req.query.date) {
      const range = dayRangeUTC(String(req.query.date));
      if (!range) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'date must be YYYY-MM-DD.' } });
      filter.date = req.query.date;
    }

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { startDate, endDate } = parseDateRange(req.query);
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    const { page, limit } = parsePagination(req.query, 20, 100);
    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_CALIBRATION_SORTS, 'date', 'desc');

    const [total, rows] = await Promise.all([
      calibrationRepository.count(filter),
      calibrationRepository.list(filter, { page, limit, sortBy, sortOrder }),
    ]);
    const totalPages = Math.ceil(total / limit) || 1;
    return res.json({
      success: true,
      data: {
        calibrations: rows,
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

/* ---------------- UPCOMING CALIBRATIONS ---------------- */
router.get('/upcoming', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days || '30', 10) || 30));
    const todayStr = toDayString(new Date());
    const limitDate = new Date(Date.now() + days * 86400000);
    const limitStr = toDayString(limitDate);

    const rows = await calibrationRepository.list({}, { limit: 100 });
    const upcoming = rows.filter((c) => {
      const dStr = toDayString(c.date);
      return dStr >= todayStr && dStr <= limitStr && ['CALIBRATION_SCHEDULED', 'CALIBRATION_DUE'].includes(c.status);
    });
    return res.json({ success: true, data: { upcoming, count: upcoming.length, days } });
  } catch (err) { return next(err); }
});

/* ---------------- OVERDUE CALIBRATIONS ---------------- */
router.get('/overdue', async (req, res, next) => {
  try {
    const todayStr = toDayString(new Date());
    const allInstruments = await instrumentRepository.list({}, { limit: 200, role: 'admin' });
    const overdueInstruments = allInstruments.filter((inst) => {
      if (!inst.nextCalibrationDue) return false;
      return toDayString(inst.nextCalibrationDue) < todayStr;
    });

    const calRows = await calibrationRepository.list({ status: 'CALIBRATION_OVERDUE' }, { limit: 100 });
    return res.json({
      success: true,
      data: {
        overdueInstruments,
        overdueRecords: calRows,
        totalOverdue: overdueInstruments.length,
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
    const row = await calibrationRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration not found.' } });
    return res.json({ success: true, data: { calibration: row } });
  } catch (err) { return next(err); }
});

/* ---------------- SCHEDULE ---------------- */
router.post('/', adminOnly, async (req, res, next) => {
  let releaseCreateLock;
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'JSON body is required.' } });
    }
    const bad = allowOnly(req.body, CREATE_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const norm = normalizeWindow(req.body);
    if (norm.status) return res.status(norm.status).json({ success: false, error: { code: norm.code, message: norm.message } });

    const instrument = await instrumentRepository.findById(req.body.instrumentId);
    if (!instrument) return res.status(404).json({ success: false, error: { code: 'INSTRUMENT_NOT_FOUND', message: 'Instrument not found.' } });
    if (instrument.status === 'LOCKED') {
      return res.status(422).json({ success: false, error: { code: 'INSTRUMENT_LOCKED', message: 'Instrument is locked out.' } });
    }

    releaseCreateLock = await acquireLock(`instrument-day:${req.body.instrumentId}:${norm.value.dateStr}`);
    const tech = await resolveTechnician(req.body.technicianId);
    if (tech.status) return res.status(tech.status).json({ success: false, error: { code: tech.code, message: tech.message } });

    if (await findCalibrationClash(req.body.instrumentId, norm.value.dateStr, norm.value.startTime, norm.value.endTime, null)) {
      return res.status(409).json({ success: false, error: { code: 'CALIBRATION_CONFLICT', message: 'Another calibration already occupies this window.' } });
    }
    if (await findBookingConflict(req.body.instrumentId, norm.value.dateStr, norm.value.startTime, norm.value.endTime, null)) {
      return res.status(409).json({ success: false, error: { code: 'BOOKING_CONFLICT', message: 'A booking already occupies this window.' } });
    }
    if (await findMaintenanceBlock(req.body.instrumentId, norm.value.dateStr, norm.value.startTime, norm.value.endTime)) {
      return res.status(409).json({ success: false, error: { code: 'MAINTENANCE_CONFLICT', message: 'Maintenance already occupies this window.' } });
    }

    const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : undefined);
    const record = await calibrationRepository.create({
      instrumentId: req.body.instrumentId,
      calibrationType: req.body.calibrationType.trim().slice(0, 120),
      date: norm.value.date,
      startTime: norm.value.startTime,
      endTime: norm.value.endTime,
      technicianId: tech.value,
      standard: str(req.body.standard, 160),
      notes: str(req.body.notes, 2000),
      status: 'CALIBRATION_SCHEDULED',
    });

    const recordId = record._id || record.id;
    await notifyTechnician(tech.value, record, instrument, 'scheduled', req);
    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'CALIBRATION_CREATED',
      resource: 'Calibration',
      resourceId: recordId,
      details: { instrumentId: String(record.instrumentId) },
      req,
    });
    const row = await calibrationRepository.findById(recordId);
    return res.status(201).json({ success: true, data: { calibration: row }, message: 'Calibration scheduled.' });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  } finally {
    if (releaseCreateLock) releaseCreateLock();
  }
});

/* ---------------- UPDATE / TRANSITION / COMPLETE ---------------- */
router.patch('/:id', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const bad = allowOnly(req.body, PATCH_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const record = await calibrationRepository.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration not found.' } });

    const started = !['CALIBRATION_SCHEDULED', 'CALIBRATION_DUE', 'CALIBRATION_OVERDUE'].includes(record.status);
    const windowTouched = req.body.date !== undefined || req.body.startTime !== undefined || req.body.endTime !== undefined;
    if (started && windowTouched) {
      return res.status(422).json({ success: false, error: { code: 'EDIT_LOCKED', message: 'Date/time cannot change once calibration has started.' } });
    }
    let nextStatus = record.status;
    if (req.body.status !== undefined) {
      if (!Object.keys(TRANSITIONS).includes(req.body.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      if (req.body.status !== record.status && !TRANSITIONS[record.status].includes(req.body.status)) {
        return res.status(422).json({ success: false, error: { code: 'INVALID_STATUS_TRANSITION', message: `Cannot move ${record.status} to ${req.body.status}.` } });
      }
      nextStatus = req.body.status;
    }

    const recordId = record._id || record.id;
    const updatePayload = {};

    if (!started && windowTouched) {
      const merged = { instrumentId: String(record.instrumentId), date: toDayString(record.date), startTime: record.startTime, endTime: record.endTime, calibrationType: record.calibrationType, ...req.body };
      const norm = normalizeWindow(merged);
      if (norm.status) return res.status(norm.status).json({ success: false, error: { code: norm.code, message: norm.message } });

      const releaseRescheduleLock = await acquireLock(`instrument-day:${record.instrumentId}:${norm.value.dateStr}`);
      try {
        if (await findCalibrationClash(record.instrumentId, norm.value.dateStr, norm.value.startTime, norm.value.endTime, recordId)) {
          return res.status(409).json({ success: false, error: { code: 'CALIBRATION_CONFLICT', message: 'Another calibration already occupies this window.' } });
        }
        if (await findBookingConflict(record.instrumentId, norm.value.dateStr, norm.value.startTime, norm.value.endTime, null)) {
          return res.status(409).json({ success: false, error: { code: 'BOOKING_CONFLICT', message: 'A booking already occupies this window.' } });
        }
        if (await findMaintenanceBlock(record.instrumentId, norm.value.dateStr, norm.value.startTime, norm.value.endTime)) {
          return res.status(409).json({ success: false, error: { code: 'MAINTENANCE_CONFLICT', message: 'Maintenance already occupies this window.' } });
        }
        updatePayload.date = norm.value.date;
        updatePayload.startTime = norm.value.startTime;
        updatePayload.endTime = norm.value.endTime;
      } finally {
        releaseRescheduleLock();
      }
    }

    const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : undefined);
    if (req.body.calibrationType !== undefined) {
      if (typeof req.body.calibrationType !== 'string' || !req.body.calibrationType.trim()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'calibrationType must be a non-empty string.' } });
      }
      updatePayload.calibrationType = req.body.calibrationType.trim().slice(0, 120);
    }
    if (req.body.technicianId !== undefined) {
      const tech = await resolveTechnician(req.body.technicianId);
      if (tech.status) return res.status(tech.status).json({ success: false, error: { code: tech.code, message: tech.message } });
      updatePayload.technicianId = tech.value;
    }
    for (const f of ['standard', 'drift', 'tolerance', 'certificateUrl', 'notes']) {
      if (req.body[f] !== undefined) updatePayload[f] = str(req.body[f], f === 'notes' ? 2000 : f === 'certificateUrl' ? 500 : 160);
    }

    const instrument = await instrumentRepository.findById(record.instrumentId);
    const instId = instrument ? (instrument.id || instrument._id) : null;
    updatePayload.status = nextStatus;

    if (nextStatus === 'UNDER_CALIBRATION' && instrument && instrument.status !== 'LOCKED') {
      await instrumentRepository.updateStatus(instId, 'UNDER_CALIBRATION');
    }

    if (nextStatus === 'CALIBRATED') {
      const completedAt = record.date;
      if (instrument) {
        const instUpdate = { lastCalibrationDate: completedAt };
        if (instrument.calibrationFrequencyDays) {
          instUpdate.nextCalibrationDue = new Date(new Date(completedAt).getTime() + instrument.calibrationFrequencyDays * 86400000);
        }
        await instrumentRepository.updateById(instId, instUpdate);
      }
      await restoreInstrument(record.instrumentId, 'UNDER_CALIBRATION', recordId);
    }

    await calibrationRepository.updateById(recordId, updatePayload);

    if (req.body.status !== undefined) {
      await notifyTechnician(record.technicianId, record, instrument || { name: 'instrument' },
        nextStatus === 'CALIBRATED' ? 'completed' : 'updated', req);
      await logAudit({
        userId: req.user._id || req.user.id,
        action: nextStatus === 'CALIBRATED' ? 'CALIBRATION_COMPLETED' : 'CALIBRATION_UPDATED',
        resource: 'Calibration', resourceId: recordId, details: { status: nextStatus }, req,
      });
    } else {
      await logAudit({ userId: req.user._id || req.user.id, action: 'CALIBRATION_UPDATED', resource: 'Calibration', resourceId: recordId, details: {}, req });
    }

    const row = await calibrationRepository.findById(recordId);
    return res.json({ success: true, data: { calibration: row } });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- COMPLETE / RECORD OUTCOME ---------------- */
router.post('/:id/complete', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const record = await calibrationRepository.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Calibration not found.' } });

    // Authorization: Admin or the assigned technician
    const currentUserId = req.user._id || req.user.id;
    const isAssignedTech = record.technicianId && String(record.technicianId) === String(currentUserId);
    if (req.user.role !== 'admin' && !isAssignedTech) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only administrators or the assigned technician can complete a calibration.' } });
    }

    const { result, certificateUrl, certificateNumber, referenceStandard, drift, tolerance, notes } = req.body || {};
    if (!['PASSED', 'FAILED'].includes(result)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'result must be PASSED or FAILED.' } });
    }

    const recordId = record._id || record.id;
    const instrument = await instrumentRepository.findById(record.instrumentId);
    const instId = instrument ? (instrument.id || instrument._id) : null;
    const completedAt = new Date();

    if (result === 'PASSED') {
      const updatePayload = {
        status: 'CALIBRATED',
        result: 'PASSED',
        performedDate: completedAt,
        ...(certificateUrl ? { certificateUrl: String(certificateUrl).slice(0, 500) } : {}),
        ...(certificateNumber ? { certificateNumber: String(certificateNumber).slice(0, 120) } : {}),
        ...(referenceStandard ? { referenceStandard: String(referenceStandard).slice(0, 160) } : {}),
        ...(drift ? { drift: String(drift).slice(0, 120) } : {}),
        ...(tolerance ? { tolerance: String(tolerance).slice(0, 120) } : {}),
        ...(notes ? { notes: String(notes).slice(0, 2000) } : {}),
      };

      await calibrationRepository.updateById(recordId, updatePayload);

      if (instrument) {
        const instUpdate = { lastCalibrationDate: completedAt };
        const freqDays = instrument.calibrationFrequencyDays || 365;
        instUpdate.nextCalibrationDue = new Date(completedAt.getTime() + freqDays * 86400000);
        await instrumentRepository.updateById(instId, instUpdate);
      }

      await restoreInstrument(record.instrumentId, 'UNDER_CALIBRATION', recordId);

      await logAudit({
        userId: currentUserId,
        action: 'CALIBRATION_COMPLETED',
        resource: 'Calibration',
        resourceId: recordId,
        details: { result: 'PASSED', certificateNumber },
        req,
      });

      const updatedRecord = await calibrationRepository.findById(recordId);
      return res.json({ success: true, data: { calibration: updatedRecord }, message: 'Calibration marked PASSED and instrument certified.' });
    }

    // result === 'FAILED'
    const failPayload = {
      status: 'CALIBRATION_OVERDUE',
      result: 'FAILED',
      performedDate: completedAt,
      ...(drift ? { drift: String(drift).slice(0, 120) } : {}),
      ...(tolerance ? { tolerance: String(tolerance).slice(0, 120) } : {}),
      ...(notes ? { notes: String(notes).slice(0, 2000) } : {}),
    };
    await calibrationRepository.updateById(recordId, failPayload);

    // Flip instrument to OUT_OF_ORDER and flag future bookings
    if (instId) {
      await handleInstrumentUnavailability({
        instrumentId: instId,
        newStatus: 'OUT_OF_ORDER',
        reason: 'Calibration failed: instrument out of tolerance. Metrology restriction applied.',
        req,
      });
    }

    await logAudit({
      userId: currentUserId,
      action: 'CALIBRATION_FAILED',
      resource: 'Calibration',
      resourceId: recordId,
      details: { result: 'FAILED', drift, tolerance },
      req,
    });

    const updatedRecord = await calibrationRepository.findById(recordId);
    return res.json({
      success: true,
      data: { calibration: updatedRecord },
      message: 'Calibration marked FAILED. Instrument placed out of order and bookings flagged.',
    });
  } catch (err) { return next(err); }
});

module.exports = router;
