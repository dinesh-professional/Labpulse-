/**
 * Notification Service (Module 10)
 * Central engine for event-to-notification mapping, real-time SSE streaming,
 * and reliable transactional outbox processing.
 */
const { notificationRepository } = require('../repositories');
const { sendEmail } = require('./email');

// In-memory active Server-Sent Events (SSE) connections indexed by user ID
const sseClients = new Map();

/**
 * Register an active SSE response stream for a user.
 */
function addRealtimeClient(userId, res) {
  const uid = String(userId);
  if (!sseClients.has(uid)) {
    sseClients.set(uid, new Set());
  }
  sseClients.get(uid).add(res);

  // Send initial connected confirmation
  res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

  // Handle client disconnect
  res.on('close', () => {
    removeRealtimeClient(uid, res);
  });
}

/**
 * Deregister an SSE response stream.
 */
function removeRealtimeClient(userId, res) {
  const uid = String(userId);
  const userSet = sseClients.get(uid);
  if (userSet) {
    userSet.delete(res);
    if (userSet.size === 0) {
      sseClients.delete(uid);
    }
  }
}

/**
 * Broadcast an event payload to all active SSE streams belonging to a user.
 * Guarantees zero cross-user event leakage.
 */
function broadcastRealtimeNotification(userId, notification) {
  if (!userId) return 0;
  const uid = String(userId);
  const clientSet = sseClients.get(uid);
  if (!clientSet || clientSet.size === 0) return 0;

  const payload = JSON.stringify(notification);
  let delivered = 0;
  for (const client of clientSet) {
    try {
      client.write(`event: notification\ndata: ${payload}\n\n`);
      delivered += 1;
    } catch (err) {
      // Socket write error, client dropped
      clientSet.delete(client);
    }
  }
  return delivered;
}

/**
 * Send heartbeat ping to all active SSE clients.
 */
function broadcastHeartbeat() {
  for (const [, set] of sseClients.entries()) {
    for (const client of set) {
      try {
        client.write(': keepalive\n\n');
      } catch (_) {
        set.delete(client);
      }
    }
  }
}

// Optional interval heartbeat (every 30 seconds)
let heartbeatInterval = null;
function startHeartbeat(intervalMs = 30000) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(broadcastHeartbeat, intervalMs);
  if (heartbeatInterval.unref) heartbeatInterval.unref();
}

function stopHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

/**
 * Core notification dispatcher with optional email and live real-time push.
 * Never throws runtime errors into calling HTTP handlers.
 */
async function dispatchNotification({
  userId,
  type,
  title,
  message,
  entityType = null,
  entityId = null,
  dedupKey = null,
  email = null,
}) {
  let emailSent = false;
  let emailAttempts = 0;
  let emailError = null;

  if (email) {
    try {
      const outcome = await sendEmail(email);
      emailSent = !!outcome.sent;
      emailAttempts = outcome.attempts || 0;
      if (!emailSent) emailError = outcome.error || 'send failed';
    } catch (err) {
      emailError = String(err.message || 'send failed').slice(0, 500);
    }
  }

  let notification = null;
  try {
    notification = await notificationRepository.create({
      userId,
      type,
      title,
      message,
      entityType,
      entityId,
      ...(dedupKey ? { dedupKey } : {}),
      emailSent,
      emailAttempts,
      ...(emailError ? { emailError } : {}),
    });
  } catch (err) {
    console.warn('[notificationService] Failed to persist notification:', err.message);
  }

  // Live real-time dispatch if user has active SSE connection
  if (notification) {
    broadcastRealtimeNotification(userId, notification);
  }

  return { notification, emailSent, emailAttempts };
}

/**
 * Enqueue a notification event to the durable transactional outbox.
 */
async function enqueueOutboxEvent({
  eventId,
  eventType,
  recipientUserId,
  title,
  message,
  entityType = null,
  entityId = null,
  dedupKey = null,
  email = null,
}) {
  const payload = {
    userId: recipientUserId,
    type: eventType,
    title,
    message,
    entityType,
    entityId,
    dedupKey: dedupKey || eventId,
    email,
  };

  return notificationRepository.enqueueOutbox({
    eventId,
    eventType,
    payload,
  });
}

/**
 * Process a batch of pending events from the transactional outbox with bounded retries.
 */
async function processOutboxBatch(batchSize = 50) {
  const pendingEvents = await notificationRepository.fetchPendingOutbox(batchSize);
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const item of pendingEvents) {
    processed += 1;
    const currentAttempts = (item.attempts || 0) + 1;
    const payload = item.payload || {};

    try {
      // Mark as processing
      await notificationRepository.updateOutboxStatus(item.id, {
        status: 'PROCESSING',
        attempts: currentAttempts,
      });

      // Dispatch notification
      const result = await dispatchNotification(payload);

      // Mark completed
      await notificationRepository.updateOutboxStatus(item.id, {
        status: 'COMPLETED',
        attempts: currentAttempts,
        processedAt: new Date(),
      });
      succeeded += 1;
    } catch (err) {
      const isExhausted = currentAttempts >= 3;
      await notificationRepository.updateOutboxStatus(item.id, {
        status: isExhausted ? 'FAILED' : 'PENDING',
        attempts: currentAttempts,
        lastError: String(err.message || 'Processing error').slice(0, 1000),
      });
      failed += 1;
    }
  }

  return { processed, succeeded, failed };
}

module.exports = {
  addRealtimeClient,
  removeRealtimeClient,
  broadcastRealtimeNotification,
  startHeartbeat,
  stopHeartbeat,
  dispatchNotification,
  enqueueOutboxEvent,
  processOutboxBatch,
  // Inspection helper for tests
  getActiveClientCount: (uid) => (sseClients.get(String(uid)) ? sseClients.get(String(uid)).size : 0),
};
