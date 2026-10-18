/**
 * Breakage reporting (Phase 08 / Module 06) — spec §11 + §15 (reporter side).
 * GET /breakage-reports(+/:id) — any authenticated role, but breakageFee is admin-only
 * (students/faculty never see fee controls or values).
 * POST /breakage-reports — faculty + admin. reportedBy always comes from auth.
 * Backed by breakageRepository, instrumentRepository, userRepository.
 */
const express = require('express');
const {
  breakageRepository,
  instrumentRepository,
  userRepository,
} = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { logAudit } = require('../utils/audit');
const { notifyUser } = require('../services/notify');
const { isValidId } = require('../utils/idValidation');
const { handleInstrumentUnavailability } = require('../services/instrumentLifecycle');
const { parsePagination, parseSort, sanitizeSearchTerm } = require('../utils/queryParser');
const { toCsv } = require('../utils/csv');

const router = express.Router();

const ALLOWED_BREAKAGE_SORTS = {
  createdAt: { dbField: 'created_at', mongoField: 'createdAt' },
  severity: { dbField: 'severity', mongoField: 'severity' },
  status: { dbField: 'status', mongoField: 'status' },
  breakageFee: { dbField: 'breakage_fee', mongoField: 'breakageFee' },
};

function requireDB(req, res, next) {
  if (getActiveDataBackend() === 'supabase') return next();
  if (dbState() !== 1) {
    return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
  }
  return next();
}
router.use(requireDB, requireAuth);

const canReport = requireRole('admin', 'faculty', 'student');
const STATUSES = ['REPORTED', 'UNDER_REVIEW', 'CONFIRMED', 'REJECTED', 'RESOLVED'];

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}. Reporter identity and fees are never accepted here.` : null;
}

/* ---------------- EXPORT ---------------- */
router.get('/export', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.instrumentId && isValidId(req.query.instrumentId)) filter.instrumentId = req.query.instrumentId;
    if (req.query.status && STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (req.query.severity && ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(req.query.severity)) filter.severity = req.query.severity;

    // Students only export own reports
    if (req.user.role === 'student') {
      filter.reportedBy = req.user._id || req.user.id;
    } else if (req.query.mine === 'true') {
      filter.reportedBy = req.user._id || req.user.id;
    }

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_BREAKAGE_SORTS, 'createdAt', 'desc');

    const rows = await breakageRepository.list(filter, {
      page: 1,
      limit: 1000,
      sortBy,
      sortOrder,
    });

    const columns = [
      { key: '_id', label: 'ID' },
      { key: 'instrumentId', label: 'Instrument ID' },
      { key: 'reportedBy', label: 'Reported By' },
      { key: 'issueType', label: 'Issue Type' },
      { key: 'severity', label: 'Severity' },
      { key: 'status', label: 'Status' },
      { key: 'description', label: 'Description' },
      { key: 'createdAt', label: 'Created At' },
    ];

    if (req.user.role === 'admin') {
      columns.push({ key: 'breakageFee', label: 'Breakage Fee' });
    } else {
      for (const r of rows) delete r.breakageFee;
    }

    const csvData = toCsv(rows, columns);

    await logAudit({
      userId: req.user._id || req.user.id,
      actorRole: req.user.role,
      action: 'BREAKAGE_EXPORTED',
      resource: 'BreakageReport',
      status: 'SUCCESS',
      details: { count: rows.length, filter },
      req,
    });

    const filename = `breakage-reports-${new Date().toISOString().slice(0, 10)}.csv`;
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
      if (!STATUSES.includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status.' } });
      }
      filter.status = req.query.status;
    }
    if (req.query.severity) {
      if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(req.query.severity)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid severity.' } });
      }
      filter.severity = req.query.severity;
    }
    if (req.query.mine === 'true') filter.reportedBy = req.user._id || req.user.id;

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    const { page, limit } = parsePagination(req.query, 20, 100);
    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_BREAKAGE_SORTS, 'createdAt', 'desc');

    const [total, rows] = await Promise.all([
      breakageRepository.count(filter),
      breakageRepository.list(filter, { page, limit, sortBy, sortOrder }),
    ]);

    if (req.user.role !== 'admin') {
      for (const r of rows) delete r.breakageFee;
    }

    const totalPages = Math.ceil(total / limit) || 1;
    return res.json({
      success: true,
      data: {
        reports: rows,
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
    const row = await breakageRepository.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Report not found.' } });
    if (req.user.role !== 'admin') {
      delete row.breakageFee;
    }
    return res.json({ success: true, data: { report: row } });
  } catch (err) { return next(err); }
});

/* ---------------- REPORT ---------------- */
router.post('/', canReport, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, ['instrumentId', 'issueType', 'severity', 'description', 'evidence']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    if (!isValidId(req.body.instrumentId)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'instrumentId must be a valid id.' } });
    }
    const instrument = await instrumentRepository.findById(req.body.instrumentId);
    if (!instrument) return res.status(404).json({ success: false, error: { code: 'INSTRUMENT_NOT_FOUND', message: 'Instrument not found.' } });
    if (typeof req.body.issueType !== 'string' || !req.body.issueType.trim()) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'issueType is required.' } });
    }
    if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(req.body.severity)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'severity must be LOW, MEDIUM, HIGH, or CRITICAL.' } });
    }
    if (typeof req.body.description !== 'string' || !req.body.description.trim()) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'description is required.' } });
    }

    const currentUserId = req.user._id || req.user.id;
    const report = await breakageRepository.create({
      instrumentId: req.body.instrumentId,
      reportedBy: currentUserId,
      issueType: req.body.issueType.trim().slice(0, 120),
      severity: req.body.severity,
      description: req.body.description.trim().slice(0, 2000),
      evidence: typeof req.body.evidence === 'string' ? req.body.evidence.trim().slice(0, 2000) : undefined,
      status: 'REPORTED',
    });

    // Working -> reported -> OUT_OF_ORDER (LOCKED keeps safety priority)
    const instId = instrument.id || instrument._id;
    if (instrument.status !== 'LOCKED') {
      await handleInstrumentUnavailability({
        instrumentId: instId,
        newStatus: 'OUT_OF_ORDER',
        reason: `Breakdown reported: ${report.issueType} (${report.severity})`,
        req,
      });
    }

    const reportId = report.id || report._id;

    // Broadcast notification to active administrators
    try {
      const admins = await userRepository.list({ role: 'admin', isActive: true }, { limit: 100 });
      for (const a of admins) {
        await notifyUser({
          userId: a.id || a._id,
          type: 'breakage-reported',
          title: 'Breakage reported',
          message: `${instrument.name}: ${report.issueType} [${reportId}]`,
          email: null,
        });
      }
      await notifyUser({
        userId: currentUserId,
        type: 'breakage-reported',
        title: 'Breakage report received',
        message: `${instrument.name}: ${report.issueType} [${reportId}]`,
        email: null,
      });
    } catch (err) {
      console.warn('[notify] breakage broadcast failed:', err.message);
    }

    await logAudit({
      userId: currentUserId,
      action: 'BREAKAGE_REPORTED',
      resource: 'BreakageReport',
      resourceId: reportId,
      details: { instrumentId: String(report.instrumentId), severity: report.severity },
      req,
    });

    const row = await breakageRepository.findById(reportId);
    if (req.user.role !== 'admin') {
      delete row.breakageFee;
    }
    return res.status(201).json({ success: true, data: { report: row }, message: 'Breakage reported. Instrument marked out of order.' });
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    return next(err);
  }
});

module.exports = router;
