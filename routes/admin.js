/**
 * Admin faculty management (Phase 03 / Module 06) — spec §3 + §15.
 * GET /admin/faculty | POST /admin/faculty | GET/PATCH/DELETE /admin/faculty/:id
 * Breakage review/resolve | Audit logs
 *
 * All routes: requireDB + requireAuth + requireRole('admin').
 * Backed by userRepository, breakageRepository, calibrationRepository,
 * instrumentRepository, auditRepository.
 */
const crypto = require('crypto');
const express = require('express');
const {
  userRepository,
  breakageRepository,
  calibrationRepository,
  instrumentRepository,
  auditRepository,
} = require('../repositories');
const { dbState } = require('../config/db');
const { isSupabaseConfigured, getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { hashPassword } = require('../utils/password');
const { issueOpaqueToken } = require('../utils/tokens');
const { notifyUser } = require('../services/notify');
const { logAudit } = require('../utils/audit');
const { restoreInstrument } = require('../utils/restore');
const { isValidId } = require('../utils/idValidation');

const router = express.Router();

/** 503 when DB is down (safe-startup consistency). */
function requireDB(req, res, next) {
  if (getActiveDataBackend() === 'supabase') {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
    }
    return next();
  }
  if (dbState() !== 1) {
    return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
  }
  return next();
}
router.use(requireDB, requireAuth, requireRole('admin'));

const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72h activation window
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MANAGED_ROLES = ['faculty', 'student'];

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}` : null;
}

function normEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function isDup(err) {
  return (err && err.code === 11000) || (err && (err.code === 'DUPLICATE_RESOURCE' || err.code === '23505'));
}

function dupField(err) {
  const keys = Object.keys((err && err.keyValue) || {});
  return keys.includes('email') ? 'Email is already registered.' : 'Duplicate value for a unique field.';
}

function formatSafeUser(u) {
  if (!u) return null;
  if (typeof u.toSafeJSON === 'function') return u.toSafeJSON();
  return {
    id: u.id || u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department || null,
    facultyId: u.facultyId || null,
    studentId: u.studentId || null,
    year: u.year || null,
    section: u.section || null,
    isActive: u.isActive !== false,
  };
}

/* ---------------- LIST ---------------- */
router.get('/faculty', async (req, res, next) => {
  try {
    const role = req.query.role || 'faculty';
    if (!['faculty', 'student', 'all'].includes(role)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'role must be faculty, student, or all.' } });
    }
    const filter = {};
    if (role !== 'all') filter.role = role;
    if (req.query.isActive !== undefined) {
      if (!['true', 'false'].includes(req.query.isActive)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'isActive must be true or false.' } });
      }
      filter.isActive = req.query.isActive === 'true';
    }
    if (req.query.q) {
      filter.q = String(req.query.q).slice(0, 80);
    }
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));

    const [total, users] = await Promise.all([
      userRepository.count(filter),
      userRepository.list(filter, { page, limit }),
    ]);

    return res.json({
      success: true,
      data: { users: users.map(formatSafeUser), page, limit, total },
    });
  } catch (err) { return next(err); }
});

/* ---------------- CREATE (invite) ---------------- */
router.post('/faculty', async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, ['name', 'email', 'department', 'facultyId']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = normEmail(req.body.email);
    if (!name || !email) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Name and email are required.' } });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid email.' } });
    }
    // Unusable placeholder hash — account cannot log in until activation sets a real password.
    const placeholder = await hashPassword(crypto.randomBytes(48).toString('hex'));
    const { token, tokenHash } = issueOpaqueToken();

    const currentAdminId = req.user._id || req.user.id;
    const user = await userRepository.create({
      name: name.slice(0, 120),
      email,
      passwordHash: placeholder,
      role: 'faculty',
      department: typeof req.body.department === 'string' ? req.body.department.trim().slice(0, 120) : undefined,
      facultyId: typeof req.body.facultyId === 'string' ? req.body.facultyId.trim().slice(0, 60) : undefined,
      isActive: false,
      emailVerified: false,
      createdBy: currentAdminId,
      activationTokenHash: tokenHash,
      activationExpires: new Date(Date.now() + INVITE_TTL_MS),
    });

    const targetUserId = user._id || user.id;

function resolveAppUrl(req) {
  const origin = req ? (req.get('origin') || `${req.protocol}://${req.get('host')}`) : '';
  if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
    return origin.replace(/\/$/, '');
  }
  if (process.env.APP_URL && !process.env.APP_URL.includes('localhost') && !process.env.APP_URL.includes('127.0.0.1')) {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  }
  return (origin || process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

    const baseUrl = resolveAppUrl(req);
    const activationLink = `${baseUrl}/reset-password.html?token=${encodeURIComponent(token)}`;

    // Delivery failure must not roll back the invite; status is recorded on the notification.
    const notifyOutcome = await notifyUser({
      userId: targetUserId, type: 'faculty-invitation', title: 'LabPulse faculty account activation',
      message: `Faculty account created for ${user.email}. Activation link expires in 72 hours.`,
      email: {
        to: user.email, subject: 'LabPulse faculty account activation', template: 'faculty-invitation',
        data: { name: user.name, activationToken: token, expiresInHours: 72, baseUrl },
      },
    });

    if (process.env.NODE_ENV !== 'test') {
      if (notifyOutcome && notifyOutcome.emailSent) {
        console.log(`[admin:faculty] Invitation email delivered to ${user.email}`);
      } else {
        console.warn(`[admin:faculty] Warning: Email delivery to ${user.email} failed. Activation link: ${activationLink}`);
      }
    }

    await logAudit({ userId: currentAdminId, action: 'FACULTY_CREATED', resource: 'User', resourceId: targetUserId, details: { email }, req });
    return res.status(201).json({
      success: true,
      data: { user: formatSafeUser(user), activationToken: token, activationLink },
      emailSent: !!(notifyOutcome && notifyOutcome.emailSent),
      message: 'Faculty invited. Activation email sent.',
    });
  } catch (err) {
    if (isDup(err)) return res.status(409).json({ success: false, error: { code: 'EMAIL_TAKEN', message: dupField(err) } });
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- DETAIL ---------------- */
router.get('/faculty/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const user = await userRepository.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
    return res.json({ success: true, data: { user: formatSafeUser(user) } });
  } catch (err) { return next(err); }
});

/* ---------------- UPDATE ---------------- */
router.patch('/faculty/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const bad = allowOnly(req.body, ['name', 'email', 'department', 'facultyId', 'role', 'isActive']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const user = await userRepository.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });

    const currentUserId = String(req.user._id || req.user.id);
    const targetUserId = String(user._id || user.id);
    const self = targetUserId === currentUserId;

    if (self && ((req.body.role !== undefined && req.body.role !== user.role) || req.body.isActive === false)) {
      return res.status(400).json({ success: false, error: { code: 'SELF_LOCKOUT_BLOCKED', message: 'You cannot change your own role or deactivate yourself.' } });
    }
    if (user.role === 'admin') {
      return res.status(403).json({ success: false, error: { code: 'NOT_MANAGEABLE', message: 'Admin accounts are not managed via this route.' } });
    }

    const updates = {};
    const changed = [];
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Name must be a non-empty string.' } });
      }
      updates.name = req.body.name.trim().slice(0, 120);
      changed.push('name');
    }
    if (req.body.email !== undefined) {
      const email = normEmail(req.body.email);
      if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid email.' } });
      }
      if (email !== user.email) {
        updates.email = email;
        updates.emailVerified = false;
        changed.push('email');
      }
    }
    if (req.body.department !== undefined) {
      updates.department = typeof req.body.department === 'string' ? req.body.department.trim().slice(0, 120) : null;
      changed.push('department');
    }
    if (req.body.facultyId !== undefined) {
      updates.facultyId = typeof req.body.facultyId === 'string' && req.body.facultyId.trim() ? req.body.facultyId.trim().slice(0, 60) : null;
      changed.push('facultyId');
    }
    if (req.body.role !== undefined) {
      if (!MANAGED_ROLES.includes(req.body.role)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'role must be faculty or student.' } });
      }
      if (req.body.role !== user.role) {
        updates.role = req.body.role;
        changed.push('role');
      }
    }
    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'isActive must be true or false.' } });
      }
      if (req.body.isActive !== user.isActive) {
        updates.isActive = req.body.isActive;
        if (!req.body.isActive) {
          updates.tokenVersion = (user.tokenVersion || 0) + 1;
        }
        changed.push('isActive');
      }
    }

    const updatedUser = await userRepository.updateById(targetUserId, updates);
    await logAudit({ userId: currentUserId, action: 'FACULTY_UPDATED', resource: 'User', resourceId: targetUserId, details: { changed }, req });
    return res.json({ success: true, data: { user: formatSafeUser(updatedUser) } });
  } catch (err) {
    if (isDup(err)) return res.status(409).json({ success: false, error: { code: 'EMAIL_TAKEN', message: dupField(err) } });
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- DELETE ---------------- */
router.delete('/faculty/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const user = await userRepository.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });

    const currentUserId = String(req.user._id || req.user.id);
    const targetUserId = String(user._id || user.id);

    if (targetUserId === currentUserId) {
      return res.status(400).json({ success: false, error: { code: 'SELF_DELETE_BLOCKED', message: 'You cannot delete your own account.' } });
    }
    if (user.role === 'admin') {
      return res.status(403).json({ success: false, error: { code: 'NOT_MANAGEABLE', message: 'Admin accounts are not managed via this route.' } });
    }

    await userRepository.deleteById(targetUserId);
    await logAudit({ userId: currentUserId, action: 'FACULTY_DELETED', resource: 'User', resourceId: targetUserId, details: { email: user.email }, req });
    return res.status(24).end ? res.status(204).end() : res.sendStatus(204);
  } catch (err) { return next(err); }
});

/* ==========================================================================
   BREAKAGE REVIEW / CONFIRM / RESOLVE (Phase 08 / Module 06) — spec §11 + §15.
   Only Admin confirms damage and records/edits the fee. Faculty/Student can never
   set it (reporter routes reject the field outright). Fee changes are allowed only
   on CONFIRMED records. Resolve repairs -> optionally raises calibration -> restores.
   ========================================================================== */
const BREAKAGE_TRANSITIONS = {
  REPORTED: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['CONFIRMED', 'REJECTED', 'REPORTED'],
  CONFIRMED: [],
  REJECTED: [],
  RESOLVED: [],
};

async function notifyReporter(report, kind, resolutionNotes) {
  try {
    const reporter = await userRepository.findById(report.reportedBy);
    if (!reporter) return { emailSent: false, emailAttempts: 0 };
    const data = {
      issueType: report.issueType, status: report.status,
      breakageFee: report.breakageFee || 0, referenceId: String(report.id || report._id),
    };
    if (resolutionNotes) data.resolutionNotes = String(resolutionNotes).slice(0, 500);
    return notifyUser({
      userId: reporter.id || reporter._id,
      type: `breakage-${kind}`,
      title: `LabPulse breakage ${kind}`,
      message: `${report.issueType} is ${report.status} [${report.id || report._id}]`,
      email: { to: reporter.email, subject: `LabPulse breakage ${kind}`, template: `breakage-${kind}`, data },
    });
  } catch (err) {
    console.warn('[notify] breakage reporter notification failed:', err.message);
    return { emailSent: false, emailAttempts: 0 };
  }
}

async function enrichReport(report) {
  if (!report) return null;
  const out = { ...report };
  if (typeof report.instrumentId === 'string') {
    const inst = await instrumentRepository.findById(report.instrumentId);
    if (inst) {
      out.instrumentId = {
        _id: String(inst.id || inst._id),
        id: String(inst.id || inst._id),
        name: inst.name,
        status: inst.status,
      };
    }
  }
  if (typeof report.reportedBy === 'string') {
    const user = await userRepository.findById(report.reportedBy);
    if (user) {
      out.reportedBy = {
        _id: String(user.id || user._id),
        id: String(user.id || user._id),
        name: user.name,
        email: user.email,
      };
    }
  }
  return out;
}

/* ---------------- REVIEW / EDIT / CONFIRM ---------------- */
router.patch('/breakage-reports/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const bad = allowOnly(req.body, ['issueType', 'severity', 'description', 'evidence', 'status', 'breakageFee']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const report = await breakageRepository.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Report not found.' } });

    let nextStatus = report.status;
    if (req.body.status !== undefined) {
      if (!Object.keys(BREAKAGE_TRANSITIONS).includes(req.body.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      if (req.body.status !== report.status && !BREAKAGE_TRANSITIONS[report.status].includes(req.body.status)) {
        return res.status(422).json({ success: false, error: { code: 'INVALID_STATUS_TRANSITION', message: `Cannot move ${report.status} to ${req.body.status}.` } });
      }
      nextStatus = req.body.status;
    }

    const updates = {};
    // Fee: admin-only and CONFIRMED-only. Never a booking charge.
    if (req.body.breakageFee !== undefined) {
      if (nextStatus !== 'CONFIRMED') {
        return res.status(422).json({ success: false, error: { code: 'FEE_NOT_ALLOWED', message: 'Breakage fee can only be recorded on confirmed damage.' } });
      }
      if (typeof req.body.breakageFee !== 'number' || req.body.breakageFee < 0) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'breakageFee must be a number >= 0.' } });
      }
      updates.breakageFee = req.body.breakageFee;
    }
    if (req.body.issueType !== undefined) {
      if (typeof req.body.issueType !== 'string' || !req.body.issueType.trim()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'issueType must be a non-empty string.' } });
      }
      updates.issueType = req.body.issueType.trim().slice(0, 120);
    }
    if (req.body.severity !== undefined) {
      if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(req.body.severity)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid severity.' } });
      }
      updates.severity = req.body.severity;
    }
    if (req.body.description !== undefined) {
      if (typeof req.body.description !== 'string' || !req.body.description.trim()) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'description must be a non-empty string.' } });
      }
      updates.description = req.body.description.trim().slice(0, 2000);
    }
    if (req.body.evidence !== undefined) {
      updates.evidence = typeof req.body.evidence === 'string' ? req.body.evidence.trim().slice(0, 2000) : null;
    }

    const was = report.status;
    const currentAdminId = req.user._id || req.user.id;
    updates.status = nextStatus;
    updates.adminReviewedBy = currentAdminId;
    if (nextStatus === 'CONFIRMED' && was !== 'CONFIRMED') {
      updates.confirmedAt = new Date();
    }

    const reportId = report.id || report._id;
    const updated = await breakageRepository.updateById(reportId, updates);

    if (nextStatus !== was) {
      if (nextStatus === 'REJECTED') {
        // False alarm: release the instrument if no other open report holds it.
        await restoreInstrument(report.instrumentId, 'OUT_OF_ORDER');
      }
      await notifyReporter(updated, nextStatus === 'CONFIRMED' ? 'confirmed' : 'updated');
    }

    await logAudit({
      userId: currentAdminId,
      action: nextStatus === 'CONFIRMED' ? 'BREAKAGE_CONFIRMED' : nextStatus === 'REJECTED' ? 'BREAKAGE_REJECTED' : 'BREAKAGE_UPDATED',
      resource: 'BreakageReport', resourceId: reportId,
      details: { status: nextStatus, fee: nextStatus === 'CONFIRMED' ? (updates.breakageFee || report.breakageFee) : undefined }, req,
    });

    const enriched = await enrichReport(updated);
    return res.json({ success: true, data: { report: enriched } });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- RESOLVE (repair done) ---------------- */
router.post(['/breakage-reports/:id/resolve', '/breakage/:id/resolve'], async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const bad = allowOnly(req.body || {}, ['requiresCalibration', 'resolutionNotes', 'maintenanceId']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const report = await breakageRepository.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    if (report.status !== 'CONFIRMED') {
      return res.status(422).json({ success: false, error: { code: 'INVALID_STATUS_TRANSITION', message: 'Only confirmed damage can be resolved.' } });
    }

    const currentAdminId = req.user._id || req.user.id;
    const reportId = report.id || report._id;
    const requiresCalibration = req.body.requiresCalibration === true;

    const resolvePayload = {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      adminReviewedBy: currentAdminId,
      returnToServiceBy: currentAdminId,
      returnToServiceAt: new Date(),
    };
    if (req.body.resolutionNotes) {
      resolvePayload.resolutionNotes = String(req.body.resolutionNotes).slice(0, 2000);
    }
    if (req.body.maintenanceId && isValidId(req.body.maintenanceId)) {
      resolvePayload.maintenanceId = req.body.maintenanceId;
    }

    const updated = await breakageRepository.updateById(reportId, resolvePayload);

    if (requiresCalibration) {
      // Repair -> calibration required -> instrument stays OUT_OF_ORDER until that
      // calibration runs (start flips UNDER_CALIBRATION, completion restores).
      const dueDate = new Date();
      await calibrationRepository.create({
        instrumentId: report.instrumentId,
        calibrationType: 'POST_REPAIR',
        date: dueDate,
        startTime: '09:00',
        endTime: '17:00',
        technicianId: currentAdminId,
        status: 'CALIBRATION_DUE',
        notes: `Required after breakage repair ${reportId}.`,
      });
      const inst = await instrumentRepository.findById(report.instrumentId);
      if (inst && (!inst.nextCalibrationDue || new Date(inst.nextCalibrationDue) > dueDate)) {
        await instrumentRepository.updateById(report.instrumentId, { nextCalibrationDue: dueDate });
      }
    } else {
      await restoreInstrument(report.instrumentId, 'OUT_OF_ORDER');
    }

    await notifyReporter(updated, 'resolved', req.body.resolutionNotes);
    await logAudit({ userId: currentAdminId, action: 'BREAKAGE_RESOLVED', resource: 'BreakageReport', resourceId: reportId, details: { requiresCalibration }, req });

    const enriched = await enrichReport(updated);
    return res.json({ success: true, data: { report: enriched } });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

/* ---------------- AUDIT LOGS (read-only, append-only store) ---------------- */
router.get('/audit-logs', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.action) filter.action = String(req.query.action).slice(0, 120);
    if (req.query.resource) filter.resource = String(req.query.resource).slice(0, 120);
    if (req.query.userId) {
      if (!isValidId(req.query.userId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid userId.' } });
      }
      filter.userId = req.query.userId;
    }
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));

    const [total, rows] = await Promise.all([
      auditRepository.count(filter),
      auditRepository.list(filter, { page, limit }),
    ]);

    // Enrich logs with user details if needed
    const enriched = await Promise.all(
      rows.map(async (row) => {
        if (row.userId && typeof row.userId === 'string') {
          const user = await userRepository.findById(row.userId);
          if (user) {
            return {
              ...row,
              userId: {
                _id: String(user.id || user._id),
                id: String(user.id || user._id),
                name: user.name,
                email: user.email,
                role: user.role,
              },
            };
          }
        }
        return row;
      })
    );

    return res.json({ success: true, data: { logs: enriched, page, limit, total } });
  } catch (err) { return next(err); }
});

module.exports = router;
