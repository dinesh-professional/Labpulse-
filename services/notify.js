/**
 * Central notification helper (Phase 09 / Module 06 & Module 10).
 * Every operational event funnels here: one in-app Notification row + one optional email,
 * with delivery status recorded and real-time push dispatched.
 * Never throws into request handlers — failures are recorded, never rolled back.
 *
 * notifyUser({
 *   userId,
 *   type,
 *   title,
 *   message,
 *   entityType,
 *   entityId,
 *   dedupKey,
 *   email,
 *   useOutbox,
 *   eventId
 * })
 */
const { dispatchNotification, enqueueOutboxEvent } = require('./notificationService');

async function notifyUser({
  userId,
  type,
  title,
  message,
  entityType = null,
  entityId = null,
  dedupKey = null,
  email = null,
  useOutbox = false,
  eventId = null,
}) {
  if (useOutbox) {
    const eid = eventId || dedupKey || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    await enqueueOutboxEvent({
      eventId: eid,
      eventType: type,
      recipientUserId: userId,
      title,
      message,
      entityType,
      entityId,
      dedupKey,
      email,
    });
    return { queued: true, emailSent: false, emailAttempts: 0 };
  }

  const outcome = await dispatchNotification({
    userId,
    type,
    title,
    message,
    entityType,
    entityId,
    dedupKey,
    email,
  });

  return {
    emailSent: outcome.emailSent,
    emailAttempts: outcome.emailAttempts,
    notification: outcome.notification,
  };
}

module.exports = { notifyUser };
