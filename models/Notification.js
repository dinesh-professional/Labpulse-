/** notifications model — spec §14. emailSent/Attempts/Error record delivery without rollback. */
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true, trim: true, maxlength: 80 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    emailSent: { type: Boolean, default: false },
    emailAttempts: { type: Number, default: 0 },
    emailError: { type: String, trim: true, maxlength: 500 },
    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
    entityType: { type: String, trim: true, maxlength: 50 },
    entityId: { type: String, trim: true, maxlength: 100 },
    dedupKey: { type: String, trim: true, maxlength: 150, sparse: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
