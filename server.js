/**
 * LabPulse server (Phase 02 / Module 06: Dual-backend Supabase & MongoDB support).
 * - Serves the static frontend (index.html/app.js/style.css) with design system.
 * - Exposes /api/v1/health + /api/v1/auth/*, /admin/*, /bookings/*, /instruments/*, etc.
 * - Safe startup: verifies active database backend (PostgreSQL/Supabase or MongoDB).
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const { connectDB, dbState } = require('./config/db');
const { resolveSecrets } = require('./config/auth');
const {
  getActiveDataBackend,
  isSupabaseConfigured,
  checkSupabaseHealth,
} = require('./config/supabase');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MONGODB_URI = process.env.MONGODB_URI || '';

const app = express();
app.set('trust proxy', 1); // correct client IPs for rate limiting + secure cookies behind a proxy

// Security headers (Phase 12 / Production Hardening)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Explicit CORS Allowlist (Module 17: Production Hardening)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : (process.env.APP_URL ? [process.env.APP_URL] : []);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const isAllowed = ALLOWED_ORIGINS.includes(origin) ||
      (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Idempotency-Key');
    }
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
  }
  next();
});

// Global API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' } }
});
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Fail fast in production on missing/weak JWT secrets (never run prod auth insecure)
resolveSecrets();

app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/admin', require('./routes/admin'));
app.use('/api/v1/schedules', require('./routes/schedules'));
app.use('/api/v1/bookings', require('./routes/bookings'));
app.use('/api/v1/instruments', require('./routes/instruments'));
app.use('/api/v1/calibrations', require('./routes/calibrations'));
app.use('/api/v1/maintenance', require('./routes/maintenance'));
app.use('/api/v1/breakage-reports', require('./routes/breakage'));
app.use('/api/v1/notifications', require('./routes/notifications'));
app.use('/api/v1/dashboard', require('./routes/dashboard'));
app.use('/api/v1/qr', require('./routes/qr'));
app.use('/api/v1/laboratories', require('./routes/laboratories'));
app.use('/api/v1/admin/users', require('./routes/users'));
app.use('/api/v1/admin/qualifications', require('./routes/qualifications'));
app.use('/api/v1/qualifications', require('./routes/qualifications'));
app.use('/api/v1/audit', require('./routes/audit'));
app.use('/api/v1/analytics', require('./routes/analytics'));

// Health endpoint distinguishing process, active backend, MongoDB, and Supabase status
app.get('/api/v1/health', async (req, res) => {
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  const activeBackend = getActiveDataBackend();
  const mongoState = states[dbState()] || 'unknown';
  let supabaseHealth = { configured: false, healthy: false };

  if (isSupabaseConfigured()) {
    try {
      supabaseHealth = await checkSupabaseHealth();
    } catch (err) {
      supabaseHealth = { configured: true, healthy: false, error: err.message };
    }
  }

  const dbStatus = activeBackend === 'supabase'
    ? (supabaseHealth.healthy ? 'connected' : 'disconnected')
    : mongoState;

  res.json({
    success: true,
    data: {
      status: 'ok',
      backend: activeBackend,
      db: dbStatus,
      details: {
        mongodb: { state: mongoState },
        supabase: supabaseHealth,
      },
      time: new Date().toISOString(),
    },
  });
});

// Liveness Probe (Module 17: Process Alive without Database Dependency)
app.get('/api/v1/health/liveness', (req, res) => {
  res.json({ success: true, data: { status: 'alive', time: new Date().toISOString() } });
});

// Readiness Probe (Module 17: Service Traffic Readiness)
app.get('/api/v1/health/readiness', async (req, res) => {
  const activeBackend = getActiveDataBackend();
  if (activeBackend === 'supabase') {
    if (!isSupabaseConfigured()) {
      return res.status(503).json({ success: false, error: { code: 'NOT_READY', message: 'Supabase configuration missing.' } });
    }
    try {
      const h = await checkSupabaseHealth();
      if (!h.healthy) {
        return res.status(503).json({ success: false, error: { code: 'NOT_READY', message: 'Supabase database degraded.', details: h.error } });
      }
    } catch (err) {
      return res.status(503).json({ success: false, error: { code: 'NOT_READY', message: err.message } });
    }
  } else if (dbState() !== 1) {
    return res.status(503).json({ success: false, error: { code: 'NOT_READY', message: 'Database not connected.' } });
  }
  return res.json({ success: true, data: { status: 'ready', backend: activeBackend, time: new Date().toISOString() } });
});

// Serve existing frontend as-is (preserve working UI).
// Whitelist: only public frontend files are served. Backend source (models/routes/config/...)
// must never be web-accessible (Phase 01 audit hardening). Extend this set when adding public assets.
const FRONTEND_FILES = new Set(['/', '/index.html', '/app.js', '/auth.js', '/dash.js', '/ui-system.js', '/motion.js', '/qrcode.min.js', '/style.css', '/favicon.ico',
  '/login.html', '/signup.html', '/forgot-password.html', '/reset-password.html', '/admin.html', '/faculty.html', '/student.html', '/pass.html', '/design-system.html', '/404.html']);
const serveFrontend = express.static(path.join(__dirname));
app.use((req, res, next) => {
  if (req.method !== 'GET' || !FRONTEND_FILES.has(req.path)) return next();
  return serveFrontend(req, res, next);
});

// API 404 (JSON envelope per spec §15)
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'API route not found.' } });
});

// HTML 404 fallback for non-API routes
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.accepts('html')) {
    return res.status(404).sendFile(path.join(__dirname, '404.html'));
  }
  res.status(404).send('Not Found');
});

// Global error handler — never leak stack traces or parser internals in production
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body.' },
    });
  }
  res.status(err.status || 500).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: isProd ? 'Something went wrong.' : (err.message || 'Something went wrong.'),
    },
  });
});

// Only bind a port when run directly (`node server.js`). When required (tests),
// the importer starts its own listener — this avoids port collisions.
let server = null;
if (require.main === module) {
  server = app.listen(PORT, async () => {
    console.log(`LabPulse listening on :${PORT}`);
    const activeBackend = getActiveDataBackend();
    console.log(`Active Data Backend: ${activeBackend.toUpperCase()}`);

    if (activeBackend === 'supabase') {
      if (isSupabaseConfigured()) {
        const health = await checkSupabaseHealth();
        if (health.healthy) {
          console.log('Supabase PostgreSQL connected.');
        } else {
          console.warn('Supabase configured but health check failed:', health.error);
        }
      } else {
        console.warn('DATA_BACKEND=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.');
      }
    }

    if (activeBackend !== 'supabase' && MONGODB_URI) {
      try {
        await connectDB(MONGODB_URI);
        console.log('MongoDB connected.');
      } catch (err) {
        console.warn('MongoDB unreachable. Details:', err.message);
      }
    } else if (activeBackend !== 'supabase') {
      console.warn('MONGODB_URI not set — running without database (frontend only).');
    }
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
