/** calibrations model — spec §9/§14. Calibration windows block availability (enforced Phase 06). */
const mongoose = require('mongoose');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const calibrationSchema = new mongoose.Schema(
  {
    instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument', required: true },
    technicianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    calibrationType: { type: String, required: true, trim: true, maxlength: 120 },
    date: { type: Date, required: true },
    startTime: { type: String, required: true, match: [HHMM, 'startTime must be HH:mm'] },
    endTime: { type: String, required: true, match: [HHMM, 'endTime must be HH:mm'] },
    standard: { type: String, trim: true, maxlength: 160 },
    status: {
      type: String, default: 'CALIBRATION_SCHEDULED',
      enum: ['CALIBRATED', 'CALIBRATION_DUE', 'CALIBRATION_SCHEDULED', 'UNDER_CALIBRATION', 'CALIBRATION_OVERDUE', 'CERTIFICATE_PENDING'],
    },
    // Module 08: Metrology outcomes and certificate references
    result: {
      type: String,
      default: 'PENDING',
      enum: ['PASSED', 'FAILED', 'PENDING'],
    },
    performedDate: { type: Date },
    referenceStandard: { type: String, trim: true, maxlength: 160 },
    certificateNumber: { type: String, trim: true, maxlength: 120 },
    drift: { type: String, trim: true, maxlength: 120 },
    tolerance: { type: String, trim: true, maxlength: 120 },
    certificateUrl: { type: String, trim: true, maxlength: 500 },
    notes: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

calibrationSchema.index({ instrumentId: 1, date: 1, status: 1 });

module.exports = mongoose.model('Calibration', calibrationSchema);
