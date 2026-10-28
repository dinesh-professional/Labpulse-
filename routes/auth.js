/**
 * Auth routes (Phase 02 / Module 06) — spec §4 + §15.
 * POST /auth/login | POST /auth/logout | POST /auth/refresh | GET /auth/me
 * POST /auth/forgot-password | POST /auth/reset-password | POST /auth/activate
 *
 * Security: bcrypt hashes only; opaque reset/activation tokens (sha256 at rest,
 * 1h expiry, single-use); JWT access 15m + rotating refresh (tokenVersion);
 * generic forgot-password response (no account enumeration); strict body allowlists.
 * Backed by userRepository (dual Supabase PostgreSQL / MongoDB support).
 */
const express = require('express');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { userRepository } = require('../repositories');
const { dbState } = require('../config/db');
const { isSupabaseConfigured, getActiveDataBackend } = require('../config/supabase');
const { getAuthSecrets } = require('../config/auth');
const { validatePasswordPolicy, hashPassword, verifyPassword } = require('../utils/password');
const {
  signAccessToken, signRefreshToken, verifyRefreshToken,
  issueOpaqueToken, hashOpaqueToken,
} = require('../utils/tokens');
const { notifyUser } = require('../services/notify');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const sensitiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: 'draft-7', legacyHeaders: false });

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_COOKIE = 'lp_refresh';
const COOKIE_PATH = '/api/v1/auth';

/** 503 when DB is down (safe-startup consistency: API degrades, frontend still served). */
function requireDB(req, res, next) {
  if (getActiveDataBackend() === 'supabase') {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
    }
    return next();
  }
  if (dbState() !== 1) {
    return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
  }
  return next();
}

/** Reject unexpected fields (spec §16 input security). */
function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}` : null;
}

function asString(v) {
  return typeof v === 'string' ? v : '';
}

function setRefreshCookie(res, token, isProd) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!isProd,
    path: COOKIE_PATH,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
}

function issuePair(user, secrets) {
  return {
    accessToken: signAccessToken(user, secrets.accessSecret),
    refreshToken: signRefreshToken(user, secrets.refreshSecret),
  };
}

function formatSafeUser(u) {
  if (!u) return null;
  if (typeof u.toSafeJSON === 'function') return u.toSafeJSON();
  return {
    id: u.id || u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department || null,
    facultyId: u.facultyId || null,
    studentId: u.studentId || null,
    year: u.year || null,
    section: u.section || null,
    isActive: u.isActive !== false,
  };
}

/* ---------------- LOGIN ---------------- */
router.post('/login', loginLimiter, requireDB, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, ['email', 'password']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const email = asString(req.body.email).trim().toLowerCase();
    const password = asString(req.body.password);
    if (!email || !password) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Email and password are required.' } });
    }
    const user = await userRepository.findWithPasswordByEmail(email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, error: { code: 'ACCOUNT_INACTIVE', message: 'Account is deactivated.' } });
    }
    const secrets = getAuthSecrets();
    const pair = issuePair(user, secrets);
    setRefreshCookie(res, pair.refreshToken, secrets.isProd);
    return res.json({ success: true, data: { user: formatSafeUser(user), accessToken: pair.accessToken }, message: 'Logged in.' });
  } catch (err) { return next(err); }
});

/* ---------------- LOGOUT (invalidates refresh via version bump) ---------------- */
router.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies ? req.cookies[REFRESH_COOKIE] : null;
    if (token) {
      try {
        const secrets = getAuthSecrets();
        const payload = verifyRefreshToken(token, secrets.refreshSecret);
        // Invalidates refresh token via tokenVersion increment: $inc: { tokenVersion: 1 }
        await userRepository.incrementTokenVersion(payload.sub);
      } catch (_) { /* expired/forged: still clear cookie, still succeed */ }
    }
    clearRefreshCookie(res);
    return res.json({ success: true, message: 'Logged out.' });
  } catch (err) { return next(err); }
});

/* ---------------- REFRESH (rotation: old token dies) ---------------- */
router.post('/refresh', requireDB, async (req, res, next) => {
  try {
    const token = (req.cookies && req.cookies[REFRESH_COOKIE]) || asString(req.body && req.body.refreshToken);
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Refresh token required.' } });
    }
    const secrets = getAuthSecrets();
    let payload;
    try {
      payload = verifyRefreshToken(token, secrets.refreshSecret);
    } catch (_) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired refresh token.' } });
    }
    const user = await userRepository.findById(payload.sub);
    if (!user || !user.isActive || (user.tokenVersion || 0) !== (payload.v || 0)) {
      clearRefreshCookie(res);
      return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired refresh token.' } });
    }
    await userRepository.bumpTokenVersion(user.id || user._id);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    const pair = issuePair(user, secrets);
    setRefreshCookie(res, pair.refreshToken, secrets.isProd);
    return res.json({ success: true, data: { accessToken: pair.accessToken } });
  } catch (err) { return next(err); }
});

/* ---------------- ME ---------------- */
router.get('/me', requireDB, requireAuth, (req, res) => {
  return res.json({ success: true, data: { user: formatSafeUser(req.user) } });
});

/* ---------------- FORGOT (always generic) ---------------- */
router.post('/forgot-password', sensitiveLimiter, requireDB, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, ['email']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const email = asString(req.body.email).trim().toLowerCase();
    const generic = { success: true, message: 'If an account exists for that email, a reset link has been sent.' };
    if (!email) return res.json(generic);
    const user = await userRepository.findByEmail(email);
    // Generic response either way — no account enumeration.
    if (user && user.isActive) {
      const { token, tokenHash } = issueOpaqueToken();
      const userId = user.id || user._id;
      await userRepository.updateById(userId, {
        passwordResetTokenHash: tokenHash,
        passwordResetExpires: new Date(Date.now() + RESET_TTL_MS),
      });
      // Delivery failure must not roll back the token write; status is recorded on the notification.
      await notifyUser({
        userId, type: 'password-reset', title: 'LabPulse password reset',
        message: `Password reset requested for ${user.email}. The link expires in 60 minutes.`,
        email: {
          to: user.email, subject: 'LabPulse password reset', template: 'password-reset',
          data: { name: user.name, resetToken: token, expiresInMinutes: 60 },
        },
      });
    }
    return res.json(generic);
  } catch (err) { return next(err); }
});

/* ---------------- RESET (single-use, expiry-enforced) ---------------- */
router.post('/reset-password', sensitiveLimiter, requireDB, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, ['token', 'password']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const token = asString(req.body.token);
    const policyError = validatePasswordPolicy(req.body.password);
    if (!token || policyError) {
      const msg = !token ? 'Reset token is required.' : policyError;
      const code = !token ? 'VALIDATION_ERROR' : 'WEAK_PASSWORD';
      return res.status(400).json({ success: false, error: { code, message: msg } });
    }
    let user = await userRepository.findByResetToken(hashOpaqueToken(token));
    if (!user || !user.isActive) {
      const actUser = await userRepository.findByActivationToken(hashOpaqueToken(token));
      if (actUser) {
        actUser.passwordHash = await hashPassword(req.body.password);
        actUser.activationTokenHash = undefined;
        actUser.activationExpires = undefined;
        actUser.emailVerified = true;
        actUser.isActive = true;
        const actId = actUser.id || actUser._id;
        await userRepository.updateById(actId, {
          passwordHash: actUser.passwordHash,
          activationTokenHash: null,
          activationExpires: null,
          emailVerified: true,
          isActive: true,
        });
        await notifyUser({
          userId: actId, type: 'account-activated', title: 'LabPulse account activated',
          message: `Welcome, ${actUser.name}. Your account is active — please log in.`,
          email: null,
        });
        return res.json({ success: true, message: 'Account activated. Please log in.' });
      }
      return res.status(400).json({ success: false, error: { code: 'INVALID_OR_EXPIRED_TOKEN', message: 'Reset link is invalid or expired.' } });
    }
    user.passwordHash = await hashPassword(req.body.password);
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpires = undefined;
    user.tokenVersion = (user.tokenVersion || 0) + 1; // invalidates old sessions on reset
    user.emailVerified = true;
    const userId = user.id || user._id;
    await userRepository.updateById(userId, {
      passwordHash: user.passwordHash,
      passwordResetTokenHash: null,
      passwordResetExpires: null,
      emailVerified: true,
      tokenVersion: user.tokenVersion,
    });
    await notifyUser({
      userId, type: 'password-changed', title: 'LabPulse password changed',
      message: `The password for ${user.email} was just changed. If this was not you, contact an administrator.`,
      email: {
        to: user.email, subject: 'LabPulse password changed', template: 'password-changed',
        data: { name: user.name },
      },
    });
    return res.json({ success: true, message: 'Password has been reset. Please log in.' });
  } catch (err) { return next(err); }
});

/* ---------------- SIGNUP (student-only public registration; role forced by backend) ---------------- */
router.post('/signup', sensitiveLimiter, requireDB, async (req, res, next) => {
  try {
    const allowed = allowOnly(req.body, ['name', 'email', 'password', 'confirmPassword', 'department', 'studentId', 'year', 'section']);
    if (allowed) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: allowed } });

    const { name, email, password, confirmPassword, department, studentId, year, section } = req.body;

    // password match
    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, error: { code: 'PASSWORD_MISMATCH', message: 'Passwords do not match.' } });
    }

    // password policy re-use existing validator
    const policyError = validatePasswordPolicy(password);
    if (policyError) {
      return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: policyError } });
    }

    // normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // reject role fields implicitly — never trust role from frontend
    // explicitly set role to STUDENT regardless of what client sends
    const role = 'student';

    // duplicate email check
    const existing = await userRepository.findByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ success: false, error: { code: 'DUPLICATE_EMAIL', message: 'An account with this email already exists.' } });
    }

    // hash password
    const hashed = await hashPassword(password);

    // create activation token and 6-digit numeric OTP
    const { token, tokenHash } = issueOpaqueToken();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // 6-digit numeric OTP (10-minute expiry)
    const otp = String(crypto.randomInt(100000, 1000000));
    const otpHash = hashOpaqueToken(otp);
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const creatorId = req.user ? (req.user._id || req.user.id) : undefined;
    const user = await userRepository.create({
      name,
      email: normalizedEmail,
      passwordHash: hashed,
      role,
      department: department || undefined,
      studentId: studentId || undefined,
      year: year ? String(year) : undefined,
      section: section || undefined,
      isActive: false,
      emailVerified: false,
      activationTokenHash: tokenHash,
      activationExpires: expires,
      otpHash,
      otpExpires,
      otpAttempts: 0,
      createdBy: creatorId,
    });

    const targetUserId = user._id || user.id;

    // Send OTP email (using Gmail SMTP)
    const notifyOutcome = await notifyUser({
      userId: targetUserId,
      type: 'account-otp',
      title: 'LabPulse verification code',
      message: `Your verification code is ${otp}. Valid for 10 minutes.`,
      email: {
        to: user.email,
        subject: 'LabPulse — Your 6-Digit Verification Code',
        template: 'account-otp',
        data: { name, otp, expiresInMinutes: 10, activationToken: token },
      },
    });

    if (process.env.NODE_ENV !== 'test') {
      if (notifyOutcome && notifyOutcome.emailSent) {
        console.log(`[auth:signup] OTP verification code delivered to ${normalizedEmail}`);
      } else {
        console.warn(`[auth:signup] Warning: Email delivery to ${normalizedEmail} failed (${(notifyOutcome && notifyOutcome.emailError) || 'undelivered'}). OTP code is: ${otp}`);
      }
    }

    return res.status(201).json({
      success: true,
      requiresOtp: true,
      email: normalizedEmail,
      message: 'Account created. Please enter the verification code sent to your email.',
      ...(process.env.NODE_ENV !== 'production' ? { devOtp: otp } : {}),
    });
  } catch (err) { return next(err); }
});

/* ---------------- VERIFY OTP (6-digit email verification) ---------------- */
router.post('/verify-otp', sensitiveLimiter, requireDB, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, ['email', 'otp']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });

    const email = asString(req.body.email).trim().toLowerCase();
    const otp = asString(req.body.otp).trim();

    if (!email || !otp) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Email and 6-digit OTP are required.' } });
    }
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_OTP_FORMAT', message: 'Verification code must be 6 digits.' } });
    }

    const user = await userRepository.findWithOtpByEmail(email);
    if (!user) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or verification code.' } });
    }

    if (user.isActive && user.emailVerified) {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_ACTIVE', message: 'Account is already verified. Please sign in.' } });
    }

    if ((user.otpAttempts || 0) >= 5) {
      return res.status(429).json({ success: false, error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many incorrect attempts. Please request a new code.' } });
    }

    if (!user.otpExpires || new Date() > new Date(user.otpExpires)) {
      return res.status(400).json({ success: false, error: { code: 'OTP_EXPIRED', message: 'Verification code has expired. Please request a new code.' } });
    }

    const incomingHash = hashOpaqueToken(otp);
    if (incomingHash !== user.otpHash) {
      const nextAttempts = (user.otpAttempts || 0) + 1;
      await userRepository.updateById(user.id || user._id, { otpAttempts: nextAttempts });
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_OTP', message: `Invalid verification code. (${5 - nextAttempts} attempts remaining)` },
      });
    }

    // Valid OTP: activate user
    const userId = user.id || user._id;
    await userRepository.updateById(userId, {
      isActive: true,
      emailVerified: true,
      otpHash: null,
      otpExpires: null,
      otpAttempts: 0,
      activationTokenHash: null,
      activationExpires: null,
    });

    // Auto-login: issue token pair and set cookie
    const secrets = getAuthSecrets();
    const updatedUser = await userRepository.findById(userId);
    const pair = issuePair(updatedUser || user, secrets);
    setRefreshCookie(res, pair.refreshToken, secrets.isProd);

    return res.json({
      success: true,
      data: { user: formatSafeUser(updatedUser || user), accessToken: pair.accessToken },
      message: 'Account verified successfully. Welcome to LabPulse!',
    });
  } catch (err) { return next(err); }
});

/* ---------------- RESEND OTP (request a new 6-digit verification code) ---------------- */
router.post('/resend-otp', sensitiveLimiter, requireDB, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, ['email']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });

    const email = asString(req.body.email).trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Email is required.' } });
    }

    const user = await userRepository.findByEmail(email);
    if (!user) {
      // Prevent email enumeration: return generic success
      return res.json({ success: true, message: 'If an unactivated account exists, a new verification code has been sent.' });
    }

    if (user.isActive && user.emailVerified) {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_ACTIVE', message: 'Account is already verified. Please sign in.' } });
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    const otpHash = hashOpaqueToken(otp);
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const userId = user.id || user._id;
    await userRepository.updateById(userId, {
      otpHash,
      otpExpires: expires,
      otpAttempts: 0,
    });

    const notifyOutcome = await notifyUser({
      userId,
      type: 'account-otp',
      title: 'LabPulse verification code',
      message: `Your new verification code is ${otp}. Valid for 10 minutes.`,
      email: {
        to: user.email,
        subject: 'LabPulse — Your 6-Digit Verification Code',
        template: 'account-otp',
        data: { name: user.name, otp, expiresInMinutes: 10 },
      },
    });

    if (process.env.NODE_ENV !== 'test') {
      if (notifyOutcome && notifyOutcome.emailSent) {
        console.log(`[auth:resend-otp] New OTP verification code delivered to ${user.email}`);
      } else {
        console.warn(`[auth:resend-otp] Warning: Email delivery to ${user.email} failed (${(notifyOutcome && notifyOutcome.emailError) || 'undelivered'}). OTP code is: ${otp}`);
      }
    }

    return res.json({
      success: true,
      message: 'A new verification code has been sent to your email.',
      ...(process.env.NODE_ENV !== 'production' ? { devOtp: otp } : {}),
    });
  } catch (err) { return next(err); }
});

/* ---------------- ACTIVATE (admin-created faculty accounts set their password; student activations) ---------------- */
router.post('/activate', sensitiveLimiter, requireDB, async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, ['token', 'password']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });
    const token = asString(req.body.token);
    if (!token) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Activation token is required.' } });
    }
    // activationTokenHash: hashOpaqueToken(token) verified via userRepository
    const user = await userRepository.findByActivationToken(hashOpaqueToken(token));
    if (!user) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_OR_EXPIRED_TOKEN', message: 'Activation link is invalid or expired.' } });
    }
    if (req.body.password) {
      const policyError = validatePasswordPolicy(req.body.password);
      if (policyError) {
        return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: policyError } });
      }
      user.passwordHash = await hashPassword(req.body.password);
    }
    user.activationTokenHash = undefined;
    user.activationExpires = undefined;
    user.emailVerified = true;
    user.isActive = true;
    const userId = user.id || user._id;
    await userRepository.updateById(userId, {
      activationTokenHash: null,
      activationExpires: null,
      emailVerified: true,
      isActive: true,
      ...(user.passwordHash ? { passwordHash: user.passwordHash } : {}),
    });
    await notifyUser({
      userId, type: 'account-activated', title: 'LabPulse account activated',
      message: `Welcome, ${user.name}. Your account is active — please log in.`,
      email: null,
    });
    return res.json({ success: true, message: 'Account activated. Please log in.' });
  } catch (err) { return next(err); }
});

module.exports = router;
