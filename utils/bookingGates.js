/**
 * Booking availability gates (Phase 05 / Module 06) — spec §8 + §18.
 * Shared by POST/PATCH /bookings and GET /instruments/:id/availability.
 * Order: status -> calibration window -> maintenance window -> qualification -> overlap.
 */
const {
  instrumentRepository,
  calibrationRepository,
  maintenanceRepository,
  qualificationRepository,
  bookingRepository,
} = require('../repositories');
const { dayRangeUTC, toDayString, isHHMM } = require('./time');

const BLOCKING_STATUS = {
  OUT_OF_ORDER: { code: 'INSTRUMENT_OUT_OF_ORDER', message: 'Instrument is out of order (breakage reported). Booking disabled.' },
  LOCKED: { code: 'INSTRUMENT_LOCKED', message: 'Instrument is locked out. Booking disabled.' },
  UNDER_MAINTENANCE: { code: 'INSTRUMENT_UNDER_MAINTENANCE', message: 'Instrument is under maintenance.' },
  UNDER_CALIBRATION: { code: 'INSTRUMENT_UNDER_CALIBRATION', message: 'Instrument is under calibration.' },
};

async function findCalibrationBlock(instrumentId, dateStr, startTime, endTime) {
  return calibrationRepository.findBlockingCalibration(instrumentId, dateStr, startTime, endTime);
}

async function findMaintenanceBlock(instrumentId, dateStr, startTime, endTime, excludeId) {
  return maintenanceRepository.findBlockingMaintenance(instrumentId, dateStr, startTime, endTime, excludeId);
}

async function checkQualification(user, instrument) {
  const required = instrument.requiredQualificationLevel || 0;
  if (!required) return null;
  if (user.role === 'admin') return null; // admins act globally; still audited

  const userId = user._id || user.id;
  const instId = instrument._id || instrument.id;
  const isQualified = await qualificationRepository.checkUserQualification(userId, instId, required);
  if (!isQualified) {
    return { status: 403, code: 'QUALIFICATION_REQUIRED', message: `Level ${required} qualification required for this instrument.` };
  }
  return null;
}

async function findBookingConflict(instrumentId, dateStr, startTime, endTime, excludeId) {
  return bookingRepository.findConflict(instrumentId, dateStr, startTime, endTime, excludeId);
}

/** Full gate chain. Returns { instrument } or { status, code, message }. */
async function checkBookingGates({ user, instrumentId, dateStr, startTime, endTime, excludeId }) {
  if (user && user.isActive === false) {
    return { status: 403, code: 'ACCOUNT_DEACTIVATED', message: 'User account is deactivated or suspended. Booking disabled.' };
  }
  const instrument = await instrumentRepository.findById(instrumentId);
  if (!instrument) return { status: 404, code: 'INSTRUMENT_NOT_FOUND', message: 'Instrument not found.' };
  const blocked = BLOCKING_STATUS[instrument.status];
  if (blocked) return { status: 422, ...blocked };
  if (await findCalibrationBlock(instrumentId, dateStr, startTime, endTime)) {
    return { status: 409, code: 'CALIBRATION_CONFLICT', message: 'Instrument is under calibration during this time.' };
  }
  if (await findMaintenanceBlock(instrumentId, dateStr, startTime, endTime, excludeId)) {
    return { status: 409, code: 'MAINTENANCE_CONFLICT', message: 'Instrument is under maintenance during this time.' };
  }
  const qual = await checkQualification(user, instrument);
  if (qual) return qual;
  const clash = await findBookingConflict(instrumentId, dateStr, startTime, endTime, excludeId);
  if (clash) {
    return { status: 409, code: 'BOOKING_CONFLICT', message: `Instrument is already booked during this time (${clash.startTime}–${clash.endTime}).` };
  }
  return { instrument };
}

module.exports = {
  checkBookingGates,
  findCalibrationBlock,
  findMaintenanceBlock,
  findBookingConflict,
  checkQualification,
};
