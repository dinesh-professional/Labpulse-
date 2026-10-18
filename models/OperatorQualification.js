/** operatorQualifications model — spec §13/§14 + Module 12 Lifecycle */
const mongoose = require('mongoose');

const qualSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument' },
    scope: { type: String, trim: true, maxlength: 160 },
    category: { type: String, trim: true, maxlength: 100 },
    level: { type: Number, required: true, min: 1, max: 4 },
    certifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    certifiedAt: { type: Date },
    expiresAt: { type: Date },
    status: {
      type: String,
      default: 'ACTIVE',
      enum: ['ACTIVE', 'EXPIRED', 'SUSPENDED', 'PENDING', 'REJECTED', 'REVOKED'],
    },
    evidenceUrl: { type: String, trim: true, maxlength: 500 },
    evidenceNotes: { type: String, trim: true, maxlength: 2000 },
    rejectionReason: { type: String, trim: true, maxlength: 1000 },
    revocationReason: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

qualSchema.index({ userId: 1, instrumentId: 1 }, { unique: true, sparse: true });
qualSchema.index({ status: 1, expiresAt: 1 });
qualSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('OperatorQualification', qualSchema);
