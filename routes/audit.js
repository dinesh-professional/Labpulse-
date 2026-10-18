/**
 * Audit & Compliance Reporting Routes (Module 13)
 * Mounted at /api/v1/audit in server.js.
 *
 * Endpoints:
 *   GET    /logs                — Paginated, filtered, enriched audit log listing
 *   GET    /logs/:id            — Single audit log detail view (safe)
 *   GET    /export              — Streamed CSV export of audit logs + self-logs AUDIT_LOGS_EXPORTED
 *   GET    /reports/compliance  — Real aggregated compliance metrics
 *   GET    /reports/export      — Compliance report CSV export + self-logs COMPLIANCE_REPORT_GENERATED
 *
 * Security:
 *   - requireAuth + requireRole('admin') on all endpoints.
 *   - Actor identity derived server-side from req.user — never trust client-supplied values.
 *   - Audit logs are strictly immutable (append-only); no updates or deletes.
 */
const express = require('express');
const { auditRepository, userRepository } = require('../repositories');
const { getActiveDataBackend } = require('../config/supabase');
const { dbState } = require('../config/db');
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

router.use(requireDB);
router.use(requireAuth);
router.use(requireRole('admin'));

const VALID_STATUSES = ['SUCCESS', 'FAILURE', 'DENIED'];

/* ============================================================================
   GET /logs — Paginated, filtered, enriched audit log listing
   ============================================================================ */
router.get('/logs', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.action) filter.action = String(req.query.action).slice(0, 120);
    if (req.query.resource) filter.resource = String(req.query.resource).slice(0, 120);
    if (req.query.resourceId) {
      if (!isValidId(req.query.resourceId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid resourceId.' } });
      }
      filter.resourceId = req.query.resourceId;
    }
    if (req.query.userId) {
      if (!isValidId(req.query.userId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid userId.' } });
      }
      filter.userId = req.query.userId;
    }
    if (req.query.role) filter.actorRole = String(req.query.role).slice(0, 32);
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}.` } });
      }
      filter.status = req.query.status;
    }
    if (req.query.laboratoryId) {
      if (!isValidId(req.query.laboratoryId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid laboratoryId.' } });
      }
      filter.laboratoryId = req.query.laboratoryId;
    }
    if (req.query.startDate) filter.startDate = req.query.startDate;
    if (req.query.endDate) filter.endDate = req.query.endDate;
    if (req.query.q) filter.q = String(req.query.q).slice(0, 200);

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));

    const [total, rows] = await Promise.all([
      auditRepository.count(filter),
      auditRepository.list(filter, { page, limit }),
    ]);

    // Enrich rows with actor details
    const enriched = await Promise.all(
      rows.map(async (row) => {
        if (row.userId && typeof row.userId === 'string') {
          try {
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
          } catch (_) { /* skip enrichment */ }
        }
        return row;
      })
    );

    return res.json({
      success: true,
      data: { logs: enriched, page, limit, total },
    });
  } catch (err) { return next(err); }
});

/* ============================================================================
   GET /logs/:id — Single audit log detail
   ============================================================================ */
router.get('/logs/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const log = await auditRepository.findById(req.params.id);
    if (!log) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Audit log not found.' } });
    }

    // Enrich actor
    if (log.userId && typeof log.userId === 'string') {
      try {
        const user = await userRepository.findById(log.userId);
        if (user) {
          log.userId = {
            _id: String(user.id || user._id),
            id: String(user.id || user._id),
            name: user.name,
            email: user.email,
            role: user.role,
          };
        }
      } catch (_) { /* skip enrichment */ }
    }

    return res.json({ success: true, data: { log } });
  } catch (err) { return next(err); }
});

/* ============================================================================
   GET /export — CSV export of audit logs
   ============================================================================ */
router.get('/export', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.action) filter.action = String(req.query.action).slice(0, 120);
    if (req.query.resource) filter.resource = String(req.query.resource).slice(0, 120);
    if (req.query.status && VALID_STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (req.query.startDate) filter.startDate = req.query.startDate;
    if (req.query.endDate) filter.endDate = req.query.endDate;
    if (req.query.q) filter.q = String(req.query.q).slice(0, 200);

    // Fetch up to 5000 rows for export
    const rows = await auditRepository.list(filter, { page: 1, limit: 5000 });
    const csv = auditRepository.toCsv(rows);

    // Self-log the export event
    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'AUDIT_LOGS_EXPORTED',
      resource: 'AuditLog',
      details: { rowCount: rows.length, filter },
      req,
    });

    const filename = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) { return next(err); }
});

/* ============================================================================
   GET /reports/compliance — Real aggregated compliance metrics
   ============================================================================ */
router.get('/reports/compliance', async (req, res, next) => {
  try {
    const opts = {};
    if (req.query.startDate) opts.startDate = req.query.startDate;
    if (req.query.endDate) opts.endDate = req.query.endDate;
    if (req.query.laboratoryId) {
      if (!isValidId(req.query.laboratoryId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid laboratoryId.' } });
      }
      opts.laboratoryId = req.query.laboratoryId;
    }

    const report = await auditRepository.getComplianceSummary(opts);
    return res.json({ success: true, data: { report } });
  } catch (err) { return next(err); }
});

/* ============================================================================
   GET /reports/export — Compliance report CSV export
   ============================================================================ */
router.get('/reports/export', async (req, res, next) => {
  try {
    const opts = {};
    if (req.query.startDate) opts.startDate = req.query.startDate;
    if (req.query.endDate) opts.endDate = req.query.endDate;
    if (req.query.laboratoryId && isValidId(req.query.laboratoryId)) {
      opts.laboratoryId = req.query.laboratoryId;
    }

    const report = await auditRepository.getComplianceSummary(opts);

    // Build flat CSV from nested report
    const lines = ['category,metric,value'];
    function flatten(obj, prefix) {
      for (const [k, v] of Object.entries(obj)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          flatten(v, prefix ? `${prefix}.${k}` : k);
        } else {
          lines.push(`${prefix ? prefix + '.' : ''}${k},${v === null ? '' : v}`);
        }
      }
    }
    flatten(report, '');
    const csv = lines.join('\r\n');

    // Self-log the export event
    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'COMPLIANCE_REPORT_GENERATED',
      resource: 'ComplianceReport',
      details: { scope: report.scope },
      req,
    });

    const filename = `compliance-report-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) { return next(err); }
});

module.exports = router;
