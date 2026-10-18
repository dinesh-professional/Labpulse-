/**
 * breakageReports model — spec §11/§14.
 * Fee is admin-set on confirmed damage only. Faculty/Student can never set it (enforced Phase 08).
 */
const mongoose = require('mongoose');

const breakageSchema = new mongoose.Schema(
  {
    instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument', required: true },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    issueType: { type: String, required: true, trim: true, maxlength: 120 },
    severity: { type: String, required: true, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
    evidence: { type: String, trim: true, maxlength: 2000 },
    status: {
      type: String, default: 'REPORTED',
      enum: ['REPORTED', 'UNDER_REVIEW', 'CONFIRMED', 'REJECTED', 'RESOLVED'],
    },
    breakageFee: { type: Number, min: 0, default: 0 },
    adminReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    confirmedAt: { type: Date },
    resolvedAt: { type: Date },
    // Module 08: Linkage to maintenance and authorized return-to-service
    maintenanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Maintenance' },
    resolutionNotes: { type: String, trim: true, maxlength: 2000 },
    returnToServiceBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    returnToServiceAt: { type: Date },
  },
  { timestamps: true }
);

breakageSchema.index({ instrumentId: 1, status: 1 });
breakageSchema.index({ reportedBy: 1 });

module.exports = mongoose.model('BreakageReport', breakageSchema);
