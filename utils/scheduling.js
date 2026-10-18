/**
 * Laboratory occupancy check (Phase 04 / Module 06) — spec §18.
 * Overlap rule: existingStart < requestedEnd AND existingEnd > requestedStart.
 * CANCELLED schedules never block. Excludes one id (for edits).
 * Backed by scheduleRepository.
 */
const { scheduleRepository } = require('../repositories');

async function findLabConflict(laboratoryId, dateStr, startTime, endTime, excludeId) {
  return scheduleRepository.findLabConflict(laboratoryId, dateStr, startTime, endTime, excludeId);
}

module.exports = { findLabConflict };
