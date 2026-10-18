/**
 * Phase 10 smoke tests. Run: `node scripts/smoke-qr.js` (needs live MONGODB_URI, else SKIP).
 * Issue/rotate, owner-only check-in, window rules, replay/expiry/revoke handling, interlock state.
 */
require('dotenv').config();
const assert = require('assert');

let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

function pad(n) { return String(n).padStart(2, '0'); }
function hhmm(d) { return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
function dayStr(d) { return d.toISOString().slice(0, 10); }

(async () => {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) { console.log('qr: SKIP (MONGODB_URI not set)'); process.exit(0); }
  try {
    const { connectDB } = require('../config/db');
    try { await connectDB(uri); } catch (e) { console.log(`qr: SKIP (Mongo unreachable: ${e.message})`); process.exit(0); }

    const mongoose = require('mongoose');
    const app = require('../server');
    const srv = app.listen(0);
    await new Promise((ready) => srv.on('listening', ready));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const User = require('../models/User');
    const Instrument = require('../models/Instrument');
    const Booking = require('../models/Booking');
    const QrAccessPass = require('../models/QrAccessPass');
    const AuditLog = require('../models/AuditLog');
    const { hashPassword } = require('../utils/password');
    const { hashOpaqueToken } = require('../utils/tokens');

    const jar = {};
    const tokens = {};
    async function http(role, method, p, body) {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(jar[role] ? { Cookie: jar[role] } : {}), ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) {
        const m = sc.match(/lp_refresh=([^;]*)/);
        if (m) jar[role] = `lp_refresh=${m[1]}`;
      }
      let json = null;
      try { json = await res.json(); } catch (_) { /* void */ }
      if (json && json.data && json.data.accessToken) tokens[role] = json.data.accessToken;
      return { status: res.status, json };
    }

    await User.deleteMany({ email: /smoke10-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE10-/ });
    await Booking.deleteMany({});
    await QrAccessPass.deleteMany({});
    await AuditLog.deleteMany({ action: /QR_/ });

    const mk = async (email, role) =>
      User.create({ name: 'Smoke10', email, passwordHash: await hashPassword('correct-horse-12'), role, isActive: true });
    await mk('smoke10-admin@x.edu', 'admin');
    await mk('smoke10-a@x.edu', 'faculty');
    await mk('smoke10-b@x.edu', 'faculty');
    await mk('smoke10-stu@x.edu', 'student');
    const nmr = await Instrument.create({ name: 'Smoke10 NMR', category: 'SPECTROSCOPY', serialNumber: 'SMOKE10-NMR', status: 'AVAILABLE' });
    for (const [role, email] of [['admin', 'smoke10-admin@x.edu'], ['facA', 'smoke10-a@x.edu'], ['facB', 'smoke10-b@x.edu'], ['stu', 'smoke10-stu@x.edu']]) {
      const lr = await http(role, 'POST', '/api/v1/auth/login', { email, password: 'correct-horse-12' });
      assert.strictEqual(lr.status, 200, `${role} login`);
    }

    const now = new Date();
    const today = dayStr(now);
    const tmr = dayStr(new Date(now.getTime() + 86400000));
    // Live slot: started 5 min ago, ends in ~55 min (clamped to today).
    let start = hhmm(new Date(now.getTime() - 5 * 60000));
    let end = hhmm(new Date(now.getTime() + 55 * 60000));
    if (end <= start) end = '23:59';

    // create + rotate: exactly one live token
    let r = await http('facA', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: today, startTime: start, endTime: end, purpose: 'live run' });
    assert.strictEqual(r.status, 201, 'live booking');
    const liveId = r.json.data.booking._id;
    const t1 = r.json.data.qrToken;
    r = await http('facA', 'POST', `/api/v1/bookings/${liveId}/qr`);
    assert.strictEqual(r.status, 201, 'reissue 201');
    const t2 = r.json.data.qrToken;
    assert.ok(t2 && t2 !== t1, 'token rotated');
    r = await http('facA', 'POST', '/api/v1/qr/check-in', { token: t1 });
    assert.strictEqual(r.status, 410, 'old token revoked');
    assert.strictEqual(r.json.error.code, 'QR_REVOKED');
    ok('issue + rotate (single live token)');

    // access control on reissue + check-in
    r = await http('facB', 'POST', `/api/v1/bookings/${liveId}/qr`);
    assert.strictEqual(r.status, 403, 'cross-user reissue 403');
    r = await http('stu', 'POST', `/api/v1/bookings/${liveId}/qr`);
    assert.strictEqual(r.status, 403, 'student reissue 403');
    r = await http('facB', 'POST', '/api/v1/qr/check-in', { token: t2 });
    assert.strictEqual(r.status, 403, 'cross-user check-in 403');
    r = await http('anon', 'POST', '/api/v1/qr/check-in', { token: t2 });
    assert.strictEqual(r.status, 401, 'anon 401');
    r = await http('facA', 'POST', '/api/v1/qr/check-in', { token: 'deadbeef' });
    assert.strictEqual(r.status, 404, 'unknown token 404');
    ok('owner-only + auth gates');

    // success: booking flips, interlock simulated, no sensitive leakage
    r = await http('facA', 'POST', '/api/v1/qr/check-in', { token: t2 });
    assert.strictEqual(r.status, 200, 'check-in 200, got ' + r.status);
    assert.strictEqual(r.json.data.booking.status, 'CHECKED_IN');
    assert.strictEqual(r.json.data.interlock.power, 'ON');
    assert.strictEqual(r.json.data.interlock.interlock, 'ENGAGED');
    assert.ok(!JSON.stringify(r.json).includes('tokenHash'), 'no hashes leaked');
    const pass = await QrAccessPass.findOne({ tokenHash: hashOpaqueToken(t2) }).lean();
    assert.strictEqual(pass.status, 'USED', 'single-use enforced');
    assert.ok(pass.checkedInAt, 'check-in timestamped');
    ok('check-in success + interlock');

    // replay + double-booking-state
    r = await http('facA', 'POST', '/api/v1/qr/check-in', { token: t2 });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'QR_ALREADY_USED');
    ok('replay rejected');

    // too-early (tomorrow slot) and cancelled booking
    r = await http('facA', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: tmr, startTime: '10:00', endTime: '11:00', purpose: 'future' });
    const futId = r.json.data.booking._id;
    const futTok = r.json.data.qrToken;
    r = await http('facA', 'POST', '/api/v1/qr/check-in', { token: futTok });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'TOO_EARLY');
    await http('facA', 'PATCH', `/api/v1/bookings/${futId}`, { status: 'CANCELLED' });
    r = await http('facA', 'POST', `/api/v1/bookings/${futId}/qr`);
    assert.strictEqual(r.status, 422, 'no QR for cancelled');
    assert.strictEqual(r.json.error.code, 'QR_NOT_AVAILABLE');
    ok('window + cancelled guards');

    // expired pass marked on use
    await QrAccessPass.create({ bookingId: futId, tokenHash: hashOpaqueToken('stale-token-1'), expiresAt: new Date(Date.now() - 1000), status: 'ACTIVE' });
    r = await http('admin', 'POST', '/api/v1/qr/check-in', { token: 'stale-token-1' });
    assert.strictEqual(r.status, 410);
    assert.strictEqual(r.json.error.code, 'QR_EXPIRED');
    ok('expiry handling');

    const audits = await AuditLog.find({ action: /QR_/ }).lean();
    for (const a of ['QR_ISSUED', 'QR_CHECKED_IN']) {
      assert.ok(audits.some((x) => x.action === a), `audit ${a}`);
    }
    ok('audit trail');

    await User.deleteMany({ email: /smoke10-/ });
    await Instrument.deleteMany({ serialNumber: /SMOKE10-/ });
    await Booking.deleteMany({});
    await QrAccessPass.deleteMany({});
    await AuditLog.deleteMany({ action: /QR_/ });
    await mongoose.disconnect();
    await new Promise((res2) => srv.close(res2));
    console.log(`\nSMOKE OK (${passed} checks passed)`);
    process.exit(0);
  } catch (e) {
    console.error(`\nSMOKE FAIL: ${e.message}`);
    process.exit(1);
  }
})();
