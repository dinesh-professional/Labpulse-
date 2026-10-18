/**
 * Phase 08 smoke tests. Run: `node scripts/smoke-breakage.js` (needs live MONGODB_URI, else SKIP).
 * Report -> OUT_OF_ORDER -> booking disabled -> confirm + fee -> repair -> resolve -> restore.
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
  if (!uri) { console.log('brk: SKIP (MONGODB_URI not set)'); process.exit(0); }
  try {
    const { connectDB } = require('../config/db');
    try { await connectDB(uri); } catch (e) { console.log(`brk: SKIP (Mongo unreachable: ${e.message})`); process.exit(0); }

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

    await User.deleteMany({ email: /smoke8-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE8-/ });
    await Booking.deleteMany({});
    await Calibration.deleteMany({});
    await BreakageReport.deleteMany({});
    await AuditLog.deleteMany({ action: /BREAKAGE_/ });

    const mk = async (email, role) =>
      User.create({ name: 'Smoke8', email, passwordHash: await hashPassword('correct-horse-12'), role, isActive: true });
    await mk('smoke8-admin@x.edu', 'admin');
    await mk('smoke8-a@x.edu', 'faculty');
    await mk('smoke8-b@x.edu', 'faculty');
    await mk('smoke8-stu@x.edu', 'student');
    const nmr = await Instrument.create({ name: 'Smoke8 NMR', category: 'SPECTROSCOPY', serialNumber: 'SMOKE8-NMR', status: 'AVAILABLE' });
    await loginAs('admin', 'smoke8-admin@x.edu');
    await loginAs('facA', 'smoke8-a@x.edu');
    await loginAs('facB', 'smoke8-b@x.edu');
    await loginAs('stu', 'smoke8-stu@x.edu');

    const T = tomorrowStr();

    // report gates
    let r = await req('stu', 'POST', '/api/v1/breakage-reports', { instrumentId: String(nmr._id), issueType: 'x', severity: 'LOW', description: 'x' });
    assert.strictEqual(r.status, 403, 'student report 403');
    r = await req('facA', 'POST', '/api/v1/breakage-reports', { instrumentId: String(nmr._id), issueType: 'probe crack', severity: 'HIGH', description: 'visible crack', breakageFee: 999 });
    assert.strictEqual(r.status, 400, 'client fee rejected');
    r = await req('facA', 'POST', '/api/v1/breakage-reports', { instrumentId: String(nmr._id), issueType: 'probe crack', severity: 'HIGH', description: 'visible crack' });
    assert.strictEqual(r.status, 201, 'report 201, got ' + r.status);
    assert.strictEqual(r.json.data.report.status, 'REPORTED');
    const repA = r.json.data.report._id;
    let inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'OUT_OF_ORDER', 'report flips instrument');
    r = await req('facB', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '10:00', endTime: '11:00', purpose: 'x' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'INSTRUMENT_OUT_OF_ORDER');
    ok('report -> OUT_OF_ORDER -> booking disabled; fee unsettable');

    // second report + fee privacy
    r = await req('facB', 'POST', '/api/v1/breakage-reports', { instrumentId: String(nmr._id), issueType: 'noise', severity: 'LOW', description: 'humming' });
    assert.strictEqual(r.status, 201);
    const repB = r.json.data.report._id;
    r = await req('stu', 'GET', '/api/v1/breakage-reports');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.data.reports.every((x) => !('breakageFee' in x)), 'fee hidden from students');
    r = await req('facA', 'GET', `/api/v1/breakage-reports/${repA}`);
    assert.ok(!('breakageFee' in r.json.data.report), 'fee hidden from faculty');
    r = await req('facA', 'PATCH', `/api/v1/breakage-reports/${repA}`, { severity: 'LOW' });
    assert.strictEqual(r.status, 404, 'no reporter PATCH route');
    ok('fee privacy + no reporter edits');

    // review: direct confirm refused, fee only on confirmed
    r = await req('admin', 'PATCH', `/api/v1/admin/breakage-reports/${repA}`, { status: 'CONFIRMED' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'INVALID_STATUS_TRANSITION');
    r = await req('admin', 'PATCH', `/api/v1/admin/breakage-reports/${repA}`, { status: 'UNDER_REVIEW' });
    assert.strictEqual(r.status, 200);
    r = await req('admin', 'PATCH', `/api/v1/admin/breakage-reports/${repA}`, { breakageFee: 50000 });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'FEE_NOT_ALLOWED');
    r = await req('admin', 'PATCH', `/api/v1/admin/breakage-reports/${repA}`, { status: 'CONFIRMED', breakageFee: 50000 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.report.breakageFee, 50000);
    assert.ok(r.json.data.report.confirmedAt, 'confirmedAt stamped');
    ok('review -> confirm + fee');

    // resolve while second report open: stays OUT_OF_ORDER; reject second -> AVAILABLE
    r = await req('admin', 'POST', `/api/v1/admin/breakage-reports/${repA}/resolve`, {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.report.status, 'RESOLVED');
    inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'OUT_OF_ORDER', 'second open report holds OOO');
    r = await req('admin', 'PATCH', `/api/v1/admin/breakage-reports/${repB}`, { status: 'UNDER_REVIEW' });
    assert.strictEqual(r.status, 200);
    r = await req('admin', 'PATCH', `/api/v1/admin/breakage-reports/${repB}`, { status: 'REJECTED' });
    assert.strictEqual(r.status, 200);
    inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'AVAILABLE', 'false alarm releases instrument');
    r = await req('facB', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '10:00', endTime: '11:00', purpose: 'back' });
    assert.strictEqual(r.status, 201, 'bookable again');
    ok('resolve + reject restore chain');

    // resolve with calibration required -> DUE + stays OOO -> calibrate -> AVAILABLE
    r = await req('facA', 'POST', '/api/v1/breakage-reports', { instrumentId: String(nmr._id), issueType: 'magnet quench', severity: 'CRITICAL', description: 'quench' });
    const repC = r.json.data.report._id;
    await req('admin', 'PATCH', `/api/v1/admin/breakage-reports/${repC}`, { status: 'UNDER_REVIEW' });
    await req('admin', 'PATCH', `/api/v1/admin/breakage-reports/${repC}`, { status: 'CONFIRMED', breakageFee: 80000 });
    r = await req('admin', 'POST', `/api/v1/admin/breakage-reports/${repC}/resolve`, { requiresCalibration: true });
    assert.strictEqual(r.status, 200);
    inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'OUT_OF_ORDER', 'held for post-repair calibration');
    const due = await Calibration.findOne({ instrumentId: nmr._id, status: 'CALIBRATION_DUE' }).lean();
    assert.ok(due && due.calibrationType === 'POST_REPAIR', 'DUE calibration raised');
    r = await req('admin', 'POST', '/api/v1/calibrations', { instrumentId: String(nmr._id), calibrationType: 'POST_REPAIR', date: T, startTime: '14:00', endTime: '15:00' });
    assert.strictEqual(r.status, 201, 'repair calibration schedulable while OOO');
    const calId = r.json.data.calibration._id;
    await req('admin', 'PATCH', `/api/v1/calibrations/${calId}`, { status: 'UNDER_CALIBRATION' });
    await req('admin', 'PATCH', `/api/v1/calibrations/${calId}`, { status: 'CALIBRATED' });
    inst = await Instrument.findById(nmr._id).lean();
    assert.strictEqual(inst.status, 'AVAILABLE', 'repair->calibration->restored');
    r = await req('admin', 'POST', `/api/v1/admin/breakage-reports/${repC}/resolve`, {});
    assert.strictEqual(r.status, 422, 're-resolve refused');
    ok('repair-calibration restoration');

    const audits = await AuditLog.find({ action: /BREAKAGE_/ }).lean();
    for (const a of ['BREAKAGE_REPORTED', 'BREAKAGE_CONFIRMED', 'BREAKAGE_RESOLVED']) {
      assert.ok(audits.some((x) => x.action === a), `audit ${a}`);
    }
    ok('audit trail');

    await User.deleteMany({ email: /smoke8-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE8-/ });
    await Booking.deleteMany({});
    await Calibration.deleteMany({});
    await BreakageReport.deleteMany({});
    await AuditLog.deleteMany({ action: /BREAKAGE_/ });
    await mongoose.disconnect();
    await new Promise((res2) => srv.close(res2));
    console.log(`\nSMOKE OK (${passed} checks passed)`);
    process.exit(0);
  } catch (e) {
    console.error(`\nSMOKE FAIL: ${e.message}`);
    process.exit(1);
  }
})();
