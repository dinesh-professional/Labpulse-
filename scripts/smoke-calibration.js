/**
 * Phase 06 smoke tests. Run: `node scripts/smoke-calibration.js` (needs live MONGODB_URI, else SKIP).
 * Schedule gates, booking-block wiring, transitions, completion restore paths, certificate flow.
 */
require('dotenv').config();
const assert = require('assert');

let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

function tomorrowStr() {
  const n = new Date();
  const t = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + 86400000);
  return t.toISOString().slice(0, 10);
}

(async () => {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) { console.log('cal: SKIP (MONGODB_URI not set)'); process.exit(0); }
  try {
    const { connectDB } = require('../config/db');
    try { await connectDB(uri); } catch (e) { console.log(`cal: SKIP (Mongo unreachable: ${e.message})`); process.exit(0); }

    const mongoose = require('mongoose');
    const app = require('../server');
    const srv = app.listen(0);
    await new Promise((r) => srv.on('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const User = require('../models/User');
    const Instrument = require('../models/Instrument');
    const Booking = require('../models/Booking');
    const Calibration = require('../models/Calibration');
    const BreakageReport = require('../models/BreakageReport');
    const { getOutbox } = require('../services/email');
    const { hashPassword } = require('../utils/password');

    const cookies = {};
    const tokens = {};
    async function req(role, method, p, body) {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookies[role] ? { Cookie: cookies[role] } : {}), ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) {
        const m = sc.match(/lp_refresh=([^;]*)/);
        if (m) cookies[role] = `lp_refresh=${m[1]}`;
      }
      let json = null;
      try { json = await res.json(); } catch (_) { /* void */ }
      if (json && json.data && json.data.accessToken) tokens[role] = json.data.accessToken;
      return { status: res.status, json };
    }
    async function loginAs(role, email) {
      const r = await req(role, 'POST', '/api/v1/auth/login', { email, password: 'correct-horse-12' });
      assert.strictEqual(r.status, 200, `${role} login`);
    }

    await User.deleteMany({ email: /smoke6-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE6-/ });
    await Booking.deleteMany({});
    await Calibration.deleteMany({});
    await BreakageReport.deleteMany({});

    const mk = async (email, role) =>
      User.create({ name: 'Smoke6', email, passwordHash: await hashPassword('correct-horse-12'), role, isActive: true });
    await mk('smoke6-admin@x.edu', 'admin');
    const tech = await mk('smoke6-tech@x.edu', 'faculty');
    await mk('smoke6-fac@x.edu', 'faculty');
    const nmr = await Instrument.create({ name: 'Smoke6 NMR', category: 'SPECTROSCOPY', serialNumber: 'SMOKE6-NMR', status: 'AVAILABLE', calibrationFrequencyDays: 90 });
    await loginAs('admin', 'smoke6-admin@x.edu');
    await loginAs('fac', 'smoke6-fac@x.edu');

    const T = tomorrowStr();

    // role gate
    let r = await req('fac', 'POST', '/api/v1/calibrations', { instrumentId: String(nmr._id), calibrationType: 'NIST', date: T, startTime: '09:00', endTime: '13:00' });
    assert.strictEqual(r.status, 403, 'faculty schedule 403');
    r = await req('nobody', 'GET', '/api/v1/calibrations');
    assert.strictEqual(r.status, 401, 'anon 401');
    ok('role gates');

    // schedule + booking blocked inside window (gate wiring to Phase 05)
    r = await req('admin', 'POST', '/api/v1/calibrations', {
      instrumentId: String(nmr._id), calibrationType: 'NIST', date: T, startTime: '09:00', endTime: '13:00',
      technicianId: String(tech._id), standard: 'NIST SRM 1950',
    });
    assert.strictEqual(r.status, 201, 'schedule 201, got ' + r.status);
    assert.strictEqual(r.json.data.calibration.status, 'CALIBRATION_SCHEDULED');
    const calId = r.json.data.calibration._id;
    r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '10:00', endTime: '11:00', purpose: 'x' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'CALIBRATION_CONFLICT');
    r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '13:00', endTime: '14:00', purpose: 'x' });
    assert.strictEqual(r.status, 201, 'outside window allowed');
    ok('schedule blocks bookings in-window');

    // calibration-vs-calibration + calibration-over-booking
    r = await req('admin', 'POST', '/api/v1/calibrations', { instrumentId: String(nmr._id), calibrationType: 'NIST', date: T, startTime: '12:00', endTime: '14:00' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'CALIBRATION_CONFLICT');
    r = await req('admin', 'POST', '/api/v1/calibrations', { instrumentId: String(nmr._id), calibrationType: 'NIST', date: T, startTime: '13:30', endTime: '14:30' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'BOOKING_CONFLICT');
    ok('window clash detection');

    // illegal direct completion
    r = await req('admin', 'PATCH', `/api/v1/calibrations/${calId}`, { status: 'CALIBRATED' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'INVALID_STATUS_TRANSITION');
    ok('transition guard');

    // start flips instrument; completion restores + recomputes due
    r = await req('admin', 'PATCH', `/api/v1/calibrations/${calId}`, { status: 'UNDER_CALIBRATION' });
    assert.strictEqual(r.status, 200);
    let inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'UNDER_CALIBRATION', 'start takes instrument offline');
    r = await req('admin', 'PATCH', `/api/v1/calibrations/${calId}`, { status: 'CALIBRATED', drift: '0.01nm', tolerance: '±0.02nm', certificateUrl: 'https://files.local/cert.pdf' });
    assert.strictEqual(r.status, 200);
    inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'AVAILABLE', 'completion restores availability');
    assert.ok(inst.lastCalibrationDate, 'last calibration stamped');
    const dueIn = Math.round((new Date(inst.nextCalibrationDue) - new Date(inst.lastCalibrationDate)) / 86400000);
    assert.strictEqual(dueIn, 90, 'due = last + frequency');
    ok('start/complete lifecycle + due recompute');

    // certificate-pending path
    r = await req('admin', 'POST', '/api/v1/calibrations', { instrumentId: String(nmr._id), calibrationType: 'NIST', date: T, startTime: '15:00', endTime: '16:00' });
    const c2 = r.json.data.calibration._id;
    await req('admin', 'PATCH', `/api/v1/calibrations/${c2}`, { status: 'UNDER_CALIBRATION' });
    r = await req('admin', 'PATCH', `/api/v1/calibrations/${c2}`, { status: 'CERTIFICATE_PENDING' });
    assert.strictEqual(r.status, 200);
    r = await req('admin', 'PATCH', `/api/v1/calibrations/${c2}`, { status: 'CALIBRATED', certificateUrl: 'https://files.local/c2.pdf' });
    assert.strictEqual(r.status, 200);
    ok('certificate-pending path');

    // completion with open breakage restores OUT_OF_ORDER (repair flow)
    r = await req('admin', 'POST', '/api/v1/calibrations', { instrumentId: String(nmr._id), calibrationType: 'POST-REPAIR', date: T, startTime: '17:00', endTime: '18:00' });
    const c3 = r.json.data.calibration._id;
    await BreakageReport.create({ instrumentId: nmr._id, reportedBy: tech._id, issueType: 'probe damage', severity: 'HIGH', description: 'x', status: 'CONFIRMED', breakageFee: 50000 });
    await req('admin', 'PATCH', `/api/v1/calibrations/${c3}`, { status: 'UNDER_CALIBRATION' });
    r = await req('admin', 'PATCH', `/api/v1/calibrations/${c3}`, { status: 'CALIBRATED' });
    assert.strictEqual(r.status, 200);
    inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'OUT_OF_ORDER', 'open breakage redirects restore');
    ok('breakage-aware restore');

    // window edit locked after start
    r = await req('admin', 'PATCH', `/api/v1/calibrations/${c3}`, { startTime: '18:00' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'EDIT_LOCKED');
    ok('post-start window lock');

    await User.deleteMany({ email: /smoke6-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE6-/ });
    await Booking.deleteMany({});
    await Calibration.deleteMany({});
    await BreakageReport.deleteMany({});
    await mongoose.disconnect();
    await new Promise((res2) => srv.close(res2));
    console.log(`\nSMOKE OK (${passed} checks passed)`);
    process.exit(0);
  } catch (e) {
    console.error(`\nSMOKE FAIL: ${e.message}`);
    process.exit(1);
  }
})();
