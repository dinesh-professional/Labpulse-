/** maintenance model — spec §10/§14. Routine maintenance never creates a breakage fee. */
const mongoose = require('mongoose');

const maintenanceSchema = new mongoose.Schema(
  {
    instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument', required: true },
    type: { type: String, required: true, enum: ['preventive', 'corrective'] },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
    startDate: { type: Date, required: true },
    endDate: { type: Date },
    startTime: { type: String, trim: true, maxlength: 5 },
    endTime: { type: String, trim: true, maxlength: 5 },
    status: {
      type: String, default: 'SCHEDULED',
      enum: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    },
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Phase 07 (§10): completion with requiresCalibration=true raises a CALIBRATION_DUE record.
    // Routine maintenance never creates a breakage fee.
    requiresCalibration: { type: Boolean, default: false },
    // Module 08: Work performed and resolution details
    workPerformed: { type: String, trim: true, maxlength: 4000 },
    partsReplaced: { type: String, trim: true, maxlength: 2000 },
    resolutionNotes: { type: String, trim: true, maxlength: 2000 },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

maintenanceSchema.index({ instrumentId: 1, status: 1, startDate: 1 });

module.exports = mongoose.model('Maintenance', maintenanceSchema);
