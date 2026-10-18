/**
 * Notification Outbox Model (Module 10)
 * Transactional outbox for durable, retryable notification delivery.
 */
const mongoose = require('mongoose');

const notificationOutboxSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, trim: true, maxlength: 150 },
    eventType: { type: String, required: true, trim: true, maxlength: 80 },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, trim: true, maxlength: 1000 },
    processedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

notificationOutboxSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('NotificationOutbox', notificationOutboxSchema);
