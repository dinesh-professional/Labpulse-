/**
 * First-admin provisioning (spec §4: controlled setup, never public registration).
 * Usage: ADMIN_NAME="..." ADMIN_EMAIL="..." ADMIN_PASSWORD="..." MONGODB_URI="..." node scripts/seed-admin.js
 * - Validates email + password policy before touching the DB.
 * - Refuses if the email is taken. Password is bcrypt-hashed; never printed or logged.
 * - After first login, rotate via the forgot-password flow and unset these env vars.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI || '';
  const name = (process.env.ADMIN_NAME || '').trim();
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(2); }
  if (!name || !email) { console.error('ADMIN_NAME and ADMIN_EMAIL are required.'); process.exit(2); }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('ADMIN_EMAIL is invalid.'); process.exit(2); }
  const { validatePasswordPolicy, hashPassword } = require('../utils/password');
  const policyError = validatePasswordPolicy(password);
  if (policyError) { console.error(`ADMIN_PASSWORD rejected: ${policyError}`); process.exit(2); }

  const { connectDB } = require('../config/db');
  await connectDB(uri);
  const User = require('../models/User');
  const existing = await User.findOne({ email });
  if (existing) { console.error('An account with that email already exists. Nothing created.'); process.exit(1); }
  const adminCount = await User.countDocuments({ role: 'admin' });
  if (adminCount > 0) {
    console.warn(`Warning: ${adminCount} admin(s) already exist; creating an additional one.`);
  }
  const admin = await User.create({
    name: name.slice(0, 120), email, passwordHash: await hashPassword(password),
    role: 'admin', isActive: true, emailVerified: true,
  });
  console.log(`Admin created: ${admin.email} (${admin._id}). Rotate the password after first login.`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(`seed-admin FAIL: ${e.message}`); process.exit(1); });
