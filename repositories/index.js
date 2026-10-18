/**
 * Central Repositories Manifest (Module 06)
 * Exports all domain repositories for clean server-side database access.
 */
const userRepository = require('./userRepository');
const laboratoryRepository = require('./laboratoryRepository');
const instrumentRepository = require('./instrumentRepository');
const calibrationRepository = require('./calibrationRepository');
const maintenanceRepository = require('./maintenanceRepository');
const qualificationRepository = require('./qualificationRepository');
const bookingRepository = require('./bookingRepository');
const scheduleRepository = require('./scheduleRepository');
const breakageRepository = require('./breakageRepository');
const notificationRepository = require('./notificationRepository');
const qrRepository = require('./qrRepository');
const auditRepository = require('./auditRepository');
const laboratoryMembershipRepository = require('./laboratoryMembershipRepository');
const analyticsRepository = require('./analyticsRepository');
const mappers = require('./mappers');

module.exports = {
  userRepository,
  laboratoryRepository,
  laboratoryMembershipRepository,
  instrumentRepository,
  calibrationRepository,
  maintenanceRepository,
  qualificationRepository,
  bookingRepository,
  scheduleRepository,
  breakageRepository,
  notificationRepository,
  qrRepository,
  auditRepository,
  analyticsRepository,
  mappers,
};
