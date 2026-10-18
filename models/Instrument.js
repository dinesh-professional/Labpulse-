/**
 * instruments model — spec §7/§14.
 * breakageFee = configurable placeholder for confirmed damage only (§11). Never an hourly/usage fee.
 */
const mongoose = require('mongoose');

const instrumentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, required: true, trim: true, maxlength: 80 },
    model: { type: String, trim: true, maxlength: 120 },
    serialNumber: { type: String, required: true, trim: true, maxlength: 80 },
    status: {
      type: String, default: 'AVAILABLE',
      enum: ['AVAILABLE', 'IN_SESSION', 'UNDER_CALIBRATION', 'UNDER_MAINTENANCE', 'OUT_OF_ORDER', 'LOCKED'],
    },
    breakageFee: { type: Number, min: 0, default: 0 },
    // Phase 05 (§13): minimum operator level required to book. 0 = open to all authenticated bookers.
    requiredQualificationLevel: { type: Number, min: 0, max: 4, default: 0 },
    lastCalibrationDate: { type: Date },
    nextCalibrationDue: { type: Date },
    calibrationFrequencyDays: { type: Number, min: 0, max: 3650 },
    laboratoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Laboratory' },
    // Module 08: Lifecycle state separation & asset metadata
    lifecycleState: {
      type: String,
      default: 'COMMISSIONED',
      enum: ['COMMISSIONED', 'DECOMMISSIONED', 'RETIRED', 'DISPOSED'],
    },
    assetTag: { type: String, trim: true, maxlength: 80 },
    manufacturer: { type: String, trim: true, maxlength: 120 },
    location: { type: String, trim: true, maxlength: 160 },
    responsiblePerson: { type: String, trim: true, maxlength: 160 },
    installationDate: { type: Date },
    decommissionedDate: { type: Date },
    operationalRestrictions: { type: String, trim: true, maxlength: 2000 },
    unavailabilityReason: { type: String, trim: true, maxlength: 2000 },
    notes: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

instrumentSchema.index({ serialNumber: 1 }, { unique: true });
instrumentSchema.index({ category: 1, status: 1 });
instrumentSchema.index({ nextCalibrationDue: 1 });

module.exports = mongoose.model('Instrument', instrumentSchema);
