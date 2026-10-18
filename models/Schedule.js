/**
 * schedules model — spec §6/§14.
 * facultyId MUST come from authenticated account (Phase 04), never trusted from client.
 * Dates stored as UTC Date; startTime/endTime as HH:mm strings validated here.
 */
const mongoose = require('mongoose');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const scheduleSchema = new mongoose.Schema(
  {
    degree: { type: String, required: true, trim: true, maxlength: 120 },
    department: { type: String, required: true, trim: true, maxlength: 120 },
    year: { type: String, required: true, trim: true, maxlength: 20 },
    section: { type: String, required: true, trim: true, maxlength: 20 },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    laboratoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Laboratory', required: true },
    facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true },
    startTime: { type: String, required: true, match: [HHMM, 'startTime must be HH:mm'] },
    endTime: { type: String, required: true, match: [HHMM, 'endTime must be HH:mm'] },
    status: { type: String, default: 'SCHEDULED', enum: ['SCHEDULED', 'CANCELLED', 'COMPLETED'] },
    sessionType: { type: String, trim: true, maxlength: 60 },
    studentCount: { type: Number, min: 0, max: 10000 },
    notes: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

scheduleSchema.index({ laboratoryId: 1, date: 1, status: 1 });
scheduleSchema.index({ facultyId: 1, date: 1 });

module.exports = mongoose.model('Schedule', scheduleSchema);
