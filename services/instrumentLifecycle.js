/**
 * Authoritative Instrument Lifecycle, Availability & Service Authorization Engine (Module 08)
 * Integrates lifecycle states, operational restrictions, metrology calibration gates,
 * maintenance windows, breakdown reporting, and affected booking flagging workflows.
 */
const {
  instrumentRepository,
  bookingRepository,
  calibrationRepository,
  maintenanceRepository,
  breakageRepository,
  laboratoryRepository,
  auditRepository,
} = require('../repositories');
const { logAudit } = require('../utils/audit');
const { notifyUser } = require('../services/notify');
const { toDayString, parseDayUTC } = require('../utils/time');

const LIFECYCLE_STATES = {
  COMMISSIONED: 'COMMISSIONED',
  DECOMMISSIONED: 'DECOMMISSIONED',
  RETIRED: 'RETIRED',
  DISPOSED: 'DISPOSED',
};

const OPERATIONAL_STATUSES = {
  AVAILABLE: 'AVAILABLE',
  IN_SESSION: 'IN_SESSION',
  UNDER_CALIBRATION: 'UNDER_CALIBRATION',
  UNDER_MAINTENANCE: 'UNDER_MAINTENANCE',
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  LOCKED: 'LOCKED',
};

const LIFECYCLE_TRANSITIONS = {
  COMMISSIONED: ['DECOMMISSIONED', 'RETIRED'],
  DECOMMISSIONED: ['COMMISSIONED', 'RETIRED', 'DISPOSED'],
  RETIRED: ['COMMISSIONED', 'DISPOSED'],
  DISPOSED: [], // Terminal lifecycle state
};

const OPERATIONAL_TRANSITIONS = {
  AVAILABLE: ['IN_SESSION', 'UNDER_CALIBRATION', 'UNDER_MAINTENANCE', 'OUT_OF_ORDER', 'LOCKED'],
  IN_SESSION: ['AVAILABLE', 'OUT_OF_ORDER', 'LOCKED'],
  UNDER_CALIBRATION: ['AVAILABLE', 'OUT_OF_ORDER', 'LOCKED'],
  UNDER_MAINTENANCE: ['AVAILABLE', 'UNDER_CALIBRATION', 'OUT_OF_ORDER', 'LOCKED'],
  OUT_OF_ORDER: ['AVAILABLE', 'UNDER_MAINTENANCE', 'UNDER_CALIBRATION', 'LOCKED'],
  LOCKED: ['AVAILABLE', 'OUT_OF_ORDER', 'UNDER_MAINTENANCE'],
};

const OPEN_BREAKAGE_STATUSES = ['REPORTED', 'UNDER_REVIEW', 'CONFIRMED'];
const ACTIVE_BOOKING_STATUSES = ['CONFIRMED', 'PENDING_APPROVAL'];

/**
 * Validates a lifecycle state change attempt.
 */
function validateLifecycleTransition(currentState, targetState, user) {
  if (!user || user.role !== 'admin') {
    return { valid: false, status: 403, code: 'FORBIDDEN', message: 'Only administrators can modify instrument lifecycle state.' };
  }
  if (!Object.values(LIFECYCLE_STATES).includes(targetState)) {
    return { valid: false, status: 400, code: 'VALIDATION_ERROR', message: `Invalid lifecycleState: ${targetState}` };
  }
  if (currentState === targetState) {
    return { valid: true };
  }
  const allowed = LIFECYCLE_TRANSITIONS[currentState] || [];
  if (!allowed.includes(targetState)) {
    return {
      valid: false,
      status: 422,
      code: 'INVALID_LIFECYCLE_TRANSITION',
      message: `Cannot transition instrument lifecycle from ${currentState} to ${targetState}.`,
    };
  }
  return { valid: true };
}

/**
 * Validates an operational status transition attempt.
 */
async function validateOperationalTransition(instrument, targetStatus, user) {
  const currentStatus = instrument.status;
  if (!Object.values(OPERATIONAL_STATUSES).includes(targetStatus)) {
    return { valid: false, status: 400, code: 'VALIDATION_ERROR', message: `Invalid status: ${targetStatus}` };
  }
  if (currentStatus === targetStatus) {
    return { valid: true };
  }
  const allowed = OPERATIONAL_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    return {
      valid: false,
      status: 422,
      code: 'INVALID_STATUS_TRANSITION',
      message: `Cannot transition instrument status from ${currentStatus} to ${targetStatus}.`,
    };
  }

  // If returning to AVAILABLE, strictly verify no active blockers
  if (targetStatus === 'AVAILABLE') {
    if (user.role !== 'admin') {
      return { valid: false, status: 403, code: 'FORBIDDEN', message: 'Only administrators can return an instrument to AVAILABLE status.' };
    }
    if (instrument.lifecycleState && instrument.lifecycleState !== 'COMMISSIONED') {
      return {
        valid: false,
        status: 422,
        code: 'INSTRUMENT_NOT_COMMISSIONED',
        message: `Instrument is in lifecycle state ${instrument.lifecycleState} and cannot be marked AVAILABLE.`,
      };
    }
    const instId = instrument.id || instrument._id;
    const [openBreak, inProgMaint, underCal] = await Promise.all([
      breakageRepository.count({ instrumentId: instId, statusIn: OPEN_BREAKAGE_STATUSES }),
      maintenanceRepository.count({ instrumentId: instId, status: 'IN_PROGRESS' }),
      calibrationRepository.count({ instrumentId: instId, status: 'UNDER_CALIBRATION' }),
    ]);

    if (openBreak > 0) {
      return { valid: false, status: 422, code: 'UNRESOLVED_BREAKAGE', message: 'Cannot mark AVAILABLE: unresolved breakage reports exist.' };
    }
    if (inProgMaint > 0) {
      return { valid: false, status: 422, code: 'MAINTENANCE_IN_PROGRESS', message: 'Cannot mark AVAILABLE: maintenance is currently in progress.' };
    }
    if (underCal > 0) {
      return { valid: false, status: 422, code: 'CALIBRATION_IN_PROGRESS', message: 'Cannot mark AVAILABLE: calibration is currently in progress.' };
    }
  }

  return { valid: true };
}

/**
 * Checks authoritative booking eligibility for an instrument.
 */
async function checkInstrumentBookingEligibility(instrument, user, bookingDateStr, startTime, endTime) {
  // 1. Lifecycle State Gate
  const lifecycle = instrument.lifecycleState || 'COMMISSIONED';
  if (lifecycle !== 'COMMISSIONED') {
    const codeMap = {
      DECOMMISSIONED: 'INSTRUMENT_DECOMMISSIONED',
      RETIRED: 'INSTRUMENT_RETIRED',
      DISPOSED: 'INSTRUMENT_DISPOSED',
    };
    return {
      eligible: false,
      status: 422,
      code: codeMap[lifecycle] || 'INSTRUMENT_NOT_COMMISSIONED',
      message: `Instrument is ${lifecycle.toLowerCase()} and cannot be reserved.`,
    };
  }

  // 2. Operational Status Gate
  if (instrument.status !== 'AVAILABLE') {
    const statusMap = {
      OUT_OF_ORDER: { code: 'INSTRUMENT_OUT_OF_ORDER', message: 'Instrument is out of order (breakdown reported). Booking disabled.' },
      LOCKED: { code: 'INSTRUMENT_LOCKED', message: 'Instrument is locked out. Booking disabled.' },
      UNDER_MAINTENANCE: { code: 'INSTRUMENT_UNDER_MAINTENANCE', message: 'Instrument is under maintenance. Booking disabled.' },
      UNDER_CALIBRATION: { code: 'INSTRUMENT_UNDER_CALIBRATION', message: 'Instrument is under calibration. Booking disabled.' },
      IN_SESSION: { code: 'INSTRUMENT_IN_SESSION', message: 'Instrument is currently in use.' },
    };
    const block = statusMap[instrument.status] || { code: 'INSTRUMENT_UNAVAILABLE', message: 'Instrument is currently unavailable.' };
    return { eligible: false, status: 422, ...block };
  }

  // 3. Operational Restrictions / Unavailability Reason
  if (instrument.unavailabilityReason) {
    return {
      eligible: false,
      status: 422,
      code: 'OPERATIONAL_RESTRICTION',
      message: `Instrument restriction: ${instrument.unavailabilityReason}`,
    };
  }

  const instId = instrument.id || instrument._id;
  const todayStr = toDayString(new Date());
  const checkDateStr = bookingDateStr || todayStr;

  // 4. Metrology & Calibration Validity Gate
  if (instrument.nextCalibrationDue) {
    const dueStr = toDayString(instrument.nextCalibrationDue);
    if (dueStr < checkDateStr) {
      return {
        eligible: false,
        status: 422,
        code: 'CALIBRATION_OVERDUE',
        message: `Instrument calibration became overdue on ${dueStr}. Metrology re-certification is required prior to booking.`,
      };
    }
  }

  // 5. Unresolved Breakage / Safety Reports Gate
  const openBreak = await breakageRepository.count({ instrumentId: instId, statusIn: OPEN_BREAKAGE_STATUSES });
  if (openBreak > 0) {
    return {
      eligible: false,
      status: 422,
      code: 'INSTRUMENT_OUT_OF_ORDER',
      message: 'Instrument has open unresolved incident reports. Booking disabled until authorized return to service.',
    };
  }

  // 6. Laboratory Operating Status Gate
  if (instrument.laboratoryId) {
    const lab = await laboratoryRepository.findById(instrument.laboratoryId);
    if (lab && lab.status !== 'AVAILABLE') {
      return {
        eligible: false,
        status: 422,
        code: 'LABORATORY_UNAVAILABLE',
        message: `Laboratory ${lab.name} is currently ${lab.status.toLowerCase()}. Reservations are paused.`,
      };
    }
  }

  return { eligible: true };
}

/**
 * Finds future active bookings affected when an instrument becomes unavailable.
 */
async function findAffectedBookings(instrumentId, fromDate = toDayString(new Date())) {
  return bookingRepository.list(
    {
      instrumentId,
      dateGte: fromDate,
      statusIn: ACTIVE_BOOKING_STATUSES,
    },
    { limit: 200 }
  );
}

/**
 * Handles instrument transition into an unavailable state:
 * - Updates status & records restriction reason
 * - Identifies all future bookings affected
 * - Dispatches notifications to affected bookers
 * - Records audit trail for review/rescheduling workflow without silent deletion
 */
async function handleInstrumentUnavailability({ instrumentId, newStatus, reason, req }) {
  const inst = await instrumentRepository.findById(instrumentId);
  if (!inst) return null;
  const instId = inst.id || inst._id;

  const updatedInst = await instrumentRepository.updateById(instId, {
    status: newStatus,
    unavailabilityReason: reason || `Status changed to ${newStatus}`,
  });

  const todayStr = toDayString(new Date());
  const affectedBookings = await findAffectedBookings(instId, todayStr);

  // Notify each affected user of required review/rescheduling
  for (const b of affectedBookings) {
    const uid = b.userId && (b.userId.id || b.userId._id || b.userId);
    if (uid) {
      await notifyUser({
        userId: String(uid),
        type: 'instrument-unavailable',
        title: 'Booking Impacted: Instrument Unavailable',
        message: `Instrument "${inst.name}" is now ${newStatus} (${reason || 'operational restriction'}). Your reservation on ${toDayString(b.date)} requires rescheduling or review.`,
        entityType: 'instrument',
        entityId: String(instId),
        dedupKey: `inst-unavail-${instId}-${b.id || b._id}`,
      });
    }
  }

  // Audit event for the flagging workflow
  const currentUserId = req && req.user ? (req.user._id || req.user.id) : null;
  await logAudit({
    userId: currentUserId,
    action: 'BOOKINGS_FLAGGED_BY_RESTRICTION',
    resource: 'Instrument',
    resourceId: instId,
    details: {
      newStatus,
      reason,
      affectedCount: affectedBookings.length,
      affectedBookingIds: affectedBookings.map((b) => b.id || b._id),
    },
    req,
  });

  return {
    instrument: updatedInst,
    affectedBookings,
    affectedCount: affectedBookings.length,
  };
}

/**
 * Authorizes returning an instrument to active service:
 * Enforces server-side checks that no unresolved breakages, ongoing maintenance,
 * or calibration issues remain before marking AVAILABLE.
 */
async function authorizeReturnToService({ instrumentId, adminUser, resolutionNotes, req }) {
  if (!adminUser || adminUser.role !== 'admin') {
    return { success: false, status: 403, code: 'FORBIDDEN', message: 'Only authorized administrators can perform return-to-service decisions.' };
  }
  const inst = await instrumentRepository.findById(instrumentId);
  if (!inst) {
    return { success: false, status: 404, code: 'NOT_FOUND', message: 'Instrument not found.' };
  }
  const instId = inst.id || inst._id;

  // 1. Verify lifecycle state
  if (inst.lifecycleState && inst.lifecycleState !== 'COMMISSIONED') {
    return {
      success: false,
      status: 422,
      code: 'INSTRUMENT_NOT_COMMISSIONED',
      message: `Cannot return to service: instrument lifecycle is ${inst.lifecycleState}. Re-commission the instrument first.`,
    };
  }

  // 2. Verify calibration is not overdue (fail-fast memory check)
  if (inst.nextCalibrationDue) {
    const todayStr = toDayString(new Date());
    const dueStr = toDayString(inst.nextCalibrationDue);
    if (dueStr < todayStr) {
      return {
        success: false,
        status: 422,
        code: 'CALIBRATION_OVERDUE',
        message: `Cannot return to service: calibration expired on ${dueStr}. Calibration required prior to service return.`,
      };
    }
  }

  // 3. Verify no open breakages
  const openBreak = await breakageRepository.count({ instrumentId: instId, statusIn: OPEN_BREAKAGE_STATUSES });
  if (openBreak > 0) {
    return {
      success: false,
      status: 422,
      code: 'UNRESOLVED_BREAKAGE',
      message: `Cannot return to service: ${openBreak} unresolved breakage/incident report(s) still open.`,
    };
  }

  // 4. Verify no ongoing maintenance
  const inProgMaint = await maintenanceRepository.count({ instrumentId: instId, status: 'IN_PROGRESS' });
  if (inProgMaint > 0) {
    return {
      success: false,
      status: 422,
      code: 'MAINTENANCE_IN_PROGRESS',
      message: 'Cannot return to service: maintenance is currently in progress.',
    };
  }

  // 5. Verify no ongoing calibration
  const underCal = await calibrationRepository.count({ instrumentId: instId, status: 'UNDER_CALIBRATION' });
  if (underCal > 0) {
    return {
      success: false,
      status: 422,
      code: 'CALIBRATION_IN_PROGRESS',
      message: 'Cannot return to service: metrology calibration is currently in progress.',
    };
  }

  // Restore status to AVAILABLE and clear restriction reason
  const updated = await instrumentRepository.updateById(instId, {
    status: 'AVAILABLE',
    unavailabilityReason: null,
  });

  const adminId = adminUser._id || adminUser.id;
  await logAudit({
    userId: adminId,
    action: 'RETURN_TO_SERVICE',
    resource: 'Instrument',
    resourceId: instId,
    details: {
      authorizedBy: adminId,
      resolutionNotes: resolutionNotes || 'Authorized return to service after inspection.',
      previousStatus: inst.status,
    },
    req,
  });

  return { success: true, instrument: updated };
}

/**
 * Aggregates complete lifecycle history for an instrument:
 * Includes calibration records, maintenance history, incident reports, and audit logs.
 */
async function getInstrumentLifecycleHistory(instrumentId, { role = 'student' } = {}) {
  const inst = await instrumentRepository.findById(instrumentId);
  if (!inst) return null;
  const instId = inst.id || inst._id;

  const [calibrations, maintenance, breakages, auditLogs] = await Promise.all([
    calibrationRepository.list({ instrumentId: instId }, { limit: 100 }),
    maintenanceRepository.list({ instrumentId: instId }, { limit: 100 }),
    breakageRepository.list({ instrumentId: instId }, { limit: 100 }),
    role === 'admin' ? auditRepository.list({ resourceId: instId }, { limit: 100 }) : Promise.resolve([]),
  ]);

  if (role !== 'admin') {
    breakages.forEach((b) => delete b.breakageFee);
  }

  // Build unified chronological timeline
  const timeline = [];

  calibrations.forEach((c) => {
    timeline.push({
      type: 'CALIBRATION',
      id: c.id || c._id,
      date: c.date,
      title: `Calibration: ${c.calibrationType}`,
      status: c.status,
      result: c.result,
      details: c.notes || `Standard: ${c.standard || 'Default'}`,
      timestamp: c.createdAt || c.date,
    });
  });

  maintenance.forEach((m) => {
    timeline.push({
      type: 'MAINTENANCE',
      id: m.id || m._id,
      date: m.startDate,
      title: `Maintenance (${m.type})`,
      status: m.status,
      details: m.description,
      workPerformed: m.workPerformed,
      timestamp: m.createdAt || m.startDate,
    });
  });

  breakages.forEach((b) => {
    timeline.push({
      type: 'BREAKAGE_INCIDENT',
      id: b.id || b._id,
      date: b.createdAt,
      title: `Incident: ${b.issueType} (${b.severity})`,
      status: b.status,
      details: b.description,
      timestamp: b.createdAt,
    });
  });

  auditLogs.forEach((a) => {
    timeline.push({
      type: 'AUDIT_EVENT',
      id: a.id || a._id,
      date: a.createdAt,
      title: `Audit: ${a.action}`,
      status: 'LOGGED',
      details: JSON.stringify(a.details || {}),
      timestamp: a.createdAt,
    });
  });

  timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return {
    instrument: inst,
    calibrations,
    maintenance,
    breakages,
    auditLogs,
    timeline,
  };
}

module.exports = {
  LIFECYCLE_STATES,
  OPERATIONAL_STATUSES,
  LIFECYCLE_TRANSITIONS,
  OPERATIONAL_TRANSITIONS,
  OPEN_BREAKAGE_STATUSES,
  ACTIVE_BOOKING_STATUSES,
  validateLifecycleTransition,
  validateOperationalTransition,
  checkInstrumentBookingEligibility,
  findAffectedBookings,
  handleInstrumentUnavailability,
  authorizeReturnToService,
  getInstrumentLifecycleHistory,
};
