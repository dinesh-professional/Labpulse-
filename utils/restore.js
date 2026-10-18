/**
 * Shared availability restore (Phase 07 / Module 06).
 * Transitions an instrument OUT of a blocking status when nothing else blocks.
 * Redirects status appropriately:
 * - open breakage -> OUT_OF_ORDER
 * - calibration today -> UNDER_CALIBRATION
 * - maintenance today -> UNDER_MAINTENANCE
 * - otherwise -> AVAILABLE
 * Locked status is preserved (safety interlock owns LOCKED).
 */
const {
  instrumentRepository,
  calibrationRepository,
  maintenanceRepository,
  breakageRepository,
} = require('../repositories');
const { toDayString } = require('./time');

function todayBounds() {
  const n = new Date();
  const start = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  return { start, next: new Date(start.getTime() + 86400000), todayStr: toDayString(start) };
}

async function currentMaintenanceCount(instrumentId) {
  const rows = await maintenanceRepository.list({ instrumentId, status: 'SCHEDULED' }, { limit: 100 });
  const inProgress = await maintenanceRepository.list({ instrumentId, status: 'IN_PROGRESS' }, { limit: 100 });
  const all = [...rows, ...inProgress];
  const { todayStr } = todayBounds();
  return all.filter((m) => {
    const s = toDayString(m.startDate);
    const e = m.endDate ? toDayString(m.endDate) : s;
    return s <= todayStr && e >= todayStr;
  }).length;
}

async function restoreInstrument(instrumentId, fromStatus, excludeCalibrationId) {
  const inst = await instrumentRepository.findById(instrumentId);
  if (!inst || inst.status !== fromStatus) return inst;
  const { start, next } = todayBounds();

  const [underCal, calToday, maint, openBreak] = await Promise.all([
    calibrationRepository.count({ instrumentId, status: 'UNDER_CALIBRATION' }),
    calibrationRepository.count({ instrumentId, status: 'CALIBRATION_SCHEDULED' }),
    currentMaintenanceCount(instrumentId),
    breakageRepository.count({ instrumentId, statusIn: ['REPORTED', 'UNDER_REVIEW', 'CONFIRMED'] }),
  ]);

  if (underCal > 0) return inst; // another calibration owns state
  const isCalOverdue = inst.nextCalibrationDue && new Date(inst.nextCalibrationDue) < start;
  let newStatus = 'AVAILABLE';
  if (inst.lifecycleState && inst.lifecycleState !== 'COMMISSIONED') {
    newStatus = 'LOCKED';
  } else if (openBreak > 0) {
    newStatus = 'OUT_OF_ORDER';
  } else if (calToday > 0 || isCalOverdue) {
    newStatus = 'UNDER_CALIBRATION';
  } else if (maint > 0) {
    newStatus = 'UNDER_MAINTENANCE';
  }

  const instId = inst.id || inst._id;
  const updates = { status: newStatus };
  if (newStatus === 'AVAILABLE') {
    updates.unavailabilityReason = null;
  }
  return instrumentRepository.updateById(instId, updates);
}

module.exports = { restoreInstrument, currentMaintenanceCount };
