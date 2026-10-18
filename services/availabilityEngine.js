/**
 * Availability Engine (Module 07)
 * Computes instrument timeslot availability and performs server-authoritative
 * pre-booking validation against operational gates, metrology schedules,
 * maintenance windows, curriculum schedules, and operator qualifications.
 */
const {
  instrumentRepository,
  calibrationRepository,
  maintenanceRepository,
  scheduleRepository,
  qualificationRepository,
  bookingRepository,
} = require('../repositories');
const { isHHMM, toMinutes, parseDayUTC, dayRangeUTC, isPastDay, toDayString } = require('../utils/time');
const { BOOKING_STATUS, BLOCKING_STATUSES } = require('./bookingLifecycle');

const { checkInstrumentBookingEligibility } = require('./instrumentLifecycle');

const DEFAULT_OPERATING_HOURS = {
  start: '08:00',
  end: '20:00',
};

const BOOKING_LIMITS = {
  minDurationMinutes: 15,
  maxDurationMinutes: 240, // 4 hours
  maxAdvanceDays: 30,
};

const HARD_BLOCK_STATUSES = {
  OUT_OF_ORDER: { code: 'INSTRUMENT_OUT_OF_ORDER', message: 'Instrument is out of order (breakage reported). Booking disabled.' },
  LOCKED: { code: 'INSTRUMENT_LOCKED', message: 'Instrument is locked out. Booking disabled.' },
  UNDER_MAINTENANCE: { code: 'INSTRUMENT_UNDER_MAINTENANCE', message: 'Instrument is under maintenance. Booking disabled.' },
  UNDER_CALIBRATION: { code: 'INSTRUMENT_UNDER_CALIBRATION', message: 'Instrument is under calibration. Booking disabled.' },
};

/**
 * Checks if two time windows [s1, e1) and [s2, e2) overlap.
 */
function timesOverlap(s1, e1, s2, e2) {
  const start1 = toMinutes(s1);
  const end1 = toMinutes(e1);
  const start2 = toMinutes(s2);
  const end2 = toMinutes(e2);
  return start1 < end2 && end1 > start2;
}

/**
 * Validates a booking attempt before creation or rescheduling.
 */
async function validateBookingRequest({ user, instrumentId, dateStr, startTime, endTime, purpose, excludeId }) {
  // 1. User active check
  if (!user || !user.isActive) {
    return { valid: false, status: 403, code: 'ACCOUNT_INACTIVE', message: 'Account is deactivated.' };
  }

  // 2. Date validation
  const dateObj = parseDayUTC(dateStr);
  if (!dateObj) {
    return { valid: false, status: 422, code: 'INVALID_DATE', message: 'date must be in YYYY-MM-DD format.' };
  }
  if (isPastDay(dateStr)) {
    return { valid: false, status: 422, code: 'INVALID_DATE', message: 'Bookings cannot be scheduled in the past.' };
  }

  const today = parseDayUTC(toDayString(new Date()));
  const daysInAdvance = Math.round((dateObj.getTime() - today.getTime()) / 86400000);
  if (daysInAdvance > BOOKING_LIMITS.maxAdvanceDays) {
    return { valid: false, status: 422, code: 'ADVANCE_LIMIT_EXCEEDED', message: `Bookings cannot be scheduled more than ${BOOKING_LIMITS.maxAdvanceDays} days in advance.` };
  }

  // 3. Time validation
  if (!isHHMM(startTime) || !isHHMM(endTime)) {
    return { valid: false, status: 422, code: 'INVALID_TIME_RANGE', message: 'startTime and endTime must be in HH:mm format.' };
  }
  const startM = toMinutes(startTime);
  const endM = toMinutes(endTime);
  if (endM <= startM) {
    return { valid: false, status: 422, code: 'INVALID_TIME_RANGE', message: 'endTime must be strictly after startTime.' };
  }

  const durationM = endM - startM;
  if (durationM < BOOKING_LIMITS.minDurationMinutes) {
    return { valid: false, status: 422, code: 'DURATION_TOO_SHORT', message: `Minimum booking duration is ${BOOKING_LIMITS.minDurationMinutes} minutes.` };
  }
  if (durationM > BOOKING_LIMITS.maxDurationMinutes) {
    return { valid: false, status: 422, code: 'DURATION_TOO_LONG', message: `Maximum booking duration is ${BOOKING_LIMITS.maxDurationMinutes} minutes (4 hours).` };
  }

  // 4. Operating hours check
  const opStart = toMinutes(DEFAULT_OPERATING_HOURS.start);
  const opEnd = toMinutes(DEFAULT_OPERATING_HOURS.end);
  if (startM < opStart || endM > opEnd) {
    return {
      valid: false,
      status: 422,
      code: 'OUTSIDE_OPERATING_HOURS',
      message: `Requested timeslot (${startTime}–${endTime}) is outside facility operating hours (${DEFAULT_OPERATING_HOURS.start}–${DEFAULT_OPERATING_HOURS.end}).`,
    };
  }

  // 5. Purpose validation
  if (purpose !== undefined && (typeof purpose !== 'string' || !purpose.trim())) {
    return { valid: false, status: 400, code: 'VALIDATION_ERROR', message: 'purpose must be a non-empty string.' };
  }

  // 6. Instrument lookup & authoritative lifecycle/operational eligibility check
  const instrument = await instrumentRepository.findById(instrumentId);
  if (!instrument) {
    return { valid: false, status: 404, code: 'INSTRUMENT_NOT_FOUND', message: 'Instrument not found.' };
  }

  const eligibility = await checkInstrumentBookingEligibility(instrument, user, dateStr, startTime, endTime);
  if (!eligibility.eligible) {
    return { valid: false, status: eligibility.status || 422, code: eligibility.code, message: eligibility.message };
  }

  // 7. Qualification check
  const requiredLevel = instrument.requiredQualificationLevel || 0;
  if (requiredLevel > 0 && user.role !== 'admin') {
    const userId = user._id || user.id;
    const instId = instrument._id || instrument.id;
    const isQualified = await qualificationRepository.checkUserQualification(userId, instId, requiredLevel);
    if (!isQualified) {
      return {
        valid: false,
        status: 403,
        code: 'QUALIFICATION_REQUIRED',
        message: `Level ${requiredLevel} operator qualification required to reserve this instrument.`,
      };
    }
  }

  // 8. Calibration window collision check
  const calBlock = await calibrationRepository.findBlockingCalibration(instrumentId, dateStr, startTime, endTime);
  if (calBlock) {
    return {
      valid: false,
      status: 409,
      code: 'CALIBRATION_CONFLICT',
      message: `Instrument is reserved for calibration during this time (${calBlock.startTime}–${calBlock.endTime}).`,
    };
  }

  // 9. Maintenance window collision check
  const maintBlock = await maintenanceRepository.findBlockingMaintenance(instrumentId, dateStr, startTime, endTime, excludeId);
  if (maintBlock) {
    return {
      valid: false,
      status: 409,
      code: 'MAINTENANCE_CONFLICT',
      message: 'Instrument is scheduled for maintenance during this time.',
    };
  }

  // 10. Laboratory schedule check (if instrument belongs to a lab)
  if (instrument.laboratoryId) {
    const labClash = await scheduleRepository.findLabConflict(instrument.laboratoryId, dateStr, startTime, endTime);
    if (labClash) {
      return {
        valid: false,
        status: 409,
        code: 'SCHEDULE_CONFLICT',
        message: `Laboratory is in session for scheduled course: ${labClash.subject} (${labClash.startTime}–${labClash.endTime}).`,
      };
    }
  }

  // 11. Booking conflict check (active blocking reservations)
  const clash = await bookingRepository.findConflict(instrumentId, dateStr, startTime, endTime, excludeId);
  if (clash) {
    return {
      valid: false,
      status: 409,
      code: 'BOOKING_CONFLICT',
      message: `Instrument is already booked during this time (${clash.startTime}–${clash.endTime}).`,
    };
  }

  return {
    valid: true,
    instrument,
    date: dateObj,
    dateStr,
    startTime,
    endTime,
    purpose: (purpose || '').trim().slice(0, 500),
  };
}

/**
 * Computes timeline availability and discrete slots for an instrument across N days.
 */
async function computeInstrumentAvailability(instrumentId, startDateStr, numDays = 1) {
  const instrument = await instrumentRepository.findById(instrumentId);
  if (!instrument) return null;

  const from = parseDayUTC(startDateStr);
  if (!from) return null;

  const days = Math.min(31, Math.max(1, parseInt(numDays, 10) || 1));
  const isLifecycleBlocked = instrument.lifecycleState && instrument.lifecycleState !== 'COMMISSIONED';
  const isHardBlocked = isLifecycleBlocked || ['OUT_OF_ORDER', 'LOCKED', 'UNDER_MAINTENANCE', 'UNDER_CALIBRATION'].includes(instrument.status);
  const instId = instrument.id || instrument._id;

  const out = [];

  for (let i = 0; i < days; i += 1) {
    const day = new Date(from.getTime() + i * 86400000);
    const dateStr = toDayString(day);
    const blocks = [];

    if (isHardBlocked) {
      const reason = isLifecycleBlocked ? instrument.lifecycleState : instrument.status;
      blocks.push({ type: 'status', reason, startTime: '00:00', endTime: '23:59' });
    } else {
      // Overdue calibration check
      if (instrument.nextCalibrationDue && toDayString(instrument.nextCalibrationDue) < dateStr) {
        blocks.push({ type: 'calibration_overdue', reason: 'CALIBRATION_OVERDUE', startTime: '00:00', endTime: '23:59' });
      }
      // Gather calibrations
      const cal = await calibrationRepository.findBlockingCalibration(instId, dateStr, '00:00', '23:59');
      if (cal) {
        blocks.push({ type: 'calibration', from: cal.startTime, to: cal.endTime, startTime: cal.startTime, endTime: cal.endTime });
      }

      // Gather maintenance
      const maint = await maintenanceRepository.findBlockingMaintenance(instId, dateStr, '00:00', '23:59');
      if (maint) {
        blocks.push({ type: 'maintenance', from: maint.startTime || '00:00', to: maint.endTime || '23:59', startTime: maint.startTime || '00:00', endTime: maint.endTime || '23:59' });
      }

      // Gather lab schedule if in laboratory
      if (instrument.laboratoryId) {
        const labClash = await scheduleRepository.findLabConflict(instrument.laboratoryId, dateStr, '00:00', '23:59');
        if (labClash) {
          blocks.push({ type: 'schedule', subject: labClash.subject, startTime: labClash.startTime, endTime: labClash.endTime });
        }
      }

      // Gather active bookings
      const bookings = await bookingRepository.list({ instrumentId: instId }, { limit: 100 });
      for (const b of (bookings || [])) {
        if (BLOCKING_STATUSES.includes(b.status)) {
          const bDate = toDayString(b.date);
          if (bDate === dateStr) {
            blocks.push({
              type: 'booking',
              status: b.status,
              from: b.startTime,
              to: b.endTime,
              startTime: b.startTime,
              endTime: b.endTime,
            });
          }
        }
      }
    }

    // Generate standard 1-hour slots
    const slots = [];
    const opStartH = parseInt(DEFAULT_OPERATING_HOURS.start.split(':')[0], 10);
    const opEndH = parseInt(DEFAULT_OPERATING_HOURS.end.split(':')[0], 10);

    for (let h = opStartH; h < opEndH; h += 1) {
      const slotStart = `${String(h).padStart(2, '0')}:00`;
      const slotEnd = `${String(h + 1).padStart(2, '0')}:00`;
      const isBlocked = blocks.some(b => timesOverlap(slotStart, slotEnd, b.startTime || b.from, b.endTime || b.to));

      slots.push({
        startTime: slotStart,
        endTime: slotEnd,
        available: !isBlocked,
      });
    }

    out.push({
      date: dateStr,
      available: blocks.length === 0,
      operatingHours: DEFAULT_OPERATING_HOURS,
      blocks,
      slots,
    });
  }

  return {
    instrument,
    days: out,
  };
}

module.exports = {
  DEFAULT_OPERATING_HOURS,
  BOOKING_LIMITS,
  validateBookingRequest,
  computeInstrumentAvailability,
  timesOverlap,
};
