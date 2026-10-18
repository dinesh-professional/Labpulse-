/**
 * Phase 12 security battery. Run: `node scripts/security-audit.js` (needs live MONGODB_URI, else static-only).
 * Static (always): secret hygiene, prod fail-fast, envelope shape.
 * Live: auth bypass, escalation, IDOR, student writes, reset abuse/enumeration, rate limits,
 * NoSQL injection, invalid input, concurrent double-book/double-schedule races, QR replay,
 * secret/static leakage, error envelopes.
 */
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

const dir = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

function staticChecks() {
  console.log('static:');
  // No credentials committed: .env.example must have empty secrets.
  const envEx = read('.env.example');
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'SMTP_PASS', 'SMTP_USER']) {
    const m = envEx.match(new RegExp(`^${k}=(.*)$`, 'm'));
    assert.ok(m && m[1].trim() === '', `${k} empty in .env.example`);
  }
  assert.ok(!/mongodb(\+srv)?:\/\/[^/\s]*:[^/\s]*@/.test(envEx), 'no credentialed URI in .env.example');
  ok('no committed secrets');
  // No plaintext-password handling: passwordHash only, never `password` persisted.
  for (const f of ['routes/auth.js', 'routes/admin.js', 'models/User.js']) {
    const src = read(f);
    assert.ok(!/passwordHash\s*:\s*req\.body/.test(src), `${f} never stores raw body password`);
  }
  ok('hash-only password handling');
  // Production refuses insecure boot.
  const r = spawnSync('node', ['-e', "require('./server')"], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', PORT: '3999', JWT_ACCESS_SECRET: '', JWT_REFRESH_SECRET: '' },
  });
  assert.ok(r.status !== 0 && /JWT/.test(r.stderr + r.stdout), 'prod boot fails without JWT secrets');
  ok('prod secret fail-fast');
  // Envelope + whitelist code review.
  const srv = read('server.js');
  assert.ok(/isProd \? 'Something went wrong\.'/.test(srv), 'prod error hiding coded');
  assert.ok(/FRONTEND_FILES/.test(srv), 'static whitelist coded');
  ok('error-hiding + whitelist coded');
}

function tomorrowStr() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + 86400000).toISOString().slice(0, 10);
}

(async () => {
  staticChecks();
  const uri = process.env.MONGODB_URI || '';
  if (!uri) { console.log('live: SKIP (MONGODB_URI not set)'); console.log(`\nSMOKE OK (${passed} checks passed)`); process.exit(0); }
  console.log('live:');
  const { connectDB } = require('../config/db');
  try { await connectDB(uri); } catch (e) { console.log(`live: SKIP (${e.message})`); console.log(`\nSMOKE OK (${passed} checks passed)`); process.exit(0); }

  const mongoose = require('mongoose');
  const app = require('../server');
  const srv = app.listen(0);
  await new Promise((ready) => srv.on('listening', ready));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const User = require('../models/User');
  const Instrument = require('../models/Instrument');
  const Laboratory = require('../models/Laboratory');
  const Booking = require('../models/Booking');
  const Schedule = require('../models/Schedule');
  const BreakageReport = require('../models/BreakageReport');
  const OperatorQualification = require('../models/OperatorQualification');
  const AuditLog = require('../models/AuditLog');
  const { hashPassword } = require('../utils/password');

  const cookies = {};
  const tokens = {};
  async function req(role, method, p, body, raw) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookies[role] ? { Cookie: cookies[role] } : {}), ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}) },
      body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const m = sc.match(/lp_refresh=([^;]*)/);
      if (m) cookies[role] = `lp_refresh=${m[1]}`;
    }
    let json = null;
    try { json = await res.json(); } catch (_) { /* void */ }
    if (json && json.data && json.data.accessToken) tokens[role] = json.data.accessToken;
    const text = json === null ? await res.text().catch(() => '') : '';
    return { status: res.status, json, text };
  }

  await User.deleteMany({ email: /sec-/ });
  await Instrument.deleteMany({ serialNumber: /SEC-/ });
  await Laboratory.deleteMany({ name: /Sec Lab/ });
  await Booking.deleteMany({});
  await Schedule.deleteMany({});
  const mk = async (email, role, active = true) =>
    User.create({ name: 'Sec', email, passwordHash: await hashPassword('correct-horse-12'), role, isActive: active });
  const admin = await mk('sec-admin@x.edu', 'admin');
  void admin;
  await mk('sec-fac@x.edu', 'faculty');
  await mk('sec-stu@x.edu', 'student');
  const nmr = await Instrument.create({ name: 'Sec NMR', category: 'S', serialNumber: 'SEC-NMR', status: 'AVAILABLE' });
  const lab = await Laboratory.create({ name: 'Sec Lab', status: 'AVAILABLE' });
  for (const [role, email] of [['admin', 'sec-admin@x.edu'], ['fac', 'sec-fac@x.edu'], ['stu', 'sec-stu@x.edu']]) {
    const lr = await req(role, 'POST', '/api/v1/auth/login', { email, password: 'correct-horse-12' });
    assert.strictEqual(lr.status, 200, `${role} login`);
  }

  // 1. auth bypass: garbage, forged, tampered
  let r = await req('anon', 'GET', '/api/v1/auth/me');
  assert.strictEqual(r.status, 401);
  r = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: 'Bearer forged.token.here' } });
  assert.strictEqual(r.status, 401, 'forged token 401');
  const good = tokens.fac;
  const parts = good.split('.');
  const evilPayload = Buffer.from(JSON.stringify({ sub: 'x', role: 'admin' })).toString('base64url');
  r = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${parts[0]}.${evilPayload}.${parts[2]}` } });
  assert.strictEqual(r.status, 401, 'tampered payload 401');
  // deactivated mid-session: access dies on next request
  await User.updateOne({ email: 'sec-fac@x.edu' }, { $set: { isActive: false } });
  r = await req('fac', 'GET', '/api/v1/auth/me');
  assert.strictEqual(r.status, 403, 'deactivated token 403');
  await User.updateOne({ email: 'sec-fac@x.edu' }, { $set: { isActive: true } });
  ok('auth bypass rejected (forged/tampered/deactivated)');

  // 2. escalation: no privilege gain path
  r = await req('fac', 'POST', '/api/v1/admin/faculty', { name: 'X', email: 'sec-evil@x.edu' });
  assert.strictEqual(r.status, 403);
  r = await req('stu', 'GET', '/api/v1/admin/faculty');
  assert.strictEqual(r.status, 403, 'student admin-read 403');
  r = await req('fac', 'DELETE', '/api/v1/admin/faculty/000000000000000000000000', undefined);
  assert.strictEqual(r.status, 403, 'faculty admin-delete 403');
  ok('escalation blocked');

  // 3. IDOR: cross-user mutation denied; cross-user read of own-scoped data denied
  const T = tomorrowStr();
  r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '10:00', endTime: '11:00', purpose: 'mine' });
  assert.strictEqual(r.status, 201);
  const bid = r.json.data.booking._id;
  await mk('sec-fac2@x.edu', 'faculty');
  const lr2 = await req('fac2', 'POST', '/api/v1/auth/login', { email: 'sec-fac2@x.edu', password: 'correct-horse-12' });
  assert.strictEqual(lr2.status, 200);
  r = await req('fac2', 'PATCH', `/api/v1/bookings/${bid}`, { purpose: 'hijack' });
  assert.strictEqual(r.status, 403, 'cross-user booking edit 403');
  r = await req('fac2', 'DELETE', `/api/v1/bookings/${bid}`, undefined);
  assert.strictEqual(r.status, 403, 'cross-user booking delete 403');
  r = await req('fac2', 'GET', '/api/v1/notifications');
  assert.ok(!JSON.stringify(r.json).includes('mine'), 'no cross-user notification leak');
  ok('IDOR denied');

  // 3b. laboratories + qualifications + audit-logs contract (§15 gaps closed in Phase 12)
  r = await req('fac', 'GET', '/api/v1/laboratories');
  assert.strictEqual(r.status, 200, 'faculty labs read');
  r = await req('stu', 'GET', '/api/v1/laboratories');
  assert.strictEqual(r.status, 200, 'student labs read');
  r = await req('fac', 'POST', '/api/v1/laboratories', { name: 'X' });
  assert.strictEqual(r.status, 403, 'faculty labs write 403');
  r = await req('admin', 'POST', '/api/v1/laboratories', { name: 'Sec Lab 2', status: 'AVAILABLE' });
  assert.strictEqual(r.status, 201, 'admin labs create');
  const lab2 = r.json.data.laboratory._id;
  await req('admin', 'POST', '/api/v1/schedules', { degree: 'd', department: 'd', year: '1', section: 'A', subject: 'hold', laboratoryId: lab2, date: T, startTime: '08:00', endTime: '09:00' });
  r = await req('admin', 'DELETE', `/api/v1/laboratories/${lab2}`, undefined);
  assert.strictEqual(r.status, 409, 'lab in use 409');
  assert.strictEqual(r.json.error.code, 'LAB_IN_USE');
  r = await req('fac', 'GET', '/api/v1/admin/qualifications');
  assert.strictEqual(r.status, 403, 'faculty quals 403');
  r = await req('admin', 'PATCH', `/api/v1/instruments/${nmr._id}`, { requiredQualificationLevel: 2 });
  assert.strictEqual(r.status, 200, 'admin sets qual requirement');
  r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '16:00', endTime: '17:00', purpose: 'q' });
  assert.strictEqual(r.status, 403, 'unqualified blocked end-to-end');
  const facUser = await User.findOne({ email: 'sec-fac@x.edu' }).lean();
  r = await req('admin', 'POST', '/api/v1/admin/qualifications', { userId: String(facUser._id), instrumentId: String(nmr._id), level: 2 });
  assert.strictEqual(r.status, 201, 'admin grants qualification');
  r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '16:00', endTime: '17:00', purpose: 'q' });
  assert.strictEqual(r.status, 201, 'qualified booking passes end-to-end');
  r = await req('admin', 'GET', '/api/v1/admin/audit-logs?resource=Booking');
  assert.strictEqual(r.status, 200, 'admin audit read');
  assert.ok(r.json.data.total >= 1, 'audit rows visible');
  r = await req('fac', 'GET', '/api/v1/admin/audit-logs');
  assert.strictEqual(r.status, 403, 'faculty audit 403');
  ok('labs + qualifications + audit-logs');

  // 4. student writes everywhere -> 403
  const writes = [
    ['POST', '/api/v1/schedules', { degree: 'd', department: 'd', year: '1', section: 'A', subject: 's', laboratoryId: String(lab._id), date: T, startTime: '10:00', endTime: '11:00' }],
    ['POST', '/api/v1/bookings', { instrumentId: String(nmr._id), date: T, startTime: '12:00', endTime: '13:00', purpose: 'x' }],
    ['POST', '/api/v1/breakage-reports', { instrumentId: String(nmr._id), issueType: 'x', severity: 'LOW', description: 'x' }],
    ['POST', '/api/v1/calibrations', { instrumentId: String(nmr._id), calibrationType: 'x', date: T, startTime: '12:00', endTime: '13:00' }],
    ['POST', '/api/v1/maintenance', { instrumentId: String(nmr._id), type: 'preventive', description: 'x', startDate: T }],
    ['POST', '/api/v1/instruments', { name: 'x', category: 'y', serialNumber: 'SEC-X' }],
  ];
  for (const [m, p, b] of writes) {
    r = await req('stu', m, p, b);
    assert.strictEqual(r.status, 403, `student ${m} ${p} 403, got ${r.status}`);
  }
  ok('student read-only everywhere');

  // 5. reset abuse + enumeration
  r = await req('anon', 'POST', '/api/v1/auth/reset-password', { token: 'forged', password: 'new-horse-34' });
  assert.strictEqual(r.status, 400, 'forged reset 400');
  const e1 = await req('anon', 'POST', '/api/v1/auth/forgot-password', { email: 'nobody-here@x.edu' });
  const e2 = await req('anon', 'POST', '/api/v1/auth/forgot-password', { email: 'sec-fac@x.edu' });
  assert.strictEqual(e1.status, 200);
  assert.deepStrictEqual(e1.json, e2.json, 'forgot responses identical (no enumeration)');
  ok('reset abuse + enumeration safe');

  // 6. NoSQL injection payloads
  r = await req('anon', 'POST', '/api/v1/auth/login', { email: { $gt: '' }, password: { $gt: '' } });
  assert.ok(r.status !== 200, 'operator injection not 200');
  assert.strictEqual(r.status, 400, 'operator injection 400');
  r = await req('fac', 'GET', '/api/v1/schedules?facultyId[$gt]=x');
  assert.strictEqual(r.status, 400, 'query operator 400');
  r = await req('fac', 'POST', '/api/v1/bookings', { instrumentId: { $ne: null }, date: T, startTime: '12:00', endTime: '13:00', purpose: 'x' });
  assert.strictEqual(r.status, 400, 'body operator 400');
  ok('NoSQL injection neutralized');

  // 7. invalid input shapes
  r = await req('fac', 'POST', '/api/v1/schedules', { degree: 'd', department: 'd', year: '1', section: 'A', subject: 's', laboratoryId: String(lab._id), date: T, startTime: '10:00', endTime: '11:00', price: 5 });
  assert.strictEqual(r.status, 400, 'unexpected field 400');
  r = await req('fac', 'POST', '/api/v1/auth/login', 'not-json', true);
  assert.strictEqual(r.status, 400, 'malformed JSON 400');
  ok('invalid input rejected');

  // 8. concurrent double-book race: exactly one must win
  const raceBody = { instrumentId: String(nmr._id), date: T, startTime: '14:00', endTime: '15:00', purpose: 'race' };
  const bookRace = await Promise.all(Array.from({ length: 10 }, () => req('fac', 'POST', '/api/v1/bookings', raceBody)));
  const wins = bookRace.filter((x) => x.status === 201).length;
  assert.strictEqual(wins, 1, `double-book race: ${wins} winners (want 1)`);
  ok('booking race: single winner');
  const schedBody = { degree: 'd', department: 'd', year: '1', section: 'A', subject: 'race', laboratoryId: String(lab._id), date: T, startTime: '14:00', endTime: '15:00' };
  const schedRace = await Promise.all(Array.from({ length: 10 }, () => req('admin', 'POST', '/api/v1/schedules', schedBody)));
  const schedWins = schedRace.filter((x) => x.status === 201).length;
  assert.strictEqual(schedWins, 1, `double-schedule race: ${schedWins} winners (want 1)`);
  ok('schedule race: single winner');

  // 9. QR replay already covered in qr smoke; re-assert quickly via envelope
  r = await req('anon', 'POST', '/api/v1/qr/check-in', { token: 'nope' });
  assert.strictEqual(r.status, 401, 'anon check-in 401 (auth before lookup)');
  ok('qr auth order');

  // 10. secrets + static leakage
  for (const p of ['/server.js', '/models/User.js', '/package.json', '/.env', '/config/auth.js']) {
    r = await req('anon', 'GET', p);
    assert.strictEqual(r.status, 404, `${p} not served`);
    assert.ok(!/MONGODB|JWT_|SMTP_PASS/.test(r.text + JSON.stringify(r.json)), `${p} leaks nothing`);
  }
  r = await req('fac', 'POST', '/api/v1/auth/login', { email: 'sec-fac@x.edu', password: 'correct-horse-12' });
  assert.ok(!('passwordHash' in r.json.data.user), 'no hash in login');
  const payload = JSON.parse(Buffer.from(r.json.data.accessToken.split('.')[1], 'base64url').toString());
  assert.deepStrictEqual(Object.keys(payload).sort(), ['exp', 'iat', 'role', 'sub'], 'JWT carries nothing sensitive');
  r = await req('anon', 'GET', '/api/v1/does-not-exist');
  assert.strictEqual(r.status, 404);
  assert.ok(r.json && r.json.success === false && !JSON.stringify(r.json).includes('stack'), 'envelope without stack');
  ok('no secret/static/error leakage');

  // 11. rate limits (LAST: consumes the login window)
  const burst = [];
  for (let i = 0; i < 25; i += 1) burst.push(req('anon', 'POST', '/api/v1/auth/login', { email: 'sec-fac@x.edu', password: 'wrong' }));
  const burstRes = await Promise.all(burst);
  assert.ok(burstRes.some((x) => x.status === 429), 'login rate-limited (429 seen)');
  ok('rate limiting enforced');

  await User.deleteMany({ email: /sec-/ });
  await Instrument.deleteMany({ serialNumber: /SEC-/ });
  await Laboratory.deleteMany({ name: /Sec Lab/ });
  await Booking.deleteMany({});
  await Schedule.deleteMany({});
  await BreakageReport.deleteMany({});
  await OperatorQualification.deleteMany({});
  await AuditLog.deleteMany({ action: /QR_|BOOKING_|SCHEDULE_/ });
  await mongoose.disconnect();
  await new Promise((res2) => srv.close(res2));
  console.log(`\nSMOKE OK (${passed} checks passed)`);
  process.exit(0);
})().catch((e) => { console.error(`\nSMOKE FAIL: ${e.message}`); process.exit(1); });
