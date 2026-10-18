/** LaboratoryMembership model — Module 12 Laboratory Membership Management */
const mongoose = require('mongoose');

const membershipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    laboratoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Laboratory', required: true },
    role: {
      type: String,
      default: 'MEMBER',
      enum: ['MEMBER', 'MANAGER', 'PI', 'SUPERVISOR'],
    },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

membershipSchema.index({ userId: 1, laboratoryId: 1 }, { unique: true });
membershipSchema.index({ laboratoryId: 1 });

module.exports = mongoose.model('LaboratoryMembership', membershipSchema);
