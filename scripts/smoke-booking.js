/**
 * Phase 05 smoke tests. Run: `node scripts/smoke-booking.js` (needs live MONGODB_URI, else SKIP).
 * Free booking, all gates (status/calibration/maintenance/qualification/overlap),
 * QR issuance, money-field rejection, availability, instrument CRUD, student fee-hiding.
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
  if (!uri) { console.log('book: SKIP (MONGODB_URI not set)'); process.exit(0); }
  try {
    const { connectDB } = require('../config/db');
    try { await connectDB(uri); } catch (e) { console.log(`book: SKIP (Mongo unreachable: ${e.message})`); process.exit(0); }

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
    const OperatorQualification = require('../models/OperatorQualification');
    const QrAccessPass = require('../models/QrAccessPass');
    const { clearOutbox, getOutbox } = require('../services/email');
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
      try { json = await res.json(); } catch (_) { /* 204 */ }
      if (json && json.data && json.data.accessToken) tokens[role] = json.data.accessToken;
      return { status: res.status, json };
    }
    async function loginAs(role, email) {
      const r = await req(role, 'POST', '/api/v1/auth/login', { email, password: 'correct-horse-12' });
      assert.strictEqual(r.status, 200, `${role} login`);
    }

    await User.deleteMany({ email: /smoke5-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE5-/ });
    await Booking.deleteMany({});
    await Calibration.deleteMany({});
    await Maintenance.deleteMany({});
    await OperatorQualification.deleteMany({});
    await QrAccessPass.deleteMany({});

    const mk = async (email, role) =>
      User.create({ name: 'Smoke5', email, passwordHash: await hashPassword('correct-horse-12'), role, isActive: true });
    const admin = await mk('smoke5-admin@x.edu', 'admin');
    const fac = await mk('smoke5-fac@x.edu', 'faculty');
    await mk('smoke5-stu@x.edu', 'student');
    const nmr = await Instrument.create({ name: 'Smoke5 NMR', category: 'SPECTROSCOPY', serialNumber: 'SMOKE5-NMR', status: 'AVAILABLE' });
    const tem = await Instrument.create({ name: 'Smoke5 TEM', category: 'MICROSCOPY', serialNumber: 'SMOKE5-TEM', status: 'AVAILABLE', requiredQualificationLevel: 3 });
    const broken = await Instrument.create({ name: 'Smoke5 Broken', category: 'X', serialNumber: 'SMOKE5-BRK', status: 'OUT_OF_ORDER' });
    const locked = await Instrument.create({ name: 'Smoke5 Locked', category: 'X', serialNumber: 'SMOKE5-LCK', status: 'LOCKED' });
    await loginAs('admin', 'smoke5-admin@x.edu');
    await loginAs('fac', 'smoke5-fac@x.edu');
    await loginAs('stu', 'smoke5-stu@x.edu');

    const T = tomorrowStr();
    const slot = { instrumentId: String(nmr._id), date: T, startTime: '10:00', endTime: '12:00', purpose: 'Structure work' };

    // free booking + QR + confirmation, zero money fields
    clearOutbox();
    let r = await req('fac', 'POST', '/api/v1/bookings', slot);
    assert.strictEqual(r.status, 201, 'book 201, got ' + r.status + ' ' + JSON.stringify(r.json));
    assert.ok(r.json.data.qrToken, 'qr token issued once');
    assert.ok(!('price' in r.json.data.booking) && !('cost' in r.json.data.booking), 'no money fields');
    const bid = r.json.data.booking._id;
    const qp = await QrAccessPass.findOne({ bookingId: bid }).lean();
    assert.ok(qp && qp.status === 'ACTIVE' && qp.tokenHash && !qp.token, 'qr hash at rest, no raw token');
    assert.strictEqual(getOutbox().length, 1, 'booking confirmation queued');
    assert.strictEqual(getOutbox()[0].template, 'booking-created');
    ok('free booking + QR + confirmation');

    // money fields rejected outright
    r = await req('fac', 'POST', '/api/v1/bookings', { ...slot, startTime: '14:00', endTime: '15:00', price: 10 });
    assert.strictEqual(r.status, 400, 'price field 400');
    r = await req('fac', 'POST', '/api/v1/bookings', { ...slot, startTime: '14:00', endTime: '15:00', grant: 'G1' });
    assert.strictEqual(r.status, 400, 'grant field 400');
    ok('money/grant fields rejected');

    // overlap + status gates
    r = await req('fac', 'POST', '/api/v1/bookings', { ...slot, startTime: '11:00', endTime: '13:00' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'BOOKING_CONFLICT');
    r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(broken._id), date: T, startTime: '10:00', endTime: '11:00', purpose: 'x' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'INSTRUMENT_OUT_OF_ORDER');
    r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(locked._id), date: T, startTime: '10:00', endTime: '11:00', purpose: 'x' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'INSTRUMENT_LOCKED');
    ok('overlap + broken + locked gates');

    // calibration + maintenance windows block
    await Calibration.create({ instrumentId: nmr._id, calibrationType: 'NIST', date: new Date(`${T}T00:00:00Z`), startTime: '14:00', endTime: '16:00', status: 'CALIBRATION_SCHEDULED' });
    r = await req('fac', 'POST', '/api/v1/bookings', { ...slot, startTime: '15:00', endTime: '17:00' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'CALIBRATION_CONFLICT');
    r = await req('fac', 'POST', '/api/v1/bookings', { ...slot, startTime: '16:00', endTime: '17:00' });
    assert.strictEqual(r.status, 201, 'outside calibration window allowed');
    const outsideId = r.json.data.booking._id;
    await Maintenance.create({ instrumentId: nmr._id, type: 'preventive', description: 'svc', startDate: new Date(`${T}T00:00:00Z`), status: 'SCHEDULED', startTime: '08:00', endTime: '09:00' });
    r = await req('fac', 'POST', '/api/v1/bookings', { ...slot, startTime: '08:00', endTime: '08:30' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'MAINTENANCE_CONFLICT');
    ok('calibration + maintenance windows block');

    // qualification gate
    r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(tem._id), date: T, startTime: '10:00', endTime: '11:00', purpose: 'nano' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error.code, 'QUALIFICATION_REQUIRED');
    await OperatorQualification.create({ userId: fac._id, instrumentId: tem._id, level: 3, status: 'ACTIVE' });
    r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(tem._id), date: T, startTime: '10:00', endTime: '11:00', purpose: 'nano' });
    assert.strictEqual(r.status, 201, 'qualified booking allowed');
    const temBid = r.json.data.booking._id;
    ok('qualification gate + pass');

    // roles: student read-only, anon denied
    r = await req('stu', 'POST', '/api/v1/bookings', { ...slot, startTime: '18:00', endTime: '19:00' });
    assert.strictEqual(r.status, 403, 'student book 403');
    r = await req('stu', 'GET', `/api/v1/instruments/${nmr._id}/availability?date=${T}`);
    assert.strictEqual(r.status, 200, 'student availability 200');
    assert.ok(r.json.data.days[0].blocks.some((b) => b.type === 'booking'), 'booked slot visible in availability');
    r = await req('nobody', 'GET', '/api/v1/bookings');
    assert.strictEqual(r.status, 401, 'anon 401');
    ok('student read-only + availability');

    // students never see fee controls
    r = await req('stu', 'GET', '/api/v1/instruments');
    assert.ok(r.json.data.instruments.every((i) => !('breakageFee' in i)), 'fee hidden from students');
    r = await req('admin', 'GET', '/api/v1/instruments');
    assert.ok(r.json.data.instruments.every((i) => 'breakageFee' in i), 'fee visible to admin');
    r = await req('stu', 'POST', '/api/v1/instruments', { name: 'X', category: 'Y', serialNumber: 'SMOKE5-X' });
    assert.strictEqual(r.status, 403, 'student instrument write 403');
    ok('fee visibility by role');

    // admin instrument CRUD
    r = await req('admin', 'POST', '/api/v1/instruments', { name: 'Smoke5 New', category: 'Z', serialNumber: 'SMOKE5-NEW' });
    assert.strictEqual(r.status, 201, 'instrument create 201');
    const newInstId = r.json.data.instrument._id;
    r = await req('admin', 'POST', '/api/v1/instruments', { name: 'Dup', category: 'Z', serialNumber: 'SMOKE5-NEW' });
    assert.strictEqual(r.status, 409, 'dup serial 409');
    r = await req('admin', 'PATCH', `/api/v1/instruments/${newInstId}`, { status: 'LOCKED' });
    assert.strictEqual(r.status, 200, 'lockout via API');
    r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: newInstId, date: T, startTime: '10:00', endTime: '11:00', purpose: 'x' });
    assert.strictEqual(r.status, 422, 'locked blocks booking');
    r = await req('admin', 'DELETE', `/api/v1/instruments/${nmr._id}`, null);
    assert.strictEqual(r.status, 409, 'delete with live bookings blocked');
    assert.strictEqual(r.json.error.code, 'INSTRUMENT_IN_USE');
    r = await req('admin', 'DELETE', `/api/v1/instruments/${newInstId}`, null);
    assert.strictEqual(r.status, 204, 'delete clean instrument 204');
    ok('admin instrument CRUD + guards');

    // cancel fast path revokes QR + ownership
    r = await req('fac', 'PATCH', `/api/v1/bookings/${bid}`, { status: 'CANCELLED' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.booking.status, 'CANCELLED');
    const qp2 = await QrAccessPass.findOne({ bookingId: bid }).lean();
    assert.strictEqual(qp2.status, 'REVOKED', 'QR revoked on cancel');
    r = await req('fac', 'PATCH', `/api/v1/bookings/${temBid}`, { status: 'CHECKED_IN' });
    assert.strictEqual(r.status, 400, 'client check-in rejected');
    ok('cancel revokes QR; terminal status protected');

    // cleanup (delete blocks? cancel remaining first)
    await req('admin', 'DELETE', `/api/v1/bookings/${outsideId}`, null);
    await req('admin', 'DELETE', `/api/v1/bookings/${temBid}`, null);
    await User.deleteMany({ email: /smoke5-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE5-/ });
    await Booking.deleteMany({});
    await Calibration.deleteMany({});
    await Maintenance.deleteMany({});
    await OperatorQualification.deleteMany({});
    await QrAccessPass.deleteMany({});
    await mongoose.disconnect();
    await new Promise((res2) => srv.close(res2));
    console.log(`\nSMOKE OK (${passed} checks passed)`);
    process.exit(0);
  } catch (e) {
    console.error(`\nSMOKE FAIL: ${e.message}`);
    process.exit(1);
  }
})();
