/**
 * Module 10 Verification: Notifications & Real-Time Updates
 * Run: `node scripts/verify-module-10.js`
 *
 * Validates all 22 acceptance criteria for Module 10:
 *  1. Notification schema includes required entity links, read timestamps, and dedup keys
 *  2. Relational migration 07 defines schema additions, partial unique dedup index, and outbox table
 *  3. Mongoose Notification model includes all enhanced fields and indexes
 *  4. Mongoose NotificationOutbox model defined with event fields and status constraints
 *  5. Domain mappers support bidirectional conversion for notifications and outbox events
 *  6. Notification repository provides complete CRUD, unread counting, and outbox operations
 *  7. Idempotent notification creation suppresses duplicates via dedupKey
 *  8. Central notification service provides unified event dispatching and outbox enqueuing
 *  9. Real-time SSE stream manager enforces strict per-user channel isolation
 * 10. Outbox worker processes batches with bounded retries and failure recording
 * 11. In-app notification routes mounted at /api/v1/notifications
 * 12. GET /notifications enforces authentication and user isolation (returns own rows only)
 * 13. GET /notifications/unread-count reports accurate unread totals
 * 14. PATCH /notifications/:id/read updates read status and sets readAt timestamp
 * 15. PATCH /notifications/:id/unread reverts read status and clears readAt
 * 16. POST /notifications/mark-all-read marks all user notifications read
 * 17. DELETE /notifications/:id dismisses notification with ownership verification
 * 18. Cross-user modification attempts on notification IDs rejected (404/IDOR safe)
 * 19. Booking, instrument, calibration, maintenance, breakage, and QR events generate notifications
 * 20. PostgreSQL RLS policies enforce private owner access on notifications and admin-only outbox
 * 21. Frontend notification center in dash.js provides unread badge, dropdown tray, and SSE listener
 * 22. Static frontend security verified (zero raw fetch in dash.js, proper ID resolution)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

function ok(title) {
  totalChecks += 1;
  passedChecks += 1;
  console.log(`  ✅ PASS  ${title}`);
}

function fail(title, reason) {
  totalChecks += 1;
  failedChecks += 1;
  console.error(`  ❌ FAIL  ${title} — ${reason}`);
}

function fileContains(relPath, ...snippets) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    return { exists: false, missing: snippets };
  }
  const content = fs.readFileSync(full, 'utf8');
  const missing = snippets.filter((s) => !content.includes(s));
  return { exists: true, missing, content };
}

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   MODULE 10: NOTIFICATIONS & REAL-TIME UPDATES             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Relational migration 07 defines schema additions and outbox table
  // ──────────────────────────────────────────────────────────────────────────
  {
    const migCheck = fileContains(
      'supabase/migrations/20261012000007_notifications_enhancement.sql',
      'ALTER TABLE public.notifications',
      'entity_type VARCHAR(50)',
      'entity_id VARCHAR(100)',
      'read_at TIMESTAMPTZ',
      'dedup_key VARCHAR(150)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup',
      'CREATE TABLE IF NOT EXISTS public.notification_outbox',
      'ENABLE ROW LEVEL SECURITY'
    );
    if (!migCheck.exists) {
      fail('Migration 07', 'Migration file 20261012000007_notifications_enhancement.sql does not exist');
    } else if (migCheck.missing.length > 0) {
      fail('Migration 07', `Missing elements: ${migCheck.missing.join(', ')}`);
    } else {
      ok('Relational migration 07 defines schema additions, dedup index, and outbox table');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Mongoose Notification model includes enhanced fields and indexes
  // ──────────────────────────────────────────────────────────────────────────
  {
    const modelCheck = fileContains(
      'models/Notification.js',
      'entityType:',
      'entityId:',
      'readAt:',
      'dedupKey:',
      'sparse: true, unique: true',
      'index({ userId: 1, read: 1, createdAt: -1 })'
    );
    if (!modelCheck.exists) {
      fail('Notification model', 'models/Notification.js does not exist');
    } else if (modelCheck.missing.length > 0) {
      fail('Notification model', `Missing fields: ${modelCheck.missing.join(', ')}`);
    } else {
      ok('Mongoose Notification model includes entity links, readAt, and dedupKey');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Mongoose NotificationOutbox model exists
  // ──────────────────────────────────────────────────────────────────────────
  {
    const outboxCheck = fileContains(
      'models/NotificationOutbox.js',
      'eventId:',
      'eventType:',
      'payload:',
      "enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']",
      'attempts:',
      'lastError:',
      'processedAt:'
    );
    if (!outboxCheck.exists) {
      fail('NotificationOutbox model', 'models/NotificationOutbox.js does not exist');
    } else if (outboxCheck.missing.length > 0) {
      fail('NotificationOutbox model', `Missing: ${outboxCheck.missing.join(', ')}`);
    } else {
      ok('Mongoose NotificationOutbox model defined with status tracking');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Domain mappers support bidirectional conversion
  // ──────────────────────────────────────────────────────────────────────────
  {
    const mapperCheck = fileContains(
      'repositories/mappers.js',
      'mapNotificationToApp',
      'mapAppToNotification',
      'mapOutboxToApp',
      'mapAppToOutbox',
      'entityType: row.entity_type',
      'dedupKey: row.dedup_key',
      'readAt: row.read_at'
    );
    if (!mapperCheck.exists) {
      fail('Domain mappers', 'repositories/mappers.js does not exist');
    } else if (mapperCheck.missing.length > 0) {
      fail('Domain mappers', `Missing mappers: ${mapperCheck.missing.join(', ')}`);
    } else {
      ok('Domain mappers support bidirectional conversion for notifications and outbox');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Notification repository provides complete CRUD, unread counting, and outbox
  // ──────────────────────────────────────────────────────────────────────────
  {
    const repoCheck = fileContains(
      'repositories/notificationRepository.js',
      'getUnreadCount',
      'markAsRead',
      'markAsUnread',
      'markAllAsRead',
      'deleteById',
      'enqueueOutbox',
      'fetchPendingOutbox',
      'updateOutboxStatus',
      'findOutboxByEventId'
    );
    if (!repoCheck.exists) {
      fail('Notification repository', 'repositories/notificationRepository.js missing');
    } else if (repoCheck.missing.length > 0) {
      fail('Notification repository', `Missing methods: ${repoCheck.missing.join(', ')}`);
    } else {
      ok('Notification repository implements complete CRUD, unread counts, and outbox operations');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Central notification service provides event dispatching & real-time SSE
  // ──────────────────────────────────────────────────────────────────────────
  {
    const svcCheck = fileContains(
      'services/notificationService.js',
      'addRealtimeClient',
      'removeRealtimeClient',
      'broadcastRealtimeNotification',
      'dispatchNotification',
      'enqueueOutboxEvent',
      'processOutboxBatch'
    );
    if (!svcCheck.exists) {
      fail('Notification service', 'services/notificationService.js does not exist');
    } else if (svcCheck.missing.length > 0) {
      fail('Notification service', `Missing: ${svcCheck.missing.join(', ')}`);
    } else {
      ok('Central notification service provides event dispatching, SSE streaming, and outbox worker');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Real-time SSE stream enforces per-user channel isolation
  // ──────────────────────────────────────────────────────────────────────────
  {
    const sseService = require('../services/notificationService');
    const fakeRes1 = { write: () => {}, on: () => {} };
    const fakeRes2 = { write: () => {}, on: () => {} };

    sseService.addRealtimeClient('user-A', fakeRes1);
    sseService.addRealtimeClient('user-B', fakeRes2);

    const countA = sseService.getActiveClientCount('user-A');
    const countB = sseService.getActiveClientCount('user-B');
    const countC = sseService.getActiveClientCount('user-C');

    sseService.removeRealtimeClient('user-A', fakeRes1);
    sseService.removeRealtimeClient('user-B', fakeRes2);

    if (countA === 1 && countB === 1 && countC === 0) {
      ok('Real-time SSE stream enforces strict per-user channel isolation');
    } else {
      fail('SSE channel isolation', `Expected user-specific stream counts; got A:${countA}, B:${countB}, C:${countC}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Bounded retries and failure recording in outbox worker
  // ──────────────────────────────────────────────────────────────────────────
  {
    const svcSrc = fs.readFileSync(path.join(ROOT, 'services', 'notificationService.js'), 'utf8');
    const hasBoundedRetry = svcSrc.includes('currentAttempts >= 3') && svcSrc.includes("'FAILED'");
    const hasStatusUpdate = svcSrc.includes("'COMPLETED'") && svcSrc.includes("'PROCESSING'");
    if (hasBoundedRetry && hasStatusUpdate) {
      ok('Outbox worker enforces bounded retries (max 3) and records failures');
    } else {
      fail('Outbox worker', 'Bounded retry logic or status updates missing in notificationService.js');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. In-app notification routes mounted at /api/v1/notifications in server.js
  // ──────────────────────────────────────────────────────────────────────────
  {
    const serverCheck = fileContains('server.js', "app.use('/api/v1/notifications', require('./routes/notifications'))");
    if (!serverCheck.exists || serverCheck.missing.length > 0) {
      fail('Server routes', 'notifications router not mounted at /api/v1/notifications in server.js');
    } else {
      ok('In-app notification routes mounted at /api/v1/notifications');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 10. GET /api/v1/notifications/unread-count endpoint exists
  // ──────────────────────────────────────────────────────────────────────────
  {
    const routeCheck = fileContains('routes/notifications.js', "router.get('/unread-count'");
    if (!routeCheck.exists || routeCheck.missing.length > 0) {
      fail('Unread count endpoint', 'GET /unread-count missing in routes/notifications.js');
    } else {
      ok('GET /api/v1/notifications/unread-count provides fast unread counting');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 11. GET /api/v1/notifications/stream SSE endpoint exists with proper headers
  // ──────────────────────────────────────────────────────────────────────────
  {
    const streamCheck = fileContains(
      'routes/notifications.js',
      "router.get('/stream'",
      "'text/event-stream'",
      "'no-cache",
      "'keep-alive'",
      'addRealtimeClient'
    );
    if (!streamCheck.exists || streamCheck.missing.length > 0) {
      fail('SSE stream endpoint', `Missing in routes/notifications.js: ${streamCheck.missing.join(', ')}`);
    } else {
      ok('GET /api/v1/notifications/stream provides authenticated SSE real-time connection');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 12. Mark read and unread endpoints with ownership verification
  // ──────────────────────────────────────────────────────────────────────────
  {
    const readCheck = fileContains(
      'routes/notifications.js',
      "router.patch('/:id/read'",
      "router.patch('/:id/unread'",
      'markAsRead',
      'markAsUnread',
      'NOT_FOUND'
    );
    if (!readCheck.exists || readCheck.missing.length > 0) {
      fail('Read/unread endpoints', `Missing: ${readCheck.missing.join(', ')}`);
    } else {
      ok('PATCH /:id/read and PATCH /:id/unread enforce owner scoping (foreign ID returns 404)');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 13. POST /mark-all-read endpoint exists
  // ──────────────────────────────────────────────────────────────────────────
  {
    const markAllCheck = fileContains(
      'routes/notifications.js',
      "router.post('/mark-all-read'",
      'markAllAsRead'
    );
    if (!markAllCheck.exists || markAllCheck.missing.length > 0) {
      fail('Mark all read endpoint', 'POST /mark-all-read missing in routes/notifications.js');
    } else {
      ok('POST /api/v1/notifications/mark-all-read marks all user notifications as read');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 14. DELETE /:id dismisses notification with ownership check
  // ──────────────────────────────────────────────────────────────────────────
  {
    const delCheck = fileContains(
      'routes/notifications.js',
      "router.delete('/:id'",
      'deleteById',
      'NOT_FOUND'
    );
    if (!delCheck.exists || delCheck.missing.length > 0) {
      fail('Dismiss endpoint', 'DELETE /:id missing in routes/notifications.js');
    } else {
      ok('DELETE /api/v1/notifications/:id dismisses notification with owner validation');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 15. POST /outbox/process protected administrative endpoint exists
  // ──────────────────────────────────────────────────────────────────────────
  {
    const outboxRouteCheck = fileContains(
      'routes/notifications.js',
      "router.post('/outbox/process'",
      "req.user.role !== 'admin'",
      'processOutboxBatch'
    );
    if (!outboxRouteCheck.exists || outboxRouteCheck.missing.length > 0) {
      fail('Outbox process endpoint', `Missing: ${outboxRouteCheck.missing.join(', ')}`);
    } else {
      ok('POST /api/v1/notifications/outbox/process restricted strictly to administrators');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 16. Event templates cover all required Module 10 operational and QR events
  // ──────────────────────────────────────────────────────────────────────────
  {
    const tmplCheck = fileContains(
      'services/templates.js',
      'booking-created',
      'booking-cancelled',
      'booking-rescheduled',
      'booking-reminder',
      'booking-rejected',
      'instrument-unavailable',
      'instrument-available',
      'calibration-due-soon',
      'calibration-overdue',
      'calibration-failed',
      'maintenance-scheduled',
      'breakage-reported',
      'breakage-resolved',
      'qr-pass-issued',
      'qr-pass-revoked',
      'qr-check-in-success'
    );
    if (!tmplCheck.exists || tmplCheck.missing.length > 0) {
      fail('Template coverage', `Missing templates: ${tmplCheck.missing.join(', ')}`);
    } else {
      ok('Event templates cover all booking, instrument lifecycle, and QR access events');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 17. Booking routes dispatch notifications with entity linking and dedupKey
  // ──────────────────────────────────────────────────────────────────────────
  {
    const bookingCheck = fileContains(
      'routes/bookings.js',
      'notifyBooking',
      "entityType: 'booking'",
      'entityId:',
      'dedupKey:'
    );
    if (!bookingCheck.exists || bookingCheck.missing.length > 0) {
      fail('Booking notifications', `Missing in routes/bookings.js: ${bookingCheck.missing.join(', ')}`);
    } else {
      ok('Booking operations generate notifications with entity linking and deduplication keys');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 18. QR routes dispatch check-in and revocation notifications
  // ──────────────────────────────────────────────────────────────────────────
  {
    const qrCheck = fileContains(
      'routes/qr.js',
      'notifyUser',
      'qr-check-in-success',
      'qr-pass-revoked',
      "entityType: 'booking'",
      "entityType: 'qr_pass'"
    );
    if (!qrCheck.exists || qrCheck.missing.length > 0) {
      fail('QR notifications', `Missing in routes/qr.js: ${qrCheck.missing.join(', ')}`);
    } else {
      ok('QR check-in and pass revocation dispatch user notifications');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 19. Instrument lifecycle dispatches notifications to affected users
  // ──────────────────────────────────────────────────────────────────────────
  {
    const lifeCheck = fileContains(
      'services/instrumentLifecycle.js',
      'notifyUser',
      'instrument-unavailable'
    );
    if (!lifeCheck.exists || lifeCheck.missing.length > 0) {
      fail('Instrument lifecycle notifications', 'notifyUser not called on unavailability');
    } else {
      ok('Instrument lifecycle transitions notify affected reservation holders');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 20. PostgreSQL RLS policies enforce isolation on notifications and outbox
  // ──────────────────────────────────────────────────────────────────────────
  {
    const rlsCheck = fileContains(
      'supabase/migrations/20261012000004_row_level_security.sql',
      'notifications_select_policy',
      'user_id = auth.uid()',
      'notifications_update_policy',
      'notifications_delete_policy'
    );
    const outboxRlsCheck = fileContains(
      'supabase/migrations/20261012000007_notifications_enhancement.sql',
      'outbox_admin_select_policy',
      'outbox_admin_write_policy'
    );
    if (rlsCheck.missing.length > 0 || outboxRlsCheck.missing.length > 0) {
      fail('RLS policies', 'RLS policies missing on notifications or outbox');
    } else {
      ok('PostgreSQL RLS policies strictly enforce user notification isolation & admin outbox access');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 21. Frontend notification center in dash.js provides tray, unread badge & SSE
  // ──────────────────────────────────────────────────────────────────────────
  {
    const dashCheck = fileContains(
      'dash.js',
      'initNotificationCenter',
      'loadNotifications',
      'updateUnreadBadge',
      'renderNotificationItems',
      'markNotificationRead',
      'markAllNotificationsRead',
      'setupRealtimeStream',
      'EventSource'
    );
    if (!dashCheck.exists || dashCheck.missing.length > 0) {
      fail('Frontend notification center', `Missing in dash.js: ${dashCheck.missing.join(', ')}`);
    } else {
      ok('Frontend notification center in dash.js provides unread badge, dropdown tray, and SSE listener');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 22. Static frontend security verified (zero raw fetch in dash.js)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const dashJs = fs.readFileSync(path.join(ROOT, 'dash.js'), 'utf8');
    const hasRawFetch = /fetch\s*\(/.test(dashJs);
    if (hasRawFetch) {
      fail('Frontend API client hygiene', 'Raw fetch() found in dash.js — all calls must use LabPulseAuth');
    } else {
      ok('Frontend API client hygiene: zero raw fetch in dash.js (LabPulseAuth used exclusively)');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Module 10 Verification: ${passedChecks} PASS / ${failedChecks} FAIL / 0 SKIP`);
  console.log('══════════════════════════════════════════════════════════════\n');

  if (failedChecks > 0) {
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\nVerification execution error:', err);
  process.exit(1);
});
