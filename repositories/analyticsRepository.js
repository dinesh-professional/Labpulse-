/**
 * Analytics Repository (Module 15: Analytics & Operational Intelligence)
 * Provides high-performance, server-side aggregations for instrument utilization,
 * booking trends, maintenance downtime, calibration compliance, and operational health.
 * Supports Supabase PostgreSQL with fallback to MongoDB / Mongoose aggregates.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const Booking = require('../models/Booking');
const Instrument = require('../models/Instrument');
const Maintenance = require('../models/Maintenance');
const Calibration = require('../models/Calibration');
const BreakageReport = require('../models/BreakageReport');
const OperatorQualification = require('../models/OperatorQualification');
const QrAccessPass = require('../models/QrAccessPass');
const Laboratory = require('../models/Laboratory');
const { toMinutes, toDayString, parseDayUTC, dayRangeUTC, isHHMM } = require('../utils/time');
const { translateDbError } = require('../utils/dbErrors');

function computeDurationHours(startTime, endTime) {
  if (!isHHMM(startTime) || !isHHMM(endTime)) return 1.0; // default 1 hour if unspecified
  const diffMinutes = toMinutes(endTime) - toMinutes(startTime);
  return Math.max(0, diffMinutes) / 60;
}

function resolveDateBounds(startDateStr, endDateStr, defaultDays = 30) {
  const now = new Date();
  const end = endDateStr ? new Date(endDateStr) : now;
  const start = startDateStr ? new Date(startDateStr) : new Date(end.getTime() - defaultDays * 86400000);
  const startStr = toDayString(start);
  const endStr = toDayString(end);
  const daysDiff = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  return { start, end, startStr, endStr, daysDiff };
}

class AnalyticsRepository {
  /**
   * 1. Overview & Operational Health Summary
   */
  async getOverview({ startDate, endDate, laboratoryId, role, userLaboratories } = {}) {
    const { start, end, startStr, endStr, daysDiff } = resolveDateBounds(startDate, endDate, 30);
    const isSupabase = getActiveDataBackend() === 'supabase';

    // 1. Instruments Status
    let instFilter = {};
    if (laboratoryId) instFilter.laboratoryId = laboratoryId;
    if (role === 'faculty' && userLaboratories && userLaboratories.length > 0 && !laboratoryId) {
      instFilter.laboratoryId = { $in: userLaboratories };
    }

    let allInstruments = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('instruments').select('id, name, status, lifecycle_state, laboratory_id, category, next_calibration_due');
      if (laboratoryId) q = q.eq('laboratory_id', laboratoryId);
      if (role === 'faculty' && userLaboratories && userLaboratories.length > 0 && !laboratoryId) {
        q = q.in('laboratory_id', userLaboratories);
      }
      const { data, error } = await q;
      if (error) throw translateDbError(error);
      allInstruments = (data || []).map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        lifecycleState: row.lifecycle_state,
        laboratoryId: row.laboratory_id,
        category: row.category,
        nextCalibrationDue: row.next_calibration_due,
      }));
    } else {
      const mFilter = {};
      if (laboratoryId) mFilter.laboratoryId = laboratoryId;
      if (role === 'faculty' && userLaboratories && userLaboratories.length > 0 && !laboratoryId) {
        mFilter.laboratoryId = { $in: userLaboratories };
      }
      allInstruments = await Instrument.find(mFilter).lean();
    }

    const commissioned = allInstruments.filter(
      (i) => i.lifecycleState !== 'RETIRED' && i.lifecycleState !== 'DECOMMISSIONED'
    );
    const totalCommissioned = commissioned.length;

    const instStatusCounts = {
      AVAILABLE: 0,
      UNDER_MAINTENANCE: 0,
      UNDER_CALIBRATION: 0,
      OUT_OF_ORDER: 0,
      LOCKED: 0,
    };
    commissioned.forEach((i) => {
      if (instStatusCounts[i.status] !== undefined) {
        instStatusCounts[i.status] += 1;
      }
    });

    const availabilityRate = totalCommissioned > 0
      ? Math.round((instStatusCounts.AVAILABLE / totalCommissioned) * 1000) / 10
      : 0;

    // 2. Bookings in Period
    let bookings = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('bookings').select('id, instrument_id, status, date, start_time, end_time, purpose');
      q = q.gte('date', startStr).lte('date', endStr);
      const { data, error } = await q;
      if (error) throw translateDbError(error);
      bookings = (data || []).map((b) => ({
        id: b.id,
        instrumentId: b.instrument_id,
        status: b.status,
        date: b.date,
        startTime: b.start_time,
        endTime: b.end_time,
        purpose: b.purpose,
      }));
    } else {
      const bFilter = { date: { $gte: start, $lte: end } };
      bookings = await Booking.find(bFilter).lean();
    }

    // Filter bookings by lab if required
    if (laboratoryId || (role === 'faculty' && userLaboratories && userLaboratories.length > 0)) {
      const allowedInstIds = new Set(allInstruments.map((i) => String(i.id || i._id)));
      bookings = bookings.filter((b) => allowedInstIds.has(String(b.instrumentId && (b.instrumentId._id || b.instrumentId.id || b.instrumentId))));
    }

    const bookingStatusCounts = {
      CONFIRMED: 0,
      COMPLETED: 0,
      CHECKED_IN: 0,
      PENDING_APPROVAL: 0,
      CANCELLED: 0,
      REJECTED: 0,
      NO_SHOW: 0,
    };
    bookings.forEach((b) => {
      if (bookingStatusCounts[b.status] !== undefined) {
        bookingStatusCounts[b.status] += 1;
      }
    });

    const activeBookingsCount = (bookingStatusCounts.CONFIRMED || 0) + (bookingStatusCounts.CHECKED_IN || 0) + (bookingStatusCounts.COMPLETED || 0);
    const totalBookings = bookings.length;
    const completedOrConfirmed = activeBookingsCount;
    const completionRate = totalBookings > 0
      ? Math.round((bookingStatusCounts.COMPLETED / totalBookings) * 1000) / 10
      : 0;

    // 3. Maintenance Counts
    let maintenanceList = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('maintenance').select('id, instrument_id, status, type, start_date, end_date');
      q = q.gte('start_date', startStr).lte('start_date', endStr);
      const { data, error } = await q;
      if (!error && data) {
        maintenanceList = data.map((m) => ({
          id: m.id,
          instrumentId: m.instrument_id,
          status: m.status,
          type: m.type,
          startDate: m.start_date,
          endDate: m.end_date,
        }));
      }
    } else {
      maintenanceList = await Maintenance.find({ startDate: { $gte: start, $lte: end } }).lean();
    }

    const openMaintenance = maintenanceList.filter((m) => m.status === 'SCHEDULED' || m.status === 'IN_PROGRESS').length;
    const completedMaintenance = maintenanceList.filter((m) => m.status === 'COMPLETED').length;
    const preventiveCount = maintenanceList.filter((m) => m.type === 'preventive').length;
    const correctiveCount = maintenanceList.filter((m) => m.type === 'corrective').length;

    // 4. Calibration Compliance
    const todayStr = toDayString(new Date());
    let overdueCalibrationsCount = 0;
    let dueSoonCalibrationsCount = 0;
    const in30DaysStr = toDayString(new Date(Date.now() + 30 * 86400000));

    commissioned.forEach((inst) => {
      if (inst.status === 'UNDER_CALIBRATION') {
        overdueCalibrationsCount += 1;
      } else if (inst.nextCalibrationDue) {
        const dueStr = toDayString(inst.nextCalibrationDue);
        if (dueStr < todayStr) {
          overdueCalibrationsCount += 1;
        } else if (dueStr <= in30DaysStr) {
          dueSoonCalibrationsCount += 1;
        }
      }
    });

    const compliantCalibrations = Math.max(0, totalCommissioned - overdueCalibrationsCount);
    const calibrationComplianceRate = totalCommissioned > 0
      ? Math.round((compliantCalibrations / totalCommissioned) * 1000) / 10
      : 100;

    // 5. Qualifications
    let qualPending = 0;
    let qualActive = 0;
    let qualExpired = 0;
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      const { data: qData } = await client.from('operator_qualifications').select('id, status, expires_at');
      (qData || []).forEach((q) => {
        if (q.status === 'PENDING') qualPending += 1;
        else if (q.status === 'ACTIVE') {
          if (q.expires_at && toDayString(q.expires_at) < todayStr) qualExpired += 1;
          else qualActive += 1;
        } else if (q.status === 'EXPIRED') qualExpired += 1;
      });
    } else {
      const qList = await OperatorQualification.find({}).lean();
      qList.forEach((q) => {
        if (q.status === 'PENDING') qualPending += 1;
        else if (q.status === 'ACTIVE') {
          if (q.expiresAt && toDayString(q.expiresAt) < todayStr) qualExpired += 1;
          else qualActive += 1;
        } else if (q.status === 'EXPIRED') qualExpired += 1;
      });
    }

    // 6. Breakage Incidents
    let breakageReports = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      const { data: bData } = await client.from('breakage_reports').select('id, status, severity, breakage_fee, created_at');
      breakageReports = bData || [];
    } else {
      breakageReports = await BreakageReport.find({}).lean();
    }
    const openBreakage = breakageReports.filter((r) => r.status === 'REPORTED' || r.status === 'UNDER_REVIEW').length;
    const resolvedBreakage = breakageReports.filter((r) => r.status === 'RESOLVED').length;
    const totalBreakageFees = role === 'admin'
      ? breakageReports.reduce((acc, r) => acc + (Number(r.breakageFee || r.breakage_fee) || 0), 0)
      : undefined;

    // 7. Attention Required (Actionable Operational Insights)
    const attentionItems = [];
    if (overdueCalibrationsCount > 0) {
      attentionItems.push({
        type: 'CALIBRATION_OVERDUE',
        severity: 'HIGH',
        count: overdueCalibrationsCount,
        title: `${overdueCalibrationsCount} Instrument${overdueCalibrationsCount > 1 ? 's' : ''} Overdue for Calibration`,
        message: 'Metrology compliance window expired. Schedule recalibration to restore operational safety.',
        drillDownSection: 'calibrations',
      });
    }
    if (instStatusCounts.OUT_OF_ORDER > 0 || instStatusCounts.LOCKED > 0) {
      const downCount = instStatusCounts.OUT_OF_ORDER + instStatusCounts.LOCKED;
      attentionItems.push({
        type: 'INSTRUMENTS_DOWN',
        severity: 'HIGH',
        count: downCount,
        title: `${downCount} Instrument${downCount > 1 ? 's' : ''} Out of Order or Locked`,
        message: 'Equipment flagged unavailable for operations due to breakdown or safety lockout.',
        drillDownSection: 'instruments',
      });
    }
    if (qualPending > 0) {
      attentionItems.push({
        type: 'QUALIFICATIONS_PENDING',
        severity: 'MEDIUM',
        count: qualPending,
        title: `${qualPending} Qualification Application${qualPending > 1 ? 's' : ''} Pending Review`,
        message: 'Operator verification queue requires faculty or admin authorization.',
        drillDownSection: 'qualifications',
      });
    }
    if (openBreakage > 0) {
      attentionItems.push({
        type: 'BREAKAGE_OPEN',
        severity: 'MEDIUM',
        count: openBreakage,
        title: `${openBreakage} Open Equipment Damage Incident${openBreakage > 1 ? 's' : ''}`,
        message: 'Breakdowns reported requiring review, damage assessment, or maintenance dispatch.',
        drillDownSection: 'breakage',
      });
    }
    if (bookingStatusCounts.PENDING_APPROVAL > 0) {
      attentionItems.push({
        type: 'BOOKINGS_PENDING',
        severity: 'LOW',
        count: bookingStatusCounts.PENDING_APPROVAL,
        title: `${bookingStatusCounts.PENDING_APPROVAL} Reservation Request${bookingStatusCounts.PENDING_APPROVAL > 1 ? 's' : ''} Awaiting Approval`,
        message: 'Pending student equipment bookings in the approval queue.',
        drillDownSection: 'bookings',
      });
    }

    return {
      window: {
        startDate: startStr,
        endDate: endStr,
        days: daysDiff,
      },
      equipment: {
        totalCommissioned,
        availabilityRate,
        statusBreakdown: instStatusCounts,
      },
      bookings: {
        total: totalBookings,
        active: activeBookingsCount,
        completed: bookingStatusCounts.COMPLETED,
        cancelled: bookingStatusCounts.CANCELLED,
        pending: bookingStatusCounts.PENDING_APPROVAL,
        rejected: bookingStatusCounts.REJECTED,
        noShow: bookingStatusCounts.NO_SHOW,
        completionRate,
      },
      maintenance: {
        open: openMaintenance,
        completed: completedMaintenance,
        preventive: preventiveCount,
        corrective: correctiveCount,
      },
      calibration: {
        totalRequiringCalibration: totalCommissioned,
        compliant: compliantCalibrations,
        dueSoon: dueSoonCalibrationsCount,
        overdue: overdueCalibrationsCount,
        complianceRate: calibrationComplianceRate,
      },
      qualifications: {
        active: qualActive,
        pending: qualPending,
        expired: qualExpired,
      },
      breakage: {
        open: openBreakage,
        resolved: resolvedBreakage,
        ...(totalBreakageFees !== undefined ? { totalFees: totalBreakageFees } : {}),
      },
      attentionItems,
    };
  }

  /**
   * 2. Instrument Utilization Analytics
   */
  async getUtilization({ startDate, endDate, laboratoryId, category } = {}) {
    const { start, end, startStr, endStr, daysDiff } = resolveDateBounds(startDate, endDate, 30);
    const isSupabase = getActiveDataBackend() === 'supabase';

    // Fetch commissioned instruments
    let instruments = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('instruments').select('id, name, model, category, status, lifecycle_state, laboratory_id');
      if (laboratoryId) q = q.eq('laboratory_id', laboratoryId);
      if (category) q = q.eq('category', category);
      const { data, error } = await q;
      if (error) throw translateDbError(error);
      instruments = (data || []).filter((i) => i.lifecycle_state !== 'RETIRED' && i.lifecycle_state !== 'DECOMMISSIONED');
    } else {
      const mFilter = { lifecycleState: { $nin: ['RETIRED', 'DECOMMISSIONED'] } };
      if (laboratoryId) mFilter.laboratoryId = laboratoryId;
      if (category) mFilter.category = category;
      instruments = await Instrument.find(mFilter).lean();
    }

    const instMap = new Map();
    instruments.forEach((i) => {
      const iId = String(i.id || i._id);
      instMap.set(iId, {
        instrumentId: iId,
        name: i.name,
        category: i.category || 'General',
        model: i.model || 'Standard',
        laboratoryId: i.laboratory_id || i.laboratoryId,
        bookedMinutes: 0,
        bookedHours: 0,
        sessionCount: 0,
        utilizationPercent: 0,
      });
    });

    // Fetch bookings in window
    let bookings = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('bookings').select('id, instrument_id, status, date, start_time, end_time');
      q = q.gte('date', startStr).lte('date', endStr).in('status', ['COMPLETED', 'CONFIRMED', 'CHECKED_IN']);
      const { data, error } = await q;
      if (!error && data) bookings = data;
    } else {
      bookings = await Booking.find({
        date: { $gte: start, $lte: end },
        status: { $in: ['COMPLETED', 'CONFIRMED', 'CHECKED_IN'] },
      }).lean();
    }

    // Operating hours assumption: 10 operating hours/day (08:00 - 18:00) = 600 min/day
    const operatingCapacityMinutesPerInstrument = daysDiff * 10 * 60;
    const totalOperatingCapacityHours = (instruments.length * daysDiff * 10);

    let totalBookedMinutes = 0;
    bookings.forEach((b) => {
      const iId = String(b.instrumentId && (b.instrumentId._id || b.instrumentId.id || b.instrumentId) || b.instrument_id);
      const instStat = instMap.get(iId);
      if (instStat) {
        const sTime = b.startTime || b.start_time;
        const eTime = b.endTime || b.end_time;
        const mins = (isHHMM(sTime) && isHHMM(eTime))
          ? Math.max(0, toMinutes(eTime) - toMinutes(sTime))
          : 60;
        instStat.bookedMinutes += mins;
        instStat.sessionCount += 1;
        totalBookedMinutes += mins;
      }
    });

    // Calculate per-instrument utilization
    const instrumentList = Array.from(instMap.values()).map((item) => {
      item.bookedHours = Math.round((item.bookedMinutes / 60) * 10) / 10;
      item.utilizationPercent = operatingCapacityMinutesPerInstrument > 0
        ? Math.min(100, Math.round((item.bookedMinutes / operatingCapacityMinutesPerInstrument) * 1000) / 10)
        : 0;
      delete item.bookedMinutes;
      return item;
    });

    instrumentList.sort((a, b) => b.bookedHours - a.bookedHours);

    const totalBookedHours = Math.round((totalBookedMinutes / 60) * 10) / 10;
    const overallUtilizationPercent = totalOperatingCapacityHours > 0
      ? Math.min(100, Math.round((totalBookedHours / totalOperatingCapacityHours) * 1000) / 10)
      : 0;

    const topUtilized = instrumentList.filter((i) => i.bookedHours > 0).slice(0, 5);
    const activeInstrumentsList = instrumentList.filter((i) => i.bookedHours > 0);
    const leastUtilized = [...activeInstrumentsList].reverse().slice(0, 5);
    const idleInstruments = instrumentList.filter((i) => i.sessionCount === 0);

    // Grouping by Category
    const categoryAgg = {};
    instrumentList.forEach((i) => {
      const cat = i.category || 'Unassigned';
      if (!categoryAgg[cat]) {
        categoryAgg[cat] = { category: cat, instrumentCount: 0, bookedHours: 0, sessionCount: 0 };
      }
      categoryAgg[cat].instrumentCount += 1;
      categoryAgg[cat].bookedHours += i.bookedHours;
      categoryAgg[cat].sessionCount += i.sessionCount;
    });
    const utilizationByCategory = Object.values(categoryAgg).map((c) => {
      const catCapacity = c.instrumentCount * daysDiff * 10;
      c.bookedHours = Math.round(c.bookedHours * 10) / 10;
      c.utilizationPercent = catCapacity > 0 ? Math.min(100, Math.round((c.bookedHours / catCapacity) * 1000) / 10) : 0;
      return c;
    });

    return {
      window: { startDate: startStr, endDate: endStr, days: daysDiff },
      metrics: {
        totalInstruments: instruments.length,
        activeInstruments: activeInstrumentsList.length,
        idleInstrumentsCount: idleInstruments.length,
        totalBookedHours,
        totalOperatingCapacityHours,
        overallUtilizationPercent,
      },
      topUtilized,
      leastUtilized,
      idleInstruments: idleInstruments.slice(0, 10).map((i) => ({ id: i.instrumentId, name: i.name, category: i.category })),
      utilizationByCategory,
    };
  }

  /**
   * 3. Booking Trends & Peak Usage Distribution
   */
  async getBookingTrends({ startDate, endDate, laboratoryId, instrumentId } = {}) {
    const { start, end, startStr, endStr, daysDiff } = resolveDateBounds(startDate, endDate, 30);
    const isSupabase = getActiveDataBackend() === 'supabase';

    let bookings = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('bookings').select('id, instrument_id, status, date, start_time, end_time');
      q = q.gte('date', startStr).lte('date', endStr);
      if (instrumentId) q = q.eq('instrument_id', instrumentId);
      const { data, error } = await q;
      if (!error && data) bookings = data;
    } else {
      const bFilter = { date: { $gte: start, $lte: end } };
      if (instrumentId) bFilter.instrumentId = instrumentId;
      bookings = await Booking.find(bFilter).lean();
    }

    // Day-by-day buckets
    const bucketMap = new Map();
    // Pre-populate each day in window
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dStr = toDayString(d);
      bucketMap.set(dStr, {
        date: dStr,
        total: 0,
        completed: 0,
        confirmed: 0,
        pending: 0,
        cancelled: 0,
        rejected: 0,
      });
    }

    // Hourly buckets (08:00 to 18:00)
    const hourlyPeak = {};
    for (let h = 8; h <= 18; h++) {
      const hourLabel = `${String(h).padStart(2, '0')}:00`;
      hourlyPeak[hourLabel] = 0;
    }

    bookings.forEach((b) => {
      const dStr = toDayString(b.date);
      const bucket = bucketMap.get(dStr);
      if (bucket) {
        bucket.total += 1;
        const st = b.status;
        if (st === 'COMPLETED') bucket.completed += 1;
        else if (st === 'CONFIRMED' || st === 'CHECKED_IN') bucket.confirmed += 1;
        else if (st === 'PENDING_APPROVAL') bucket.pending += 1;
        else if (st === 'CANCELLED') bucket.cancelled += 1;
        else if (st === 'REJECTED') bucket.rejected += 1;
      }

      // Check peak hours for active bookings
      if (['COMPLETED', 'CONFIRMED', 'CHECKED_IN'].includes(b.status)) {
        const sTime = b.startTime || b.start_time;
        if (isHHMM(sTime)) {
          const sHour = parseInt(sTime.split(':')[0], 10);
          if (sHour >= 8 && sHour <= 18) {
            const hKey = `${String(sHour).padStart(2, '0')}:00`;
            hourlyPeak[hKey] = (hourlyPeak[hKey] || 0) + 1;
          }
        }
      }
    });

    const series = Array.from(bucketMap.values());
    const peakHours = Object.keys(hourlyPeak).map((hour) => ({ hour, sessionCount: hourlyPeak[hour] }));

    return {
      window: { startDate: startStr, endDate: endStr, days: daysDiff },
      totalBookings: bookings.length,
      series,
      peakHours,
    };
  }

  /**
   * 4. Maintenance & Equipment Downtime Analytics
   */
  async getMaintenanceAnalytics({ startDate, endDate, laboratoryId } = {}) {
    const { start, end, startStr, endStr, daysDiff } = resolveDateBounds(startDate, endDate, 30);
    const isSupabase = getActiveDataBackend() === 'supabase';

    let maintenanceRecords = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('maintenance').select('id, instrument_id, type, status, start_date, end_date, start_time, end_time, description');
      q = q.gte('start_date', startStr).lte('start_date', endStr);
      const { data, error } = await q;
      if (!error && data) maintenanceRecords = data;
    } else {
      maintenanceRecords = await Maintenance.find({ startDate: { $gte: start, $lte: end } }).populate('instrumentId', 'name category').lean();
    }

    let totalDowntimeHours = 0;
    const typeDistribution = { preventive: 0, corrective: 0 };
    const statusDistribution = { SCHEDULED: 0, IN_PROGRESS: 0, COMPLETED: 0, CANCELLED: 0 };
    const instMaintMap = new Map();

    maintenanceRecords.forEach((m) => {
      if (typeDistribution[m.type] !== undefined) typeDistribution[m.type] += 1;
      if (statusDistribution[m.status] !== undefined) statusDistribution[m.status] += 1;

      // Downtime calculation: days * 10 operating hours/day or specific hours
      const sDateStr = toDayString(m.startDate || m.start_date);
      const eDateStr = m.endDate || m.end_date ? toDayString(m.endDate || m.end_date) : sDateStr;
      const sDay = parseDayUTC(sDateStr);
      const eDay = parseDayUTC(eDateStr);
      const mDays = (sDay && eDay) ? Math.max(1, Math.round((eDay - sDay) / 86400000) + 1) : 1;
      const hours = mDays * 10;
      totalDowntimeHours += hours;

      const iId = String(m.instrumentId && (m.instrumentId._id || m.instrumentId.id || m.instrumentId) || m.instrument_id);
      const iName = (m.instrumentId && m.instrumentId.name) || iId;
      if (!instMaintMap.has(iId)) {
        instMaintMap.set(iId, { instrumentId: iId, name: iName, count: 0, downtimeHours: 0 });
      }
      const entry = instMaintMap.get(iId);
      entry.count += 1;
      entry.downtimeHours += hours;
    });

    const mostMaintained = Array.from(instMaintMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      window: { startDate: startStr, endDate: endStr, days: daysDiff },
      totalEvents: maintenanceRecords.length,
      totalDowntimeHours,
      typeDistribution,
      statusDistribution,
      mostMaintained,
    };
  }

  /**
   * 5. Calibration Compliance Analytics
   */
  async getCalibrationAnalytics({ startDate, endDate, laboratoryId } = {}) {
    const isSupabase = getActiveDataBackend() === 'supabase';

    let instruments = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('instruments').select('id, name, status, lifecycle_state, next_calibration_due');
      if (laboratoryId) q = q.eq('laboratory_id', laboratoryId);
      const { data, error } = await q;
      if (!error && data) instruments = data.filter((i) => i.lifecycle_state !== 'RETIRED');
    } else {
      const mFilter = { lifecycleState: { $nin: ['RETIRED', 'DECOMMISSIONED'] } };
      if (laboratoryId) mFilter.laboratoryId = laboratoryId;
      instruments = await Instrument.find(mFilter).lean();
    }

    const todayStr = toDayString(new Date());
    const in7DaysStr = toDayString(new Date(Date.now() + 7 * 86400000));
    const in14DaysStr = toDayString(new Date(Date.now() + 14 * 86400000));
    const in30DaysStr = toDayString(new Date(Date.now() + 30 * 86400000));

    let overdueCount = 0;
    let due7Count = 0;
    let due14Count = 0;
    let due30Count = 0;
    let compliantCount = 0;

    instruments.forEach((i) => {
      const nextDue = i.nextCalibrationDue || i.next_calibration_due;
      if (i.status === 'UNDER_CALIBRATION') {
        overdueCount += 1;
      } else if (nextDue) {
        const dStr = toDayString(nextDue);
        if (dStr < todayStr) {
          overdueCount += 1;
        } else {
          compliantCount += 1;
          if (dStr <= in7DaysStr) due7Count += 1;
          else if (dStr <= in14DaysStr) due14Count += 1;
          else if (dStr <= in30DaysStr) due30Count += 1;
        }
      } else {
        compliantCount += 1;
      }
    });

    const total = instruments.length;
    const complianceRate = total > 0 ? Math.round((compliantCount / total) * 1000) / 10 : 100;

    return {
      totalInstruments: total,
      compliantCount,
      overdueCount,
      complianceRate,
      forecast: {
        dueNext7Days: due7Count,
        dueNext14Days: due14Count,
        dueNext30Days: due30Count,
      },
    };
  }

  /**
   * 6. Operator Qualification Analytics
   */
  async getQualificationAnalytics({ laboratoryId } = {}) {
    const isSupabase = getActiveDataBackend() === 'supabase';
    const todayStr = toDayString(new Date());
    const in30DaysStr = toDayString(new Date(Date.now() + 30 * 86400000));

    let quals = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('operator_qualifications').select('id, user_id, instrument_id, level, status, expires_at');
      if (!error && data) quals = data;
    } else {
      quals = await OperatorQualification.find({}).lean();
    }

    const statusCounts = { ACTIVE: 0, PENDING: 0, EXPIRED: 0, SUSPENDED: 0, REVOKED: 0 };
    const levelCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let expiringSoonCount = 0;

    quals.forEach((q) => {
      const st = q.status;
      const exp = q.expiresAt || q.expires_at;
      const lvl = q.level;
      if (levelCounts[lvl] !== undefined) levelCounts[lvl] += 1;

      if (st === 'ACTIVE') {
        if (exp && toDayString(exp) < todayStr) {
          statusCounts.EXPIRED += 1;
        } else {
          statusCounts.ACTIVE += 1;
          if (exp && toDayString(exp) <= in30DaysStr) {
            expiringSoonCount += 1;
          }
        }
      } else if (statusCounts[st] !== undefined) {
        statusCounts[st] += 1;
      }
    });

    return {
      totalQualifications: quals.length,
      statusCounts,
      levelCounts,
      expiringSoonCount,
    };
  }

  /**
   * 7. Breakage & Incident Analytics
   */
  async getBreakageAnalytics({ startDate, endDate, role } = {}) {
    const { start, end, startStr, endStr, daysDiff } = resolveDateBounds(startDate, endDate, 30);
    const isSupabase = getActiveDataBackend() === 'supabase';

    let reports = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('breakage_reports').select('id, instrument_id, severity, status, breakage_fee, created_at');
      q = q.gte('created_at', `${startStr}T00:00:00Z`).lte('created_at', `${endStr}T23:59:59Z`);
      const { data, error } = await q;
      if (!error && data) reports = data;
    } else {
      reports = await BreakageReport.find({ createdAt: { $gte: start, $lte: end } }).lean();
    }

    const severityCounts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    const statusCounts = { REPORTED: 0, UNDER_REVIEW: 0, CONFIRMED: 0, RESOLVED: 0, REJECTED: 0 };
    let totalAssessedFees = 0;

    reports.forEach((r) => {
      if (severityCounts[r.severity] !== undefined) severityCounts[r.severity] += 1;
      if (statusCounts[r.status] !== undefined) statusCounts[r.status] += 1;
      totalAssessedFees += (Number(r.breakageFee || r.breakage_fee) || 0);
    });

    const openCount = (statusCounts.REPORTED || 0) + (statusCounts.UNDER_REVIEW || 0);

    return {
      window: { startDate: startStr, endDate: endStr, days: daysDiff },
      totalIncidents: reports.length,
      openIncidents: openCount,
      resolvedIncidents: statusCounts.RESOLVED || 0,
      severityCounts,
      statusCounts,
      ...(role === 'admin' ? { totalAssessedFees } : {}),
    };
  }

  /**
   * 8. QR Terminal Access Analytics
   */
  async getQrAccessAnalytics({ startDate, endDate } = {}) {
    const { start, end, startStr, endStr, daysDiff } = resolveDateBounds(startDate, endDate, 30);
    const isSupabase = getActiveDataBackend() === 'supabase';

    let passes = [];
    if (isSupabase) {
      const client = getSupabaseAdminClient();
      let q = client.from('qr_access_passes').select('id, status, created_at, checked_in_at');
      q = q.gte('created_at', `${startStr}T00:00:00Z`).lte('created_at', `${endStr}T23:59:59Z`);
      const { data, error } = await q;
      if (!error && data) passes = data;
    } else {
      passes = await QrAccessPass.find({ createdAt: { $gte: start, $lte: end } }).lean();
    }

    const statusCounts = { ISSUED: 0, REDEEMED: 0, EXPIRED: 0, REVOKED: 0 };
    passes.forEach((p) => {
      if (statusCounts[p.status] !== undefined) statusCounts[p.status] += 1;
    });

    const total = passes.length;
    const redemptionRate = total > 0 ? Math.round((statusCounts.REDEEMED / total) * 1000) / 10 : 0;

    return {
      window: { startDate: startStr, endDate: endStr, days: daysDiff },
      totalPassesIssued: total,
      redeemed: statusCounts.REDEEMED,
      expired: statusCounts.EXPIRED,
      revoked: statusCounts.REVOKED,
      redemptionRate,
    };
  }
}

module.exports = new AnalyticsRepository();
