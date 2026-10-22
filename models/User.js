/** users model — spec §14. Roles: admin|faculty|student. Passwords: store hash only (never plaintext). */
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String, required: true, trim: true, lowercase: true, maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email'],
    },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: ['admin', 'faculty', 'student'], default: 'student' },
    department: { type: String, trim: true, maxlength: 120 },
    facultyId: { type: String, trim: true, maxlength: 60 },
    studentId: { type: String, trim: true, maxlength: 60 },
    year: { type: String, trim: true, maxlength: 20 },
    section: { type: String, trim: true, maxlength: 20 },
    supabaseUid: { type: String, sparse: true, unique: true },
    isActive: { type: Boolean, default: true },
    emailVerified: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Phase 02: refresh-token version (rotation/invalidation) + reset/activation tokens (hashes only at rest)
    tokenVersion: { type: Number, default: 0 },
    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpires: { type: Date },
    activationTokenHash: { type: String, select: false },
    activationExpires: { type: Date },
    otpHash: { type: String, select: false },
    otpExpires: { type: Date },
    otpAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ facultyId: 1 }, { sparse: true, unique: true });
userSchema.index({ role: 1, isActive: 1 });

// Never serialize the password hash or token hashes
userSchema.methods.toSafeJSON = function () {
  const o = this.toObject();
  delete o.passwordHash;
  delete o.passwordResetTokenHash;
  delete o.activationTokenHash;
  delete o.otpHash;
  return o;
};

module.exports = mongoose.model('User', userSchema);
