/**
 * Phase 07 smoke tests. Run: `node scripts/smoke-maintenance.js` (needs live MONGODB_URI, else SKIP).
 * Schedule gates, booking-block wiring, transitions, completion restore + calibration-required, no-fee rule.
 */
require('dotenv').config();
const assert = require('assert');

let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

function dayStr(offset) {
  const n = new Date();
  const t = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + offset * 86400000);
  return t.toISOString().slice(0, 10);
}

(async () => {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) { console.log('maint: SKIP (MONGODB_URI not set)'); process.exit(0); }
  try {
    const { connectDB } = require('../config/db');
    try { await connectDB(uri); } catch (e) { console.log(`maint: SKIP (Mongo unreachable: ${e.message})`); process.exit(0); }

    const mongoose = require('mongoose');
    const app = require('../server');
    const srv = app.listen(0);
    await new Promise((r) => srv.on('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const User = require('../models/User');
    const Instrument = require('../models/Instrument');
    const Booking = require('../models/Booking');
    const Calibration = require('../models/Calibration');
    const Maintenance = require('../models/Maintenance');
    const BreakageReport = require('../models/BreakageReport');
    const AuditLog = require('../models/AuditLog');
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

    await User.deleteMany({ email: /smoke7-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE7-/ });
    await Booking.deleteMany({});
    await Calibration.deleteMany({});
    await Maintenance.deleteMany({});
    await BreakageReport.deleteMany({});
    await AuditLog.deleteMany({ action: /MAINTENANCE_/ });

    const mk = async (email, role) =>
      User.create({ name: 'Smoke7', email, passwordHash: await hashPassword('correct-horse-12'), role, isActive: true });
    await mk('smoke7-admin@x.edu', 'admin');
    const tech = await mk('smoke7-tech@x.edu', 'faculty');
    await mk('smoke7-fac@x.edu', 'faculty');
    const nmr = await Instrument.create({ name: 'Smoke7 NMR', category: 'SPECTROSCOPY', serialNumber: 'SMOKE7-NMR', status: 'AVAILABLE', calibrationFrequencyDays: 90, breakageFee: 0 });
    const brk = await Instrument.create({ name: 'Smoke7 Broken', category: 'X', serialNumber: 'SMOKE7-BRK', status: 'OUT_OF_ORDER' });
    await loginAs('admin', 'smoke7-admin@x.edu');
    await loginAs('fac', 'smoke7-fac@x.edu');

    const T = dayStr(1);
    const T2 = dayStr(2);

    // gates + validation
    let r = await req('fac', 'POST', '/api/v1/maintenance', { instrumentId: String(nmr._id), type: 'preventive', description: 'x', startDate: T });
    assert.strictEqual(r.status, 403, 'faculty schedule 403');
    r = await req('admin', 'POST', '/api/v1/maintenance', { instrumentId: String(nmr._id), type: 'polish', description: 'x', startDate: T });
    assert.strictEqual(r.status, 400, 'bad type 400');
    r = await req('admin', 'POST', '/api/v1/maintenance', { instrumentId: String(nmr._id), type: 'preventive', description: 'x', startDate: T, endDate: dayStr(0) });
    assert.strictEqual(r.status, 422, 'end<start 422');
    r = await req('admin', 'POST', '/api/v1/maintenance', { instrumentId: String(nmr._id), type: 'preventive', description: 'x', startDate: '2020-01-01' });
    assert.strictEqual(r.status, 422, 'past start 422');
    ok('role + validation gates');

    // schedule + booking blocked in window
    r = await req('admin', 'POST', '/api/v1/maintenance', {
      instrumentId: String(nmr._id), type: 'preventive', description: 'Rotor service',
      startDate: T, startTime: '14:00', endTime: '16:00', technicianId: String(tech._id),
    });
    assert.strictEqual(r.status, 201, 'schedule 201, got ' + r.status);
    assert.strictEqual(r.json.data.maintenance.status, 'SCHEDULED');
    const m1 = r.json.data.maintenance._id;
    r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '15:00', endTime: '16:00', purpose: 'x' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'MAINTENANCE_CONFLICT');
    ok('schedule blocks bookings in-window');

    // maintenance-vs-maintenance, over booking, over calibration
    r = await req('admin', 'POST', '/api/v1/maintenance', { instrumentId: String(nmr._id), type: 'preventive', description: 'dup', startDate: T, startTime: '15:00', endTime: '17:00' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'MAINTENANCE_CONFLICT');
    r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '10:00', endTime: '11:00', purpose: 'hold' });
    assert.strictEqual(r.status, 201, 'seed booking');
    r = await req('admin', 'POST', '/api/v1/maintenance', { instrumentId: String(nmr._id), type: 'preventive', description: 'over booking', startDate: T, startTime: '10:30', endTime: '11:30' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'BOOKING_CONFLICT');
    r = await req('admin', 'POST', '/api/v1/calibrations', { instrumentId: String(nmr._id), calibrationType: 'NIST', date: T, startTime: '11:00', endTime: '12:00' });
    assert.strictEqual(r.status, 201, 'seed calibration');
    r = await req('admin', 'POST', '/api/v1/maintenance', { instrumentId: String(nmr._id), type: 'preventive', description: 'over cal', startDate: T, startTime: '11:30', endTime: '12:30' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'CALIBRATION_CONFLICT');
    ok('clash detection (maintenance/booking/calibration)');

    // start -> offline; direct complete refused; complete -> available, no fee created
    r = await req('admin', 'PATCH', `/api/v1/maintenance/${m1}`, { status: 'COMPLETED' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'INVALID_STATUS_TRANSITION');
    r = await req('admin', 'PATCH', `/api/v1/maintenance/${m1}`, { status: 'IN_PROGRESS' });
    assert.strictEqual(r.status, 200);
    let inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'UNDER_MAINTENANCE', 'start takes instrument offline');
    r = await req('admin', 'PATCH', `/api/v1/maintenance/${m1}`, { status: 'COMPLETED' });
    assert.strictEqual(r.status, 200);
    inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'AVAILABLE', 'completion restores availability');
    assert.strictEqual(inst.breakageFee, 0, 'no fee created by maintenance');
    ok('start/complete lifecycle, no-fee rule');

    // requiresCalibration -> DUE record + due date
    r = await req('admin', 'POST', '/api/v1/maintenance', {
      instrumentId: String(nmr._id), type: 'preventive', description: 'annual overhaul',
      startDate: T2, startTime: '09:00', endTime: '10:00', requiresCalibration: true,
    });
    assert.strictEqual(r.status, 201);
    const m5 = r.json.data.maintenance._id;
    await req('admin', 'PATCH', `/api/v1/maintenance/${m5}`, { status: 'IN_PROGRESS' });
    r = await req('admin', 'PATCH', `/api/v1/maintenance/${m5}`, { status: 'COMPLETED' });
    assert.strictEqual(r.status, 200);
    const due = await Calibration.findOne({ instrumentId: nmr._id, status: 'CALIBRATION_DUE' }).lean();
    assert.ok(due && due.calibrationType === 'POST_MAINTENANCE', 'DUE record raised');
    inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'AVAILABLE');
    assert.ok(inst.nextCalibrationDue, 'due date stamped');
    ok('calibration-required completion');

    // corrective on broken + breakage-aware restore + edit lock
    r = await req('admin', 'POST', '/api/v1/maintenance', {
      instrumentId: String(brk._id), type: 'corrective', description: 'replace probe', startDate: T2, startTime: '11:00', endTime: '12:00',
    });
    assert.strictEqual(r.status, 201, 'corrective on broken allowed');
    const mc = r.json.data.maintenance._id;
    await req('admin', 'PATCH', `/api/v1/maintenance/${mc}`, { status: 'IN_PROGRESS' });
    await BreakageReport.create({ instrumentId: brk._id, reportedBy: tech._id, issueType: 'probe', severity: 'HIGH', description: 'x', status: 'CONFIRMED', breakageFee: 50000 });
    r = await req('admin', 'PATCH', `/api/v1/maintenance/${mc}`, { status: 'COMPLETED' });
    assert.strictEqual(r.status, 200);
    inst = await Instrument.findById(brk._id).lean();
    assert.strictEqual(inst.status, 'OUT_OF_ORDER', 'open breakage redirects restore');
    r = await req('admin', 'PATCH', `/api/v1/maintenance/${m5}`, { startTime: '10:00' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'EDIT_LOCKED');
    ok('corrective repair flow + edit lock');

    // reschedule clash + cancel + audit
    r = await req('admin', 'POST', '/api/v1/maintenance', { instrumentId: String(nmr._id), type: 'preventive', description: 'later', startDate: T2, startTime: '14:00', endTime: '15:00' });
    const m6 = r.json.data.maintenance._id;
    r = await req('admin', 'PATCH', `/api/v1/maintenance/${m6}`, { startDate: T, startTime: '11:30', endTime: '12:30' });
    assert.strictEqual(r.status, 409, 'reschedule into calibration 409');
    r = await req('admin', 'PATCH', `/api/v1/maintenance/${m6}`, { status: 'CANCELLED' });
    assert.strictEqual(r.status, 200);
    const audits = await AuditLog.find({ action: /MAINTENANCE_/ }).lean();
    for (const a of ['MAINTENANCE_CREATED', 'MAINTENANCE_COMPLETED']) {
      assert.ok(audits.some((x) => x.action === a), `audit ${a}`);
    }
    ok('reschedule guard + cancel + audit');

    await User.deleteMany({ email: /smoke7-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE7-/ });
    await Booking.deleteMany({});
    await Calibration.deleteMany({});
    await Maintenance.deleteMany({});
    await BreakageReport.deleteMany({});
    await AuditLog.deleteMany({ action: /MAINTENANCE_/ });
    await mongoose.disconnect();
    await new Promise((res2) => srv.close(res2));
    console.log(`\nSMOKE OK (${passed} checks passed)`);
    process.exit(0);
  } catch (e) {
    console.error(`\nSMOKE FAIL: ${e.message}`);
    process.exit(1);
  }
})();
