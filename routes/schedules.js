/**
 * Laboratory scheduling (Phase 04 / Module 06) — spec §6 + §15 + §18.
 * GET /schedules (+/:id) — any authenticated role (students read-only).
 * POST/PATCH/DELETE — admin (any) + faculty (own only). facultyId always comes
 * from the authenticated account; a client-sent facultyId is rejected.
 * Backed by scheduleRepository, laboratoryRepository, userRepository.
 */
const express = require('express');
const {
  scheduleRepository,
  laboratoryRepository,
  userRepository,
} = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { logAudit } = require('../utils/audit');
const { notifyUser } = require('../services/notify');
const { isHHMM, toMinutes, parseDayUTC, dayRangeUTC, isPastDay, toDayString } = require('../utils/time');
const { findLabConflict } = require('../utils/scheduling');
const { acquireLock } = require('../utils/mutex');
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

const canWrite = requireRole('admin', 'faculty');

const CREATE_FIELDS = ['degree', 'department', 'year', 'section', 'subject', 'laboratoryId',
  'date', 'startTime', 'endTime', 'sessionType', 'studentCount', 'notes'];
const PATCH_FIELDS = [...CREATE_FIELDS, 'status'];
const REQUIRED = ['degree', 'department', 'year', 'section', 'subject', 'laboratoryId', 'date', 'startTime', 'endTime'];
const TRIMMED = ['degree', 'department', 'year', 'section', 'subject', 'sessionType', 'notes'];

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}. facultyId is derived from your login.` : null;
}

function normalizeInput(body) {
  for (const f of REQUIRED) {
    if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') {
      return { status: 400, code: 'VALIDATION_ERROR', message: `${f} is required.` };
    }
  }
  const value = {};
  for (const f of TRIMMED) {
    if (body[f] !== undefined) {
      if (typeof body[f] !== 'string') return { status: 400, code: 'VALIDATION_ERROR', message: `${f} must be a string.` };
      value[f] = body[f].trim().slice(0, f === 'notes' ? 2000 : 160);
    }
  }
  if (!isValidId(body.laboratoryId)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'laboratoryId must be a valid id.' };
  }
  value.laboratoryId = body.laboratoryId;
  const dateStr = String(body.date).trim();
  const day = parseDayUTC(dateStr);
  if (!day) return { status: 422, code: 'INVALID_DATE', message: 'date must be YYYY-MM-DD.' };
  if (isPastDay(dateStr)) return { status: 422, code: 'INVALID_DATE', message: 'date cannot be in the past.' };
  value.dateStr = dateStr;
  value.date = day;
  if (!isHHMM(body.startTime) || !isHHMM(body.endTime)) {
    return { status: 422, code: 'INVALID_TIME_RANGE', message: 'startTime/endTime must be HH:mm.' };
  }
  value.startTime = body.startTime;
  value.endTime = body.endTime;
  if (toMinutes(value.endTime) <= toMinutes(value.startTime)) {
    return { status: 422, code: 'INVALID_TIME_RANGE', message: 'endTime must be after startTime.' };
  }
  if (body.studentCount !== undefined) {
    if (typeof body.studentCount !== 'number' || body.studentCount < 0 || body.studentCount > 10000) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'studentCount must be a number 0–10000.' };
    }
    value.studentCount = body.studentCount;
  }
  return { value };
}

async function checkLabAndConflict(value, excludeId) {
  const lab = await laboratoryRepository.findById(value.laboratoryId);
  if (!lab) return { status: 404, code: 'LAB_NOT_FOUND', message: 'Laboratory not found.' };
  if (lab.status !== 'AVAILABLE') {
    return { status: 422, code: 'LAB_UNAVAILABLE', message: `Laboratory is ${lab.status}.` };
  }
  const clash = await findLabConflict(value.laboratoryId, value.dateStr, value.startTime, value.endTime, excludeId);
  if (clash) {
    return {
      status: 409, code: 'LAB_CONFLICT',
      message: `The laboratory is already scheduled during this time (${clash.startTime}–${clash.endTime}).`,
      clashId: String(clash._id || clash.id),
    };
  }
  return { lab };
}

function scheduleEmailData(schedule, faculty, lab) {
  const scheduleId = schedule._id || schedule.id;
  return {
    facultyName: faculty.name,
    degree: schedule.degree,
    department: schedule.department,
    year: schedule.year,
    section: schedule.section,
    subject: schedule.subject,
    laboratory: `${lab.name}${lab.roomNumber ? `, Room ${lab.roomNumber}` : ''}`,
    date: toDayString(schedule.date),
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    status: schedule.status,
    referenceId: String(scheduleId),
  };
}

async function notifyFaculty(faculty, schedule, lab, kind) {
  if (!faculty || !lab) return { emailSent: false, emailAttempts: 0 };
  const subjects = {
    created: 'LabPulse schedule confirmed',
    modified: 'LabPulse schedule modified',
    cancelled: 'LabPulse schedule cancelled',
  };
  const data = scheduleEmailData(schedule, faculty, lab);
  return notifyUser({
    userId: faculty._id || faculty.id,
    type: `schedule-${kind}`,
    title: subjects[kind],
    message: `${schedule.subject} — ${data.laboratory} on ${data.date} ${data.startTime}–${data.endTime} [${data.referenceId}]`,
    email: { to: faculty.email, subject: subjects[kind], template: `schedule-${kind}`, data },
  });
}

/* ---------------- LIST ---------------- */
router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.laboratoryId) {
      if (!isValidId(req.query.laboratoryId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid laboratoryId.' } });
      }
      filter.laboratoryId = req.query.laboratoryId;
    }
    if (req.query.facultyId) {
      if (!isValidId(req.query.facultyId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid facultyId.' } });
      }
      filter.facultyId = req.query.facultyId;
    }
    if (req.query.mine === 'true') filter.facultyId = req.user._id || req.user.id;
    if (req.query.status) {
      if (!['SCHEDULED', 'CANCELLED', 'COMPLETED'].includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      filter.status = req.query.status;
    }
    if (req.query.date) {
      const range = dayRangeUTC(String(req.query.date));
      if (!range) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'date must be YYYY-MM-DD.' } });
      filter.date = req.query.date;
    }
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
    const [total, rows] = await Promise.all([
      scheduleRepository.count(filter),
      scheduleRepository.list(filter, { page, limit }),
    ]);
    return res.json({ success: true, data: { schedules: rows, page, limit, total } });
  } catch (err) { return next(err); }
});

/* ---------------- DETAIL ---------------- */
router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const row = await scheduleRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Schedule not found.' } });
    return res.json({ success: true, data: { schedule: row } });
  } catch (err) { return next(err); }
});

/* ---------------- CREATE ---------------- */
router.post('/', canWrite, async (req, res, next) => {
  let releaseCreateLock;
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'JSON body is required.' } });
    }
    const bad = allowOnly(req.body, CREATE_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const norm = normalizeInput(req.body);
    if (norm.status) return res.status(norm.status).json({ success: false, error: { code: norm.code, message: norm.message } });

    releaseCreateLock = await acquireLock(`lab-day:${norm.value.laboratoryId}:${norm.value.dateStr}`);
    const gate = await checkLabAndConflict(norm.value, null);
    if (gate.status) {
      return res.status(gate.status).json({ success: false, error: { code: gate.code, message: gate.message } });
    }
    const schedule = await scheduleRepository.create({
      ...norm.value,
      date: norm.value.date,
      facultyId: req.user._id || req.user.id,
      status: 'SCHEDULED',
    });
    delete schedule.dateStr;
    const scheduleId = schedule._id || schedule.id;
    await notifyFaculty(req.user, schedule, gate.lab, 'created');
    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'SCHEDULE_CREATED',
      resource: 'Schedule',
      resourceId: scheduleId,
      details: { laboratoryId: String(schedule.laboratoryId) },
      req,
    });
    return res.status(201).json({ success: true, data: { schedule }, message: 'Schedule confirmed.' });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  } finally {
    if (releaseCreateLock) releaseCreateLock();
  }
});

/* ---------------- ownership loader ---------------- */
async function loadOwned(req, res) {
  if (!isValidId(req.params.id)) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    return null;
  }
  const s = await scheduleRepository.findById(req.params.id);
  if (!s) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Schedule not found.' } });
    return null;
  }
  const ownerId = s.facultyId && (s.facultyId._id || s.facultyId.id || s.facultyId);
  const currentUserId = req.user._id || req.user.id;
  if (req.user.role !== 'admin' && String(ownerId) !== String(currentUserId)) {
    res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You can only manage your own schedules.' } });
    return null;
  }
  return s;
}

/* ---------------- UPDATE ---------------- */
router.patch('/:id', canWrite, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, PATCH_FIELDS);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const s = await loadOwned(req, res);
    if (!s) return undefined;
    const scheduleId = s._id || s.id;

    const merged = {
      degree: s.degree, department: s.department, year: s.year, section: s.section,
      subject: s.subject, laboratoryId: String(s.laboratoryId), date: toDayString(s.date),
      startTime: s.startTime, endTime: s.endTime, sessionType: s.sessionType,
      studentCount: s.studentCount, notes: s.notes,
      ...req.body,
    };
    let statusChange = null;
    if (req.body.status !== undefined) {
      if (!['SCHEDULED', 'CANCELLED', 'COMPLETED'].includes(req.body.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      statusChange = req.body.status;
    }
    const norm = normalizeInput(merged);
    if (norm.status) return res.status(norm.status).json({ success: false, error: { code: norm.code, message: norm.message } });
    const targetStatus = statusChange || s.status;

    let labForMail;
    const releaseRescheduleLock = await acquireLock(`lab-day:${norm.value.laboratoryId}:${norm.value.dateStr}`);
    try {
      if (targetStatus !== 'CANCELLED') {
        const gate = await checkLabAndConflict(norm.value, scheduleId);
        if (gate.status) return res.status(gate.status).json({ success: false, error: { code: gate.code, message: gate.message } });
        labForMail = gate.lab;
      } else {
        labForMail = await laboratoryRepository.findById(s.laboratoryId);
      }
      const updateData = { ...norm.value, date: norm.value.date, status: targetStatus };
      delete updateData.dateStr;
      await scheduleRepository.updateById(scheduleId, updateData);
    } finally {
      releaseRescheduleLock();
    }

    const ownerId = s.facultyId && (s.facultyId._id || s.facultyId.id || s.facultyId);
    const faculty = req.user.role === 'admin' ? await userRepository.findById(ownerId) : req.user;
    const kind = targetStatus === 'CANCELLED' && s.status === 'CANCELLED' && statusChange ? 'cancelled' : 'modified';
    await notifyFaculty(faculty, s, labForMail, kind);
    await logAudit({ userId: req.user._id || req.user.id, action: 'SCHEDULE_UPDATED', resource: 'Schedule', resourceId: scheduleId, details: { status: targetStatus }, req });
    const row = await scheduleRepository.findById(scheduleId);
    return res.json({ success: true, data: { schedule: row } });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- DELETE ---------------- */
router.delete('/:id', canWrite, async (req, res, next) => {
  try {
    const s = await loadOwned(req, res);
    if (!s) return undefined;
    const scheduleId = s._id || s.id;
    const lab = await laboratoryRepository.findById(s.laboratoryId);
    const ownerId = s.facultyId && (s.facultyId._id || s.facultyId.id || s.facultyId);
    const faculty = req.user.role === 'admin' ? await userRepository.findById(ownerId) : req.user;
    await scheduleRepository.deleteById(scheduleId);
    if (faculty && lab) await notifyFaculty(faculty, s, lab, 'cancelled');
    await logAudit({ userId: req.user._id || req.user.id, action: 'SCHEDULE_DELETED', resource: 'Schedule', resourceId: scheduleId, details: {}, req });
    return res.status(204).end();
  } catch (err) { return next(err); }
});

module.exports = router;
