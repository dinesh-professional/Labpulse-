/** laboratories model — spec §14. Schedules reference laboratoryId. */
const mongoose = require('mongoose');

const laboratorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    department: { type: String, trim: true, maxlength: 120 },
    building: { type: String, trim: true, maxlength: 120 },
    roomNumber: { type: String, trim: true, maxlength: 40 },
    capacity: { type: Number, min: 0, max: 10000 },
    status: {
      type: String, default: 'AVAILABLE',
      enum: ['AVAILABLE', 'UNAVAILABLE', 'UNDER_MAINTENANCE', 'CLOSED'],
    },
  },
  { timestamps: true }
);

laboratorySchema.index({ name: 1 });
laboratorySchema.index({ status: 1 });

module.exports = mongoose.model('Laboratory', laboratorySchema);
