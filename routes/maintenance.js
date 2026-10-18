/**
 * Maintenance (Phase 07 / Module 06) — spec §10 + §15.
 * GET /maintenance(+/:id) — any authenticated role.
 * POST/PATCH — admin only. Types: preventive | corrective.
 * Backed by maintenanceRepository, instrumentRepository, calibrationRepository, bookingRepository, userRepository.
 */
const express = require('express');
const {
  maintenanceRepository,
  instrumentRepository,
  calibrationRepository,
  bookingRepository,
  userRepository,
} = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { logAudit } = require('../utils/audit');
const { notifyUser } = require('../services/notify');
const { isHHMM, toMinutes, parseDayUTC, isPastDay, toDayString } = require('../utils/time');
const { findMaintenanceBlock, findBookingConflict } = require('../utils/bookingGates');
const { restoreInstrument } = require('../utils/restore');
const { acquireLock } = require('../utils/mutex');
const { isValidId } = require('../utils/idValidation');
const { handleInstrumentUnavailability } = require('../services/instrumentLifecycle');
const { parsePagination, parseSort, sanitizeSearchTerm, parseDateRange } = require('../utils/queryParser');
const { toCsv } = require('../utils/csv');

const router = express.Router();

const ALLOWED_MAINTENANCE_SORTS = {
  startDate: { dbField: 'start_date', mongoField: 'startDate' },
  scheduledStart: { dbField: 'start_date', mongoField: 'startDate' },
  status: { dbField: 'status', mongoField: 'status' },
  type: { dbField: 'type', mongoField: 'type' },
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

const CREATE_FIELDS = ['instrumentId', 'type', 'description', 'startDate', 'endDate', 'startTime', 'endTime', 'technicianId', 'requiresCalibration'];
const PATCH_FIELDS = [
  'type', 'description', 'startDate', 'endDate', 'startTime', 'endTime',
  'technicianId', 'requiresCalibration', 'status',
  'workPerformed', 'partsReplaced', 'resolutionNotes',
];

const TRANSITIONS = {
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}.` : null;
}

function normalizeWindow(body) {
  if (!isValidId(body.instrumentId)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'instrumentId must be a valid id.' };
  }
  if (!['preventive', 'corrective'].includes(body.type)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'type must be preventive or corrective.' };
  }
  if (typeof body.description !== 'string' || !body.description.trim()) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'description is required.' };
  }
  const startStr = String(body.startDate || '').trim();
  const start = parseDayUTC(startStr);
  if (!start) return { status: 422, code: 'INVALID_DATE', message: 'startDate must be YYYY-MM-DD.' };
  if (isPastDay(startStr)) return { status: 422, code: 'INVALID_DATE', message: 'startDate cannot be in the past.' };
  let endStr = startStr;
  let end = start;
  if (body.endDate !== undefined && body.endDate !== null && body.endDate !== '') {
    endStr = String(body.endDate).trim();
    end = parseDayUTC(endStr);
    if (!end) return { status: 422, code: 'INVALID_DATE', message: 'endDate must be YYYY-MM-DD.' };
    if (end < start) return { status: 422, code: 'INVALID_DATE', message: 'endDate cannot precede startDate.' };
    if ((end - start) / 86400000 > 365) {
      return { status: 422, code: 'INVALID_DATE', message: 'maintenance window cannot exceed 365 days.' };
    }
  }
  let startTime;
  let endTime;
  if (body.startTime !== undefined || body.endTime !== undefined) {
    if (!isHHMM(body.startTime) || !isHHMM(body.endTime)) {
      return { status: 422, code: 'INVALID_TIME_RANGE', message: 'startTime/endTime must both be HH:mm.' };
    }
    if (toMinutes(body.endTime) <= toMinutes(body.startTime)) {
      return { status: 422, code: 'INVALID_TIME_RANGE', message: 'endTime must be after startTime.' };
    }
    startTime = body.startTime;
    endTime = body.endTime;
  }
  return { value: { startStr, start, endStr, end, startTime, endTime } };
}

function eachDay(startStr, endStr) {
  const days = [];
  let cur = parseDayUTC(startStr);
  const last = parseDayUTC(endStr);
  while (cur && last && cur <= last && days.length <= 366) {
    days.push(toDayString(cur));
    cur = new Date(cur.getTime() + 86400000);
  }
  return days;
}

async function maintenanceClashes(instrumentId, win, excludeId) {
  const singleDayTimed = win.startStr === win.endStr && win.startTime && win.endTime;
  for (const day of eachDay(win.startStr, win.endStr)) {
    const from = singleDayTimed ? win.startTime : '00:00';
    const to = singleDayTimed ? win.endTime : '23:59';
    if (await findMaintenanceBlock(instrumentId, day, from, to, excludeId)) return { type: 'MAINTENANCE_CONFLICT' };
    const calClash = await calibrationRepository.findBlockingCalibration(instrumentId, day, from, to);
    if (calClash) return { type: 'CALIBRATION_CONFLICT' };
    if (await findBookingConflict(instrumentId, day, from, to, null)) return { type: 'BOOKING_CONFLICT' };
  }
  return null;
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

async function notifyTechnician(techId, record, instrument, kind) {
  if (!techId) return { emailSent: false, emailAttempts: 0 };
  try {
    const tech = await userRepository.findById(techId);
    if (!tech) return { emailSent: false, emailAttempts: 0 };
    const recordId = record._id || record.id;
    const data = {
      instrument: instrument.name, type: record.type,
      startDate: toDayString(record.startDate),
      endDate: record.endDate ? toDayString(record.endDate) : toDayString(record.startDate),
      status: record.status, referenceId: String(recordId),
    };
    return notifyUser({
      userId: tech._id || tech.id,
      type: `maintenance-${kind}`,
      title: `LabPulse maintenance ${kind}`,
      message: `${data.instrument} ${data.type} ${data.startDate}–${data.endDate} [${data.referenceId}]`,
      email: { to: tech.email, subject: `LabPulse maintenance ${kind}`, template: `maintenance-${kind}`, data },
    });
  } catch (err) {
    console.warn('[notify] maintenance notification failed:', err.message);
    return { emailSent: false, emailAttempts: 0 };
  }
}

/* ---------------- EXPORT ---------------- */
router.get('/export', requireRole('admin', 'faculty'), async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.instrumentId && isValidId(req.query.instrumentId)) filter.instrumentId = req.query.instrumentId;
    if (req.query.status && Object.keys(TRANSITIONS).includes(req.query.status)) filter.status = req.query.status;
    if (req.query.type && ['preventive', 'corrective'].includes(req.query.type)) filter.type = req.query.type;

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { startDate, endDate } = parseDateRange(req.query);
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_MAINTENANCE_SORTS, 'startDate', 'desc');

    const rows = await maintenanceRepository.list(filter, {
      page: 1,
      limit: 1000,
      sortBy,
      sortOrder,
    });

    const columns = [
      { key: '_id', label: 'ID' },
      { key: 'instrumentId', label: 'Instrument ID' },
      { key: 'type', label: 'Type' },
      { key: 'status', label: 'Status' },
      { key: 'startDate', label: 'Start Date' },
      { key: 'endDate', label: 'End Date' },
      { key: 'startTime', label: 'Start Time' },
      { key: 'endTime', label: 'End Time' },
      { key: 'technicianId', label: 'Technician ID' },
      { key: 'description', label: 'Description' },
      { key: 'requiresCalibration', label: 'Requires Calibration' },
      { key: 'workPerformed', label: 'Work Performed' },
      { key: 'partsReplaced', label: 'Parts Replaced' },
      { key: 'createdAt', label: 'Created At' },
    ];

    const csvData = toCsv(rows, columns);

    await logAudit({
      userId: req.user._id || req.user.id,
      actorRole: req.user.role,
      action: 'MAINTENANCE_EXPORTED',
      resource: 'Maintenance',
      status: 'SUCCESS',
      details: { count: rows.length, filter },
      req,
    });

    const filename = `maintenance-${new Date().toISOString().slice(0, 10)}.csv`;
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
    if (req.query.type) {
      if (!['preventive', 'corrective'].includes(req.query.type)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid type.' } });
      }
      filter.type = req.query.type;
    }

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { startDate, endDate } = parseDateRange(req.query);
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    const { page, limit } = parsePagination(req.query, 20, 100);
    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_MAINTENANCE_SORTS, 'startDate', 'desc');

    const [total, rows] = await Promise.all([
      maintenanceRepository.count(filter),
      maintenanceRepository.list(filter, { page, limit, sortBy, sortOrder }),
    ]);
    const totalPages = Math.ceil(total / limit) || 1;
    return res.json({
      success: true,
      data: {
        maintenance: rows,
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
    const row = await maintenanceRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Maintenance not found.' } });
    return res.json({ success: true, data: { maintenance: row } });
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

    releaseCreateLock = await acquireLock(`instrument-day:${req.body.instrumentId}:${norm.value.startStr}`);
    const tech = await resolveTechnician(req.body.technicianId);
    if (tech.status) return res.status(tech.status).json({ success: false, error: { code: tech.code, message: tech.message } });
    const clash = await maintenanceClashes(req.body.instrumentId, norm.value, null);
    if (clash) {
      const messages = {
        MAINTENANCE_CONFLICT: 'Maintenance already occupies this window.',
        CALIBRATION_CONFLICT: 'Calibration already occupies this window.',
        BOOKING_CONFLICT: 'A booking already occupies this window.',
      };
      return res.status(409).json({ success: false, error: { code: clash.type, message: messages[clash.type] } });
    }

    const record = await maintenanceRepository.create({
      instrumentId: req.body.instrumentId,
      type: req.body.type,
      description: req.body.description.trim().slice(0, 2000),
      startDate: norm.value.start,
      ...(norm.value.endStr !== norm.value.startStr ? { endDate: norm.value.end } : {}),
      ...(norm.value.startTime ? { startTime: norm.value.startTime, endTime: norm.value.endTime } : {}),
      technicianId: tech.value,
      requiresCalibration: req.body.requiresCalibration === true,
      status: 'SCHEDULED',
    });

    const recordId = record._id || record.id;
    await notifyTechnician(tech.value, record, instrument, 'scheduled');
    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'MAINTENANCE_CREATED',
      resource: 'Maintenance',
      resourceId: recordId,
      details: { instrumentId: String(record.instrumentId), type: record.type },
      req,
    });
    const row = await maintenanceRepository.findById(recordId);
    return res.status(201).json({ success: true, data: { maintenance: row }, message: 'Maintenance scheduled.' });
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
    const record = await maintenanceRepository.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Maintenance not found.' } });

    const started = record.status !== 'SCHEDULED';
    const windowTouched = req.body.startDate !== undefined || req.body.endDate !== undefined
      || req.body.startTime !== undefined || req.body.endTime !== undefined;
    if (started && windowTouched) {
      return res.status(422).json({ success: false, error: { code: 'EDIT_LOCKED', message: 'Window cannot change once maintenance has started.' } });
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
      const merged = {
        instrumentId: String(record.instrumentId), type: record.type, description: record.description,
        startDate: toDayString(record.startDate),
        ...(record.endDate ? { endDate: toDayString(record.endDate) } : {}),
        ...(record.startTime ? { startTime: record.startTime, endTime: record.endTime } : {}),
        ...req.body,
      };
      const norm = normalizeWindow(merged);
      if (norm.status) return res.status(norm.status).json({ success: false, error: { code: norm.code, message: norm.message } });

      const releaseRescheduleLock = await acquireLock(`instrument-day:${record.instrumentId}:${norm.value.startStr}`);
      try {
        const clash = await maintenanceClashes(record.instrumentId, norm.value, recordId);
        if (clash) {
          const messages = {
            MAINTENANCE_CONFLICT: 'Maintenance already occupies this window.',
            CALIBRATION_CONFLICT: 'Calibration already occupies this window.',
            BOOKING_CONFLICT: 'A booking already occupies this window.',
          };
          return res.status(409).json({ success: false, error: { code: clash.type, message: messages[clash.type] } });
        }
        updatePayload.startDate = norm.value.start;
        updatePayload.endDate = norm.value.endStr !== norm.value.startStr ? norm.value.end : undefined;
        updatePayload.startTime = norm.value.startTime;
        updatePayload.endTime = norm.value.endTime;
      } finally {
        releaseRescheduleLock();
      }
    }
    if (req.body.type !== undefined) {
      if (!['preventive', 'corrective'].includes(req.body.type)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid type.' } });
      }
      updatePayload.type = req.body.type;
    }
    if (req.body.description !== undefined) {
      if (typeof req.body.description !== 'string' || !req.body.description.trim()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'description must be a non-empty string.' } });
      }
      updatePayload.description = req.body.description.trim().slice(0, 2000);
    }
    if (req.body.technicianId !== undefined) {
      const tech = await resolveTechnician(req.body.technicianId);
      if (tech.status) return res.status(tech.status).json({ success: false, error: { code: tech.code, message: tech.message } });
      updatePayload.technicianId = tech.value;
    }
    if (req.body.requiresCalibration !== undefined) {
      if (typeof req.body.requiresCalibration !== 'boolean') {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'requiresCalibration must be true or false.' } });
      }
      updatePayload.requiresCalibration = req.body.requiresCalibration;
    }

    const instrument = await instrumentRepository.findById(record.instrumentId);
    const instId = instrument ? (instrument.id || instrument._id) : null;
    updatePayload.status = nextStatus;

    if (nextStatus === 'IN_PROGRESS' && instrument && instrument.status !== 'LOCKED') {
      await instrumentRepository.updateStatus(instId, 'UNDER_MAINTENANCE');
    }
    if (nextStatus === 'COMPLETED' && (updatePayload.requiresCalibration ?? record.requiresCalibration)) {
      const dueDate = record.endDate || record.startDate;
      await calibrationRepository.create({
        instrumentId: record.instrumentId,
        calibrationType: 'POST_MAINTENANCE',
        date: dueDate,
        startTime: '09:00',
        endTime: '17:00',
        technicianId: record.technicianId,
        status: 'CALIBRATION_DUE',
        notes: `Required after maintenance ${recordId} (${record.type}).`,
      });
      if (instrument && (!instrument.nextCalibrationDue || instrument.nextCalibrationDue > dueDate)) {
        await instrumentRepository.updateById(instId, { nextCalibrationDue: dueDate });
      }
    }
    if (nextStatus === 'COMPLETED' || nextStatus === 'CANCELLED') {
      await restoreInstrument(record.instrumentId, 'UNDER_MAINTENANCE');
    }

    await maintenanceRepository.updateById(recordId, updatePayload);

    if (req.body.status !== undefined) {
      await notifyTechnician(record.technicianId, record, instrument || { name: 'instrument' },
        nextStatus === 'COMPLETED' ? 'completed' : 'updated');
    }
    await logAudit({
      userId: req.user._id || req.user.id,
      action: nextStatus === 'COMPLETED' ? 'MAINTENANCE_COMPLETED' : 'MAINTENANCE_UPDATED',
      resource: 'Maintenance', resourceId: recordId, details: { status: nextStatus }, req,
    });

    const row = await maintenanceRepository.findById(recordId);
    return res.json({ success: true, data: { maintenance: row } });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- START MAINTENANCE ---------------- */
router.post('/:id/start', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const record = await maintenanceRepository.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Maintenance not found.' } });

    const currentUserId = req.user._id || req.user.id;
    const isAssignedTech = record.technicianId && String(record.technicianId) === String(currentUserId);
    if (req.user.role !== 'admin' && !isAssignedTech) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only administrators or assigned technician can start maintenance.' } });
    }

    if (record.status !== 'SCHEDULED') {
      return res.status(422).json({ success: false, error: { code: 'INVALID_STATUS_TRANSITION', message: `Cannot start maintenance with status ${record.status}.` } });
    }

    const recordId = record._id || record.id;
    await maintenanceRepository.updateById(recordId, { status: 'IN_PROGRESS' });

    const instrument = await instrumentRepository.findById(record.instrumentId);
    if (instrument) {
      const instId = instrument.id || instrument._id;
      await handleInstrumentUnavailability({
        instrumentId: instId,
        newStatus: 'UNDER_MAINTENANCE',
        reason: `Maintenance in progress: ${record.description}`,
        req,
      });
    }

    await logAudit({
      userId: currentUserId,
      action: 'MAINTENANCE_STARTED',
      resource: 'Maintenance',
      resourceId: recordId,
      details: { instrumentId: String(record.instrumentId) },
      req,
    });

    const updated = await maintenanceRepository.findById(recordId);
    return res.json({ success: true, data: { maintenance: updated }, message: 'Maintenance started and instrument placed under maintenance.' });
  } catch (err) { return next(err); }
});

/* ---------------- COMPLETE MAINTENANCE ---------------- */
router.post('/:id/complete', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const record = await maintenanceRepository.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Maintenance not found.' } });

    const currentUserId = req.user._id || req.user.id;
    const isAssignedTech = record.technicianId && String(record.technicianId) === String(currentUserId);
    if (req.user.role !== 'admin' && !isAssignedTech) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only administrators or assigned technician can complete maintenance.' } });
    }

    if (!['SCHEDULED', 'IN_PROGRESS'].includes(record.status)) {
      return res.status(422).json({ success: false, error: { code: 'INVALID_STATUS_TRANSITION', message: `Cannot complete maintenance with status ${record.status}.` } });
    }

    const recordId = record._id || record.id;
    const { workPerformed, partsReplaced, resolutionNotes, requiresCalibration } = req.body || {};
    const finalRequiresCal = requiresCalibration !== undefined ? !!requiresCalibration : !!record.requiresCalibration;

    const payload = {
      status: 'COMPLETED',
      requiresCalibration: finalRequiresCal,
      resolvedBy: currentUserId,
      resolvedAt: new Date(),
      ...(workPerformed ? { workPerformed: String(workPerformed).slice(0, 4000) } : {}),
      ...(partsReplaced ? { partsReplaced: String(partsReplaced).slice(0, 2000) } : {}),
      ...(resolutionNotes ? { resolutionNotes: String(resolutionNotes).slice(0, 2000) } : {}),
    };

    await maintenanceRepository.updateById(recordId, payload);

    const instrument = await instrumentRepository.findById(record.instrumentId);
    const instId = instrument ? (instrument.id || instrument._id) : null;

    if (finalRequiresCal) {
      const dueDate = new Date();
      await calibrationRepository.create({
        instrumentId: record.instrumentId,
        calibrationType: 'POST_MAINTENANCE',
        date: dueDate,
        startTime: '09:00',
        endTime: '17:00',
        technicianId: record.technicianId || currentUserId,
        status: 'CALIBRATION_DUE',
        notes: `Required after maintenance ${recordId} (${record.type}).`,
      });
      if (instId) {
        await instrumentRepository.updateById(instId, {
          status: 'UNDER_CALIBRATION',
          nextCalibrationDue: dueDate,
          unavailabilityReason: 'Post-maintenance calibration due.',
        });
      }
    } else {
      await restoreInstrument(record.instrumentId, 'UNDER_MAINTENANCE');
    }

    await logAudit({
      userId: currentUserId,
      action: 'MAINTENANCE_COMPLETED',
      resource: 'Maintenance',
      resourceId: recordId,
      details: { requiresCalibration: finalRequiresCal, workPerformed },
      req,
    });

    const updated = await maintenanceRepository.findById(recordId);
    return res.json({ success: true, data: { maintenance: updated }, message: 'Maintenance completed.' });
  } catch (err) { return next(err); }
});

/* ---------------- CANCEL MAINTENANCE ---------------- */
router.post('/:id/cancel', adminOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const record = await maintenanceRepository.findById(req.params.id);
    if (!record) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Maintenance not found.' } });

    if (['COMPLETED', 'CANCELLED'].includes(record.status)) {
      return res.status(422).json({ success: false, error: { code: 'INVALID_STATUS_TRANSITION', message: `Cannot cancel maintenance with status ${record.status}.` } });
    }

    const recordId = record._id || record.id;
    await maintenanceRepository.updateById(recordId, { status: 'CANCELLED' });
    await restoreInstrument(record.instrumentId, 'UNDER_MAINTENANCE');

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'MAINTENANCE_CANCELLED',
      resource: 'Maintenance',
      resourceId: recordId,
      details: { reason: req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : 'Cancelled by administrator' },
      req,
    });

    const updated = await maintenanceRepository.findById(recordId);
    return res.json({ success: true, data: { maintenance: updated }, message: 'Maintenance cancelled and instrument restored.' });
  } catch (err) { return next(err); }
});

module.exports = router;
