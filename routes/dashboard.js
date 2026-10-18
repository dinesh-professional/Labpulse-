/**
 * Dashboard stats endpoints (Module 11: Role-Based Dashboards).
 * Provides aggregated metrics for each role's dashboard summary cards.
 *
 * GET /dashboard/stats — returns role-scoped metrics
 *
 * All routes: requireAuth (role-aware metrics returned based on req.user.role).
 */
const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const {
  userRepository,
  bookingRepository,
  instrumentRepository,
  scheduleRepository,
  breakageRepository,
  calibrationRepository,
  notificationRepository,
} = require('../repositories');

const router = express.Router();

router.use(requireAuth);

/**
 * GET /dashboard/stats
 *
 * Returns role-scoped aggregate metrics.
 * - student: my bookings (total, pending, confirmed, completed, cancelled), upcoming classes, unread notifications
 * - faculty: my bookings, pending approvals queue, my schedules, breakage reports, total instruments, unread notifications
 * - admin:   system-wide counts (users, faculty, students, bookings, pending approvals, instruments, schedules, breakage, calibrations, unread notifications)
 *
 * Identity is derived strictly from the verified session (req.user), never from client parameters.
 */
router.get('/stats', async (req, res) => {
  try {
    const role = req.user.role;
    const userId = req.user.id;

    let metrics = {};

    if (role === 'student') {
      const [
        totalBookings,
        pendingBookings,
        confirmedBookings,
        completedBookings,
        cancelledBookings,
        upcomingClasses,
        unreadNotifications,
      ] = await Promise.all([
        bookingRepository.count({ userId }).catch(() => 0),
        bookingRepository.count({ userId, status: 'PENDING_APPROVAL' }).catch(() => 0),
        bookingRepository.count({ userId, status: 'CONFIRMED' }).catch(() => 0),
        bookingRepository.count({ userId, status: 'COMPLETED' }).catch(() => 0),
        bookingRepository.count({ userId, status: 'CANCELLED' }).catch(() => 0),
        scheduleRepository.count({ status: 'SCHEDULED' }).catch(() => 0),
        notificationRepository.getUnreadCount(userId).catch(() => 0),
      ]);

      metrics = {
        totalBookings,
        pendingBookings,
        confirmedBookings,
        completedBookings,
        cancelledBookings,
        upcomingClasses,
        unreadNotifications,
      };
    } else if (role === 'faculty') {
      const [
        myBookings,
        pendingApprovals,
        mySchedules,
        activeBreakage,
        totalInstruments,
        availableInstruments,
        unreadNotifications,
      ] = await Promise.all([
        bookingRepository.count({ userId }).catch(() => 0),
        bookingRepository.count({ status: 'PENDING_APPROVAL' }).catch(() => 0),
        scheduleRepository.count({ facultyId: userId }).catch(() => 0),
        breakageRepository.count({ statusIn: ['OPEN', 'REPORTED', 'INVESTIGATING'] }).catch(() => 0),
        instrumentRepository.count({}).catch(() => 0),
        instrumentRepository.count({ status: 'AVAILABLE' }).catch(() => 0),
        notificationRepository.getUnreadCount(userId).catch(() => 0),
      ]);

      metrics = {
        myBookings,
        pendingApprovals,
        mySchedules,
        activeBreakage,
        totalInstruments,
        availableInstruments,
        unreadNotifications,
      };
    } else if (role === 'admin') {
      const [
        totalUsers,
        totalFaculty,
        totalStudents,
        totalBookings,
        pendingBookings,
        confirmedBookings,
        completedBookings,
        totalInstruments,
        availableInstruments,
        outOfOrderInstruments,
        totalSchedules,
        openBreakage,
        totalCalibrations,
        unreadNotifications,
      ] = await Promise.all([
        userRepository.count({}).catch(() => 0),
        userRepository.count({ role: 'faculty' }).catch(() => 0),
        userRepository.count({ role: 'student' }).catch(() => 0),
        bookingRepository.count({}).catch(() => 0),
        bookingRepository.count({ status: 'PENDING_APPROVAL' }).catch(() => 0),
        bookingRepository.count({ status: 'CONFIRMED' }).catch(() => 0),
        bookingRepository.count({ status: 'COMPLETED' }).catch(() => 0),
        instrumentRepository.count({}).catch(() => 0),
        instrumentRepository.count({ status: 'AVAILABLE' }).catch(() => 0),
        instrumentRepository.count({ status: 'OUT_OF_ORDER' }).catch(() => 0),
        scheduleRepository.count({}).catch(() => 0),
        breakageRepository.count({ statusIn: ['OPEN', 'REPORTED', 'INVESTIGATING'] }).catch(() => 0),
        calibrationRepository.count({}).catch(() => 0),
        notificationRepository.getUnreadCount(userId).catch(() => 0),
      ]);

      metrics = {
        totalUsers,
        totalFaculty,
        totalStudents,
        totalBookings,
        pendingBookings,
        confirmedBookings,
        completedBookings,
        totalInstruments,
        availableInstruments,
        outOfOrderInstruments,
        totalSchedules,
        openBreakage,
        totalCalibrations,
        unreadNotifications,
      };
    } else {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Unknown role for dashboard stats.' },
      });
    }

    return res.json({ success: true, data: { role, metrics } });
  } catch (err) {
    console.error('[dashboard] stats error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Could not load dashboard metrics.' },
    });
  }
});

module.exports = router;
