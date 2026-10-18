/**
 * auditLogs model — Module 13 Audit Logs & Compliance Reporting
 * Append-only; strictly immutable. No update/delete operations permitted.
 * Sensitive fields (passwords, tokens, secrets) must never be written here.
 */
const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String, trim: true, maxlength: 50 },
    action: { type: String, required: true, trim: true, maxlength: 120 },
    resource: { type: String, required: true, trim: true, maxlength: 120 },
    resourceId: { type: String, trim: true, maxlength: 120 },
    laboratoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Laboratory' },
    status: {
      type: String,
      enum: ['SUCCESS', 'FAILURE', 'DENIED'],
      default: 'SUCCESS',
      required: true,
    },
    details: { type: mongoose.Schema.Types.Mixed },
    ipAddress: { type: String, trim: true, maxlength: 80 },
    userAgent: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditSchema.index({ createdAt: -1 });
auditSchema.index({ action: 1, resource: 1, createdAt: -1 });
auditSchema.index({ userId: 1, createdAt: -1 });
auditSchema.index({ laboratoryId: 1, createdAt: -1 });
auditSchema.index({ status: 1, createdAt: -1 });
auditSchema.index({ actorRole: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditSchema);
