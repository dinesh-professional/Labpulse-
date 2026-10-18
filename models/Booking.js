/**
 * bookings model (Module 07: Complete Booking Lifecycle).
 * Booking is FREE. Deliberately NO price/rate/grant/chargeback fields.
 * Explicit statuses: PENDING_APPROVAL, CONFIRMED, CHECKED_IN, COMPLETED, CANCELLED, REJECTED, NO_SHOW.
 */
const mongoose = require('mongoose');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const bookingSchema = new mongoose.Schema(
  {
    instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true },
    startTime: { type: String, required: true, match: [HHMM, 'startTime must be HH:mm'] },
    endTime: { type: String, required: true, match: [HHMM, 'endTime must be HH:mm'] },
    purpose: { type: String, required: true, trim: true, maxlength: 500 },
    status: {
      type: String,
      default: 'CONFIRMED',
      enum: ['PENDING_APPROVAL', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'],
    },
    qrPassId: { type: mongoose.Schema.Types.ObjectId, ref: 'QrAccessPass' },
    idempotencyKey: { type: String, trim: true, sparse: true },
    approvalNotes: { type: String, trim: true, maxlength: 500 },
    rejectionReason: { type: String, trim: true, maxlength: 500 },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
  },
  { timestamps: true }
);

bookingSchema.index({ instrumentId: 1, date: 1, status: 1 });
bookingSchema.index({ userId: 1, date: 1 });
bookingSchema.index({ idempotencyKey: 1, userId: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
