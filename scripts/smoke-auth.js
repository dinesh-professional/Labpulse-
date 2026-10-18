/**
 * Phase 02 smoke tests. Run: `node scripts/smoke-auth.js`
 * - Unit checks (no DB): password policy/hash, opaque-token hashing, email outbox.
 * - HTTP flow (needs live MongoDB via MONGODB_URI): seeds admin+faculty+student+inactive,
 *   then exercises valid/invalid/inactive login, me, forgot (generic), reset, token reuse,
 *   expired token, refresh rotation + replay rejection, logout.
 * Without MONGODB_URI the HTTP section reports SKIP (unit checks still run).
 */
require('dotenv').config();
const assert = require('assert');

const { validatePasswordPolicy, hashPassword, verifyPassword } = require('../utils/password');
const { issueOpaqueToken, hashOpaqueToken } = require('../utils/tokens');
const { sendEmail, getOutbox, clearOutbox } = require('../services/email');

let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

async function unitChecks() {
  console.log('unit:');
  assert.strictEqual(validatePasswordPolicy('short'), 'Password must be at least 8 characters.');
  assert.strictEqual(validatePasswordPolicy('a'.repeat(129)), 'Password must be at most 128 characters.');
  assert.strictEqual(validatePasswordPolicy('correct-horse-12'), null);
  ok('password policy');

  const h = await hashPassword('correct-horse-12');
  assert.ok(h !== 'correct-horse-12', 'must not store plaintext');
  assert.ok(await verifyPassword('correct-horse-12', h), 'valid verifies');
  assert.ok(!(await verifyPassword('wrong-pass-99', h)), 'invalid rejects');
  ok('password hash/verify');

  const { token, tokenHash } = issueOpaqueToken();
  assert.strictEqual(hashOpaqueToken(token), tokenHash, 'opaque token round-trips');
  assert.ok(!tokenHash.includes(token.slice(0, 8)), 'hash reveals nothing');
  ok('opaque token hash');

  clearOutbox();
  const r = await sendEmail({ to: 'a@x.edu', subject: 't', template: 'password-reset', data: {} });
  assert.ok(r.queued && getOutbox().length === 1, 'email abstraction queues');
  ok('email abstraction outbox');
}

async function httpFlow() {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) { console.log('http: SKIP (MONGODB_URI not set)'); return; }
  console.log('http:');
  const { connectDB } = require('../config/db');
  try {
    await connectDB(uri);
  } catch (e) { console.log(`http: SKIP (Mongo unreachable: ${e.message})`); return; }

  const mongoose = require('mongoose');
  const app = require('../server');
  const srv = app.listen(0);
  await new Promise((r) => srv.on('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const User = require('../models/User');
  const { hashPassword: hp } = require('../utils/password');

  const jar = {};
  async function req(method, p, body, cookie) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/lp_refresh=([^;]*)/);
      if (m) jar.refresh = `lp_refresh=${m[1]}`;
    }
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, json };
  }

  await User.deleteMany({ email: /smoke-test\./ });
  const mk = async (email, role, active) =>
    User.create({ name: 'Smoke', email, passwordHash: await hp('correct-horse-12'), role, isActive: active });
  await mk('smoke-test.admin@x.edu', 'admin', true);
  await mk('smoke-test.fac@x.edu', 'faculty', true);
  await mk('smoke-test.stu@x.edu', 'student', true);
  await mk('smoke-test.off@x.edu', 'faculty', false);

  // valid login
  let r = await req('POST', '/api/v1/auth/login', { email: 'smoke-test.fac@x.edu', password: 'correct-horse-12' });
  assert.strictEqual(r.status, 200, 'valid login 200');
  assert.ok(r.json.data.accessToken && !('passwordHash' in r.json.data.user), 'token issued, no hash leaked');
  const access = r.json.data.accessToken;
  ok('valid login');

  // invalid login (generic, no enumeration)
  r = await req('POST', '/api/v1/auth/login', { email: 'smoke-test.fac@x.edu', password: 'wrong-pass-99' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error.code, 'INVALID_CREDENTIALS');
  r = await req('POST', '/api/v1/auth/login', { email: 'nobody-here@x.edu', password: 'wrong-pass-99' });
  assert.strictEqual(r.status, 401, 'unknown email also 401');
  ok('invalid login');

  // inactive account
  r = await req('POST', '/api/v1/auth/login', { email: 'smoke-test.off@x.edu', password: 'correct-horse-12' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.error.code, 'ACCOUNT_INACTIVE');
  ok('inactive account rejected');

  // me
  const authed = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${access}` } });
  assert.strictEqual(authed.status, 200);
  const meJson = await authed.json();
  assert.strictEqual(meJson.data.user.email, 'smoke-test.fac@x.edu');
  const anon = await fetch(`${base}/api/v1/auth/me`);
  assert.strictEqual(anon.status, 401);
  ok('me (auth + unauth)');

  // forgot: generic for existing AND unknown
  clearOutbox();
  r = await req('POST', '/api/v1/auth/forgot-password', { email: 'smoke-test.fac@x.edu' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(getOutbox().length, 1, 'reset email queued');
  const resetToken = getOutbox()[0].data.resetToken;
  r = await req('POST', '/api/v1/auth/forgot-password', { email: 'ghost@x.edu' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(getOutbox().length, 1, 'unknown email queues nothing, same response');
  assert.ok(!JSON.stringify(r.json).includes('ghost'), 'no enumeration');
  ok('forgot-password generic');

  // reset success
  r = await req('POST', '/api/v1/auth/reset-password', { token: resetToken, password: 'new-horse-34' });
  assert.strictEqual(r.status, 200);
  ok('reset success');

  // reuse rejected (single-use)
  r = await req('POST', '/api/v1/auth/reset-password', { token: resetToken, password: 'another-56' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, 'INVALID_OR_EXPIRED_TOKEN');
  ok('reset token reuse rejected');

  // expired token rejected
  const { token: t2, tokenHash: h2 } = require('../utils/tokens').issueOpaqueToken();
  await User.updateOne({ email: 'smoke-test.fac@x.edu' },
    { $set: { passwordResetTokenHash: h2, passwordResetExpires: new Date(Date.now() - 1000) } });
  r = await req('POST', '/api/v1/auth/reset-password', { token: t2, password: 'another-56' });
  assert.strictEqual(r.status, 400);
  ok('expired token rejected');

  // new password works, old dies
  r = await req('POST', '/api/v1/auth/login', { email: 'smoke-test.fac@x.edu', password: 'new-horse-34' });
  assert.strictEqual(r.status, 200);
  r = await req('POST', '/api/v1/auth/login', { email: 'smoke-test.fac@x.edu', password: 'correct-horse-12' });
  assert.strictEqual(r.status, 401);
  ok('post-reset credential rotation');

  // refresh rotation + replay rejection
  const firstCookie = jar.refresh;
  r = await req('POST', '/api/v1/auth/refresh', null, firstCookie);
  assert.strictEqual(r.status, 200, 'refresh 200');
  assert.ok(r.json.data.accessToken, 'new access issued');
  r = await req('POST', '/api/v1/auth/refresh', null, firstCookie);
  assert.strictEqual(r.status, 401, 'replayed refresh rejected');
  ok('refresh rotation + replay rejected');

  // logout clears + invalidates
  const liveCookie = jar.refresh;
  r = await req('POST', '/api/v1/auth/logout', null, liveCookie);
  assert.strictEqual(r.status, 200);
  r = await req('POST', '/api/v1/auth/refresh', null, liveCookie);
  assert.strictEqual(r.status, 401, 'post-logout refresh dead');
  ok('logout');

  await User.deleteMany({ email: /smoke-test\./ });
  await mongoose.disconnect();
  await new Promise((res2) => srv.close(res2));
}

(async () => {
  try {
    await unitChecks();
    await httpFlow();
    console.log(`\nSMOKE OK (${passed} checks passed)`);
    process.exit(0);
  } catch (e) {
    console.error(`\nSMOKE FAIL: ${e.message}`);
    process.exit(1);
  }
})();
