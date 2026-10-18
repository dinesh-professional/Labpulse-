/**
 * Analytics & Operational Intelligence Routes (Module 15)
 * Mounted at /api/v1/analytics in server.js.
 *
 * Endpoints:
 *   GET /overview        — Operational health summary, active counts, availability rate & attention items
 *   GET /utilization     — Instrument operating capacity vs. booked duration, utilization %, idle instruments
 *   GET /bookings        — Booking trends time-series, peak hour distribution, outcome breakdown
 *   GET /maintenance     — Preventive vs. corrective breakdown, downtime hours, top maintained instruments
 *   GET /calibration     — Compliance %, overdue count, forecast windows (7/14/30 days)
 *   GET /qualifications  — Level breakdown, active vs expired, operator qualification distribution
 *   GET /breakage        — Equipment incident counts, severity/status breakdown, assessed fees (admin-only)
 *   GET /access          — QR terminal passes issued, redeemed, redemption rate %
 *   GET /export          — CSV export of operational metrics with RFC 4180 escaping & audit logging
 *
 * Authorization:
 *   - Admin: Global platform-wide access
 *   - Faculty: Scoped strictly to assigned laboratories / department
 *   - Student: 403 Forbidden (administrative analytics are restricted)
 */
const express = require('express');
const { analyticsRepository, laboratoryMembershipRepository } = require('../repositories');
const { getActiveDataBackend } = require('../config/supabase');
const { dbState } = require('../config/db');
const { requireAuth } = require('../middleware/requireAuth');
const { isValidId } = require('../utils/idValidation');
const { parseDateRange } = require('../utils/queryParser');
const { toCsv } = require('../utils/csv');
const { logAudit } = require('../utils/audit');
const { toDayString } = require('../utils/time');

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

// RBAC: Reject student access immediately with 403 Forbidden
router.use((req, res, next) => {
  if (req.user && req.user.role === 'student') {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Administrative analytics access requires faculty or admin credentials.' },
    });
  }
  return next();
});

const ALLOWED_CATEGORIES = new Set([
  'MICROSCOPE',
  'SPECTROMETER',
  'CENTRIFUGE',
  'CHROMATOGRAPHY',
  'ELECTROCHEMISTRY',
  'THERMAL_ANALYSIS',
  'OTHER',
]);

/**
 * Resolves faculty laboratory scope and enforces isolation.
 */
async function resolveScope(req, res) {
  const role = req.user.role;
  let userLaboratories = [];

  if (role === 'faculty') {
    const memberships = await laboratoryMembershipRepository.listByUser(req.user.id || req.user._id);
    userLaboratories = (memberships || [])
      .map((m) => {
        if (typeof m.laboratoryId === 'object' && m.laboratoryId && (m.laboratoryId._id || m.laboratoryId.id)) {
          return String(m.laboratoryId._id || m.laboratoryId.id);
        }
        return String(m.laboratoryId || (m.laboratory && (m.laboratory.id || m.laboratory._id)) || '');
      })
      .filter(Boolean);

    // If faculty explicitly requests a lab they don't belong to, reject
    if (req.query.laboratoryId) {
      const requestedLab = String(req.query.laboratoryId).trim();
      if (!isValidId(requestedLab)) {
        res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid laboratoryId format.' } });
        return null;
      }
      if (!userLaboratories.includes(requestedLab)) {
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access to requested laboratory analytics is denied.' } });
        return null;
      }
    }
  } else if (role === 'admin' && req.query.laboratoryId) {
    const requestedLab = String(req.query.laboratoryId).trim();
    if (!isValidId(requestedLab)) {
      res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid laboratoryId format.' } });
      return null;
    }
  }

  return {
    role,
    userLaboratories,
    laboratoryId: req.query.laboratoryId ? String(req.query.laboratoryId).trim() : undefined,
  };
}

/**
 * Parses and computes canonical date boundaries from presets or custom bounds.
 */
function resolveDates(query) {
  const range = (query.range || '').trim().toLowerCase();
  const now = new Date();

  if (range === 'today') {
    const todayStr = toDayString(now);
    return { startDate: todayStr, endDate: todayStr, error: null };
  }
  if (range === '7d' || range === 'last7days') {
    const start = new Date(now.getTime() - 7 * 86400000);
    return { startDate: toDayString(start), endDate: toDayString(now), error: null };
  }
  if (range === '30d' || range === 'last30days') {
    const start = new Date(now.getTime() - 30 * 86400000);
    return { startDate: toDayString(start), endDate: toDayString(now), error: null };
  }
  if (range === '90d' || range === 'last90days') {
    const start = new Date(now.getTime() - 90 * 86400000);
    return { startDate: toDayString(start), endDate: toDayString(now), error: null };
  }
  if (range === 'thismonth') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { startDate: toDayString(start), endDate: toDayString(now), error: null };
  }
  if (range === 'prevmonth') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { startDate: toDayString(start), endDate: toDayString(end), error: null };
  }

  if (query.startDate || query.endDate) {
    const parsed = parseDateRange(query);
    if (parsed.error) return { startDate: null, endDate: null, error: parsed.error };
    return {
      startDate: parsed.startDate ? toDayString(new Date(parsed.startDate)) : null,
      endDate: parsed.endDate ? toDayString(new Date(parsed.endDate)) : null,
      error: null,
    };
  }

  // Default to last 30 days
  const defaultStart = new Date(now.getTime() - 30 * 86400000);
  return { startDate: toDayString(defaultStart), endDate: toDayString(now), error: null };
}

/* ============================================================================
   1. GET /overview — Operational Health Summary & Attention Items
   ============================================================================ */
router.get('/overview', async (req, res, next) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;

    const { startDate, endDate, error } = resolveDates(req.query);
    if (error) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: error } });
    }

    const data = await analyticsRepository.getOverview({
      startDate,
      endDate,
      laboratoryId: scope.laboratoryId,
      role: scope.role,
      userLaboratories: scope.userLaboratories,
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   2. GET /utilization — Instrument Utilization & Operating Capacity
   ============================================================================ */
router.get('/utilization', async (req, res, next) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;

    const { startDate, endDate, error } = resolveDates(req.query);
    if (error) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: error } });
    }

    let category = undefined;
    if (req.query.category) {
      const cat = String(req.query.category).toUpperCase().trim();
      if (!ALLOWED_CATEGORIES.has(cat)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: `Invalid category. Allowed: ${Array.from(ALLOWED_CATEGORIES).join(', ')}` },
        });
      }
      category = cat;
    }

    let instrumentId = undefined;
    if (req.query.instrumentId) {
      const iId = String(req.query.instrumentId).trim();
      if (!isValidId(iId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid instrumentId format.' } });
      }
      instrumentId = iId;
    }

    const data = await analyticsRepository.getUtilization({
      startDate,
      endDate,
      laboratoryId: scope.laboratoryId,
      category,
      instrumentId,
      role: scope.role,
      userLaboratories: scope.userLaboratories,
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   3. GET /bookings — Booking Trends & Peak Hour Distribution
   ============================================================================ */
router.get('/bookings', async (req, res, next) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;

    const { startDate, endDate, error } = resolveDates(req.query);
    if (error) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: error } });
    }

    let instrumentId = undefined;
    if (req.query.instrumentId) {
      const iId = String(req.query.instrumentId).trim();
      if (!isValidId(iId)) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid instrumentId format.' } });
      }
      instrumentId = iId;
    }

    const data = await analyticsRepository.getBookingTrends({
      startDate,
      endDate,
      laboratoryId: scope.laboratoryId,
      instrumentId,
      role: scope.role,
      userLaboratories: scope.userLaboratories,
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   4. GET /maintenance — Maintenance Downtime & Service Breakdown
   ============================================================================ */
router.get('/maintenance', async (req, res, next) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;

    const { startDate, endDate, error } = resolveDates(req.query);
    if (error) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: error } });
    }

    const data = await analyticsRepository.getMaintenanceAnalytics({
      startDate,
      endDate,
      laboratoryId: scope.laboratoryId,
      role: scope.role,
      userLaboratories: scope.userLaboratories,
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   5. GET /calibration — Calibration Compliance & Expiration Forecast
   ============================================================================ */
router.get('/calibration', async (req, res, next) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;

    const { startDate, endDate, error } = resolveDates(req.query);
    if (error) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: error } });
    }

    const data = await analyticsRepository.getCalibrationAnalytics({
      startDate,
      endDate,
      laboratoryId: scope.laboratoryId,
      role: scope.role,
      userLaboratories: scope.userLaboratories,
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   6. GET /qualifications — Qualification & Certified Operator Distribution
   ============================================================================ */
router.get('/qualifications', async (req, res, next) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;

    const data = await analyticsRepository.getQualificationAnalytics({
      laboratoryId: scope.laboratoryId,
      role: scope.role,
      userLaboratories: scope.userLaboratories,
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   7. GET /breakage — Equipment Incident Reports & Resolution Status
   ============================================================================ */
router.get('/breakage', async (req, res, next) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;

    const { startDate, endDate, error } = resolveDates(req.query);
    if (error) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: error } });
    }

    const data = await analyticsRepository.getBreakageAnalytics({
      startDate,
      endDate,
      role: scope.role,
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   8. GET /access — QR Pass Issuance & Redemption Statistics
   ============================================================================ */
router.get('/access', async (req, res, next) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;

    const { startDate, endDate, error } = resolveDates(req.query);
    if (error) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: error } });
    }

    const data = await analyticsRepository.getQrAccessAnalytics({
      startDate,
      endDate,
    });

    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   9. GET /export — RFC 4180 CSV Export with Formula Neutralization & Auditing
   ============================================================================ */
router.get('/export', async (req, res, next) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;

    const { startDate, endDate, error } = resolveDates(req.query);
    if (error) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: error } });
    }

    const type = (req.query.type || 'utilization').toLowerCase().trim();
    let csv = '';
    let recordsCount = 0;

    if (type === 'utilization') {
      const utilData = await analyticsRepository.getUtilization({
        startDate,
        endDate,
        laboratoryId: scope.laboratoryId,
        role: scope.role,
        userLaboratories: scope.userLaboratories,
      });

      const rows = (utilData.instrumentsUtilization || []).map((i) => ({
        id: i.instrumentId,
        instrumentName: i.instrumentName,
        category: i.category,
        laboratory: i.laboratoryName,
        status: i.status,
        bookedHours: i.bookedHours,
        operatingCapacityHours: i.operatingCapacityHours,
        utilizationRatePercent: i.utilizationRatePercent,
        totalBookings: i.totalBookings,
      }));

      recordsCount = rows.length;
      csv = toCsv(rows, [
        { key: 'id', label: 'Instrument ID' },
        { key: 'instrumentName', label: 'Instrument Name' },
        { key: 'category', label: 'Category' },
        { key: 'laboratory', label: 'Laboratory' },
        { key: 'status', label: 'Status' },
        { key: 'bookedHours', label: 'Booked Hours' },
        { key: 'operatingCapacityHours', label: 'Capacity Hours' },
        { key: 'utilizationRatePercent', label: 'Utilization %' },
        { key: 'totalBookings', label: 'Completed Bookings' },
      ]);
    } else if (type === 'bookings') {
      const bookData = await analyticsRepository.getBookingTrends({
        startDate,
        endDate,
        laboratoryId: scope.laboratoryId,
        role: scope.role,
        userLaboratories: scope.userLaboratories,
      });

      const rows = (bookData.timeSeries || []).map((t) => ({
        date: t.date,
        totalBookings: t.totalBookings,
        completedBookings: t.completedBookings,
        cancelledBookings: t.cancelledBookings,
        bookedHours: t.bookedHours,
      }));

      recordsCount = rows.length;
      csv = toCsv(rows, [
        { key: 'date', label: 'Date' },
        { key: 'totalBookings', label: 'Total Bookings' },
        { key: 'completedBookings', label: 'Completed Bookings' },
        { key: 'cancelledBookings', label: 'Cancelled Bookings' },
        { key: 'bookedHours', label: 'Total Hours' },
      ]);
    } else {
      // Default summary export
      const overview = await analyticsRepository.getOverview({
        startDate,
        endDate,
        laboratoryId: scope.laboratoryId,
        role: scope.role,
        userLaboratories: scope.userLaboratories,
      });

      const rows = [
        { metric: 'Availability Rate', value: `${overview.availabilityRate}%` },
        { metric: 'Available Instruments', value: overview.instruments.statusCounts.AVAILABLE || 0 },
        { metric: 'Maintenance Instruments', value: overview.instruments.statusCounts.UNDER_MAINTENANCE || 0 },
        { metric: 'Out of Order Instruments', value: overview.instruments.statusCounts.OUT_OF_ORDER || 0 },
        { metric: 'Completed Bookings', value: overview.bookings.completed || 0 },
        { metric: 'Active Bookings', value: overview.bookings.active || 0 },
        { metric: 'Cancelled Bookings', value: overview.bookings.cancelled || 0 },
        { metric: 'Open Maintenance', value: overview.maintenance.open || 0 },
        { metric: 'Overdue Calibrations', value: overview.calibrations.overdue || 0 },
        { metric: 'Pending Qualifications', value: overview.qualifications.pending || 0 },
        { metric: 'Open Breakage Incidents', value: overview.breakage.open || 0 },
      ];

      recordsCount = rows.length;
      csv = toCsv(rows, [
        { key: 'metric', label: 'Operational Metric' },
        { key: 'value', label: 'Value' },
      ]);
    }

    // Module 13 Audit Logging for Analytics Export
    await logAudit({
      userId: req.user.id || req.user._id,
      actorRole: req.user.role,
      action: 'ANALYTICS_EXPORTED',
      resource: 'analytics',
      resourceId: type,
      status: 'SUCCESS',
      laboratoryId: scope.laboratoryId || null,
      details: {
        type,
        startDate,
        endDate,
        recordsExported: recordsCount,
      },
      req,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="labpulse-analytics-${type}-${Date.now()}.csv"`);
    return res.send(csv);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
