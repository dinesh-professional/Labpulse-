/**
 * qrAccessPasses model — spec §12/§14.
 * Store only tokenHash, never the raw token. Single-use check-in enforced Phase 10.
 */
const mongoose = require('mongoose');

const qrSchema = new mongoose.Schema(
  {
    // One ACTIVE pass per booking; rotated passes stay as REVOKED history (no unique index —
    // rotation revokes-then-creates, so a unique constraint would reject reissue).
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    checkedInAt: { type: Date },
    status: { type: String, default: 'ACTIVE', enum: ['ACTIVE', 'USED', 'EXPIRED', 'REVOKED'] },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

qrSchema.index({ bookingId: 1, status: 1 });
qrSchema.index({ expiresAt: 1 });
qrSchema.index({ status: 1 });

module.exports = mongoose.model('QrAccessPass', qrSchema);
