/**
 * Phase 03 smoke tests. Run: `node scripts/smoke-rbac.js` (needs live MONGODB_URI, else SKIP).
 * Admin faculty CRUD + server-side RBAC (API-level, not UI) + invite/activation + self-guards + audit rows.
 */
require('dotenv').config();
const assert = require('assert');

let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

(async () => {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) { console.log('rbac: SKIP (MONGODB_URI not set)'); process.exit(0); }
  try {
    const { connectDB } = require('../config/db');
    try { await connectDB(uri); } catch (e) { console.log(`rbac: SKIP (Mongo unreachable: ${e.message})`); process.exit(0); }

    const mongoose = require('mongoose');
    const app = require('../server');
    const srv = app.listen(0);
    await new Promise((r) => srv.on('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const User = require('../models/User');
    const AuditLog = require('../models/AuditLog');
    const { clearOutbox, getOutbox } = require('../services/email');
    const { hashPassword } = require('../utils/password');

    const cookies = {};
    const tokens = {};
    async function req(role, method, p, body) {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookies[role] ? { Cookie: cookies[role] } : {}),
          ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}),
        },
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
      return r;
    }

    await User.deleteMany({ email: /smoke3-/ });
    await AuditLog.deleteMany({ action: /FACULTY_/ });
    const mk = async (email, role, active) =>
      User.create({ name: 'Smoke3', email, passwordHash: await hashPassword('correct-horse-12'), role, isActive: active });
    const admin = await mk('smoke3-admin@x.edu', 'admin', true);
    await mk('smoke3-fac@x.edu', 'faculty', true);
    await mk('smoke3-stu@x.edu', 'student', true);
    await loginAs('admin', 'smoke3-admin@x.edu');
    ok('admin login');
    await loginAs('faculty', 'smoke3-fac@x.edu');
    await loginAs('student', 'smoke3-stu@x.edu');

    // unauthenticated + wrong-role rejections (API-level, not UI)
    let r = await req('nobody', 'GET', '/api/v1/admin/faculty');
    assert.strictEqual(r.status, 401, 'anon 401, got ' + r.status);
    r = await req('faculty', 'GET', '/api/v1/admin/faculty');
    assert.strictEqual(r.status, 403, 'faculty 403');
    assert.strictEqual(r.json.error.code, 'FORBIDDEN');
    r = await req('student', 'POST', '/api/v1/admin/faculty', { name: 'X', email: 'x@x.edu' });
    assert.strictEqual(r.status, 403, 'student 403');
    r = await req('faculty', 'POST', '/api/v1/admin/faculty', { name: 'X', email: 'x@x.edu' });
    assert.strictEqual(r.status, 403, 'faculty cannot create faculty');
    ok('RBAC denials (anon/faculty/student)');

    // admin creates faculty invite
    clearOutbox();
    r = await req('admin', 'POST', '/api/v1/admin/faculty',
      { name: 'New Fac', email: 'smoke3-new@x.edu', department: 'Chemistry', facultyId: 'FAC-001' });
    assert.strictEqual(r.status, 201, 'create 201, got ' + r.status);
    assert.strictEqual(r.json.data.user.role, 'faculty');
    assert.strictEqual(r.json.data.user.isActive, false, 'inactive until activation');
    assert.ok(!('passwordHash' in r.json.data.user), 'no hash leaked');
    assert.strictEqual(getOutbox().length, 1, 'invitation email queued');
    const newId = r.json.data.user._id;
    ok('admin creates faculty invite');

    // duplicate email -> 409
    r = await req('admin', 'POST', '/api/v1/admin/faculty', { name: 'Dup', email: 'smoke3-new@x.edu' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error.code, 'EMAIL_TAKEN');
    ok('duplicate email 409');

    // invited faculty cannot log in before activation (placeholder hash)
    r = await req('newbie', 'POST', '/api/v1/auth/login', { email: 'smoke3-new@x.edu', password: 'correct-horse-12' });
    assert.strictEqual(r.status, 401, 'pre-activation login impossible');
    // activate via invite token, then login works
    const inviteToken = getOutbox()[0].data.activationToken;
    r = await req('newbie', 'POST', '/api/v1/auth/activate', { token: inviteToken, password: 'correct-horse-12' });
    assert.strictEqual(r.status, 200, 'activation 200');
    await loginAs('newbie', 'smoke3-new@x.edu');
    ok('invite -> activation -> login');

    // list + detail
    r = await req('admin', 'GET', '/api/v1/admin/faculty');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.data.total >= 2 && r.json.data.users.every((u) => u.role === 'faculty'), 'faculty-scoped list');
    r = await req('admin', 'GET', `/api/v1/admin/faculty/${newId}`);
    assert.strictEqual(r.status, 200);
    ok('list + detail');

    // deactivate -> login dies; reactivate
    r = await req('admin', 'PATCH', `/api/v1/admin/faculty/${newId}`, { isActive: false });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.user.isActive, false);
    r = await req('newbie', 'POST', '/api/v1/auth/login', { email: 'smoke3-new@x.edu', password: 'correct-horse-12' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error.code, 'ACCOUNT_INACTIVE');
    r = await req('admin', 'PATCH', `/api/v1/admin/faculty/${newId}`, { isActive: true });
    assert.strictEqual(r.status, 200);
    ok('deactivate/reactivate');

    // promotion to admin blocked on this route
    r = await req('admin', 'PATCH', `/api/v1/admin/faculty/${newId}`, { role: 'admin' });
    assert.strictEqual(r.status, 400, 'role=admin rejected');
    ok('role escalation blocked');

    // self-guards
    r = await req('admin', 'PATCH', `/api/v1/admin/faculty/${admin._id}`, { isActive: false });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, 'SELF_LOCKOUT_BLOCKED');
    r = await req('admin', 'DELETE', `/api/v1/admin/faculty/${admin._id}`, null);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error.code, 'SELF_DELETE_BLOCKED');
    ok('self-lockout/self-delete blocked');

    // faculty cannot touch others via admin route either
    r = await req('faculty', 'PATCH', `/api/v1/admin/faculty/${newId}`, { department: 'Physics' });
    assert.strictEqual(r.status, 403, 'faculty PATCH 403');
    ok('faculty PATCH denied');

    // delete -> 204, login dead
    r = await req('admin', 'DELETE', `/api/v1/admin/faculty/${newId}`, null);
    assert.strictEqual(r.status, 204, 'delete 204');
    r = await req('newbie', 'POST', '/api/v1/auth/login', { email: 'smoke3-new@x.edu', password: 'correct-horse-12' });
    assert.strictEqual(r.status, 401);
    ok('delete faculty');

    // audit trail exists
    const audits = await AuditLog.find({ action: /FACULTY_/ }).lean();
    for (const a of ['FACULTY_CREATED', 'FACULTY_UPDATED', 'FACULTY_DELETED']) {
      assert.ok(audits.some((x) => x.action === a), `audit ${a} recorded`);
    }
    ok('audit rows (create/update/delete)');

    await User.deleteMany({ email: /smoke3-/ });
    await AuditLog.deleteMany({ action: /FACULTY_/ });
    await mongoose.disconnect();
    await new Promise((res2) => srv.close(res2));
    console.log(`\nSMOKE OK (${passed} checks passed)`);
    process.exit(0);
  } catch (e) {
    console.error(`\nSMOKE FAIL: ${e.message}`);
    process.exit(1);
  }
})();
