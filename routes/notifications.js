/**
 * In-App Notifications & Real-Time Stream (Module 10) — spec §14 & §15.
 *
 * Endpoints:
 *   GET    /api/v1/notifications              — List authenticated user's notifications (paginated)
 *   GET    /api/v1/notifications/unread-count — Fast unread count
 *   GET    /api/v1/notifications/stream       — Real-time Server-Sent Events (SSE) stream
 *   PATCH  /api/v1/notifications/:id/read     — Mark single notification as read
 *   PATCH  /api/v1/notifications/:id/unread   — Mark single notification as unread
 *   POST   /api/v1/notifications/mark-all-read— Mark all user notifications as read
 *   PATCH  /api/v1/notifications/read-all     — Alias for mark-all-read
 *   DELETE /api/v1/notifications/:id          — Dismiss/delete own notification
 *   POST   /api/v1/notifications/outbox/process— Process transactional outbox queue (admin only)
 */
const express = require('express');
const { notificationRepository } = require('../repositories');
const { dbState } = require('../config/db');
const { getActiveDataBackend } = require('../config/supabase');
const { requireAuth } = require('../middleware/requireAuth');
const { isValidId } = require('../utils/idValidation');
const {
  addRealtimeClient,
  processOutboxBatch,
} = require('../services/notificationService');

const router = express.Router();

function requireDB(req, res, next) {
  if (getActiveDataBackend() === 'supabase') return next();
  if (dbState() !== 1) {
    return res.status(503).json({
      success: false,
      error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' },
    });
  }
  return next();
}

// All notification endpoints require authenticated user session
router.use(requireDB, requireAuth);

/**
 * GET /api/v1/notifications/unread-count
 * Fast unread counter for dashboard header badges
 */
router.get('/unread-count', async (req, res, next) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const unreadCount = await notificationRepository.getUnreadCount(currentUserId);
    return res.json({ success: true, data: { unreadCount } });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/v1/notifications/stream
 * Real-time Server-Sent Events (SSE) subscription for authenticated user
 */
router.get('/stream', async (req, res) => {
  const currentUserId = req.user._id || req.user.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  addRealtimeClient(currentUserId, res);
});

/**
 * GET /api/v1/notifications
 * Retrieve paginated notifications for current user with filtering
 */
router.get('/', async (req, res, next) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const filter = { userId: currentUserId };

    if (req.query.read !== undefined) {
      if (!['true', 'false'].includes(req.query.read)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'read query parameter must be true or false.' },
        });
      }
      filter.read = req.query.read === 'true';
    }

    if (req.query.type) {
      filter.type = String(req.query.type).slice(0, 80);
    }
    if (req.query.entityType) {
      filter.entityType = String(req.query.entityType).slice(0, 50);
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));

    const [total, unread, rows] = await Promise.all([
      notificationRepository.count(filter),
      notificationRepository.getUnreadCount(currentUserId),
      notificationRepository.list(filter, { page, limit }),
    ]);

    return res.json({
      success: true,
      data: {
        notifications: rows,
        unread,
        page,
        limit,
        total,
      },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/v1/notifications/mark-all-read
 * Mark all unread notifications for the authenticated user as read
 */
router.post('/mark-all-read', async (req, res, next) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const updated = await notificationRepository.markAllAsRead(currentUserId);
    const count = Array.isArray(updated) ? updated.length : (updated?.modifiedCount || 0);
    return res.json({
      success: true,
      data: { count, message: 'All notifications marked as read.' },
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/read-all', async (req, res, next) => {
  try {
    const currentUserId = req.user._id || req.user.id;
    const updated = await notificationRepository.markAllAsRead(currentUserId);
    const count = Array.isArray(updated) ? updated.length : (updated?.modifiedCount || 0);
    return res.json({
      success: true,
      data: { count, message: 'All notifications marked as read.' },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * PATCH /api/v1/notifications/:id/read
 * Mark individual notification as read (strictly owner-scoped)
 */
router.patch('/:id/read', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid notification identifier.' },
      });
    }
    const currentUserId = req.user._id || req.user.id;
    const row = await notificationRepository.markAsRead(req.params.id, currentUserId);
    if (!row) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Notification not found.' },
      });
    }
    return res.json({ success: true, data: { notification: row } });
  } catch (err) {
    return next(err);
  }
});

/**
 * PATCH /api/v1/notifications/:id/unread
 * Mark individual notification as unread (strictly owner-scoped)
 */
router.patch('/:id/unread', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid notification identifier.' },
      });
    }
    const currentUserId = req.user._id || req.user.id;
    const row = await notificationRepository.markAsUnread(req.params.id, currentUserId);
    if (!row) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Notification not found.' },
      });
    }
    return res.json({ success: true, data: { notification: row } });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/v1/notifications/:id
 * Dismiss/delete notification (strictly owner-scoped)
 */
router.delete('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid notification identifier.' },
      });
    }
    const currentUserId = req.user._id || req.user.id;
    const deleted = await notificationRepository.deleteById(req.params.id, currentUserId);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Notification not found.' },
      });
    }
    return res.json({ success: true, data: { message: 'Notification dismissed.' } });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/v1/notifications/outbox/process
 * Bounded transactional outbox processor (Admin restricted)
 */
router.post('/outbox/process', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Only administrators may process the notification outbox.' },
      });
    }
    const batchSize = Math.min(100, Math.max(1, parseInt(req.body?.batchSize || '50', 10) || 50));
    const result = await processOutboxBatch(batchSize);
    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
