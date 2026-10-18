/**
 * Phase 04 smoke tests. Run: `node scripts/smoke-scheduling.js` (needs live MONGODB_URI, else SKIP).
 * Create/conflict/ownership/validation + created/modified/cancelled emails + notifications + audit.
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
  if (!uri) { console.log('sched: SKIP (MONGODB_URI not set)'); process.exit(0); }
  try {
    const { connectDB } = require('../config/db');
    try { await connectDB(uri); } catch (e) { console.log(`sched: SKIP (Mongo unreachable: ${e.message})`); process.exit(0); }

    const mongoose = require('mongoose');
    const app = require('../server');
    const srv = app.listen(0);
    await new Promise((r) => srv.on('listening', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const User = require('../models/User');
    const Laboratory = require('../models/Laboratory');
    const Schedule = require('../models/Schedule');
    const Notification = require('../models/Notification');
    const AuditLog = require('../models/AuditLog');
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

    await User.deleteMany({ email: /smoke4-/ });
    await Laboratory.deleteMany({ name: /Smoke4/ });
    await Schedule.deleteMany({});
    await Notification.deleteMany({ type: /schedule-/ });
    await AuditLog.deleteMany({ action: /SCHEDULE_/ });

    const mk = async (email, role) =>
      User.create({ name: 'Smoke4', email, passwordHash: await hashPassword('correct-horse-12'), role, isActive: true });
    await mk('smoke4-admin@x.edu', 'admin');
    await mk('smoke4-a@x.edu', 'faculty');
    await mk('smoke4-b@x.edu', 'faculty');
    await mk('smoke4-stu@x.edu', 'student');
    const chem = await Laboratory.create({ name: 'Smoke4 Chemistry Lab', building: 'B1', roomNumber: '101', status: 'AVAILABLE' });
    const phys = await Laboratory.create({ name: 'Smoke4 Physics Lab', building: 'B1', roomNumber: '102', status: 'AVAILABLE' });
    const maint = await Laboratory.create({ name: 'Smoke4 Closed Lab', status: 'UNDER_MAINTENANCE' });
    await loginAs('admin', 'smoke4-admin@x.edu');
    await loginAs('facA', 'smoke4-a@x.edu');
    await loginAs('facB', 'smoke4-b@x.edu');
    await loginAs('stu', 'smoke4-stu@x.edu');

    const T = tomorrowStr();
    const base2 = { degree: 'BSc', department: 'Chemistry', year: 'II', section: 'A', subject: 'Titration', laboratoryId: String(chem._id), date: T };

    // create + email/notification content (§5 fields)
    clearOutbox();
    let r = await req('facA', 'POST', '/api/v1/schedules', { ...base2, startTime: '10:00', endTime: '12:00' });
    assert.strictEqual(r.status, 201, 'create 201, got ' + r.status);
    const schedId = r.json.data.schedule._id;
    assert.strictEqual(getOutbox().length, 1, 'confirmation email queued');
    const mail = getOutbox()[0];
    assert.strictEqual(mail.template, 'schedule-created');
    for (const k of ['facultyName', 'degree', 'department', 'year', 'section', 'subject', 'laboratory', 'date', 'startTime', 'endTime', 'status', 'referenceId']) {
      assert.ok(mail.data[k] !== undefined && mail.data[k] !== '', `email has ${k}`);
    }
    const notifs = await Notification.find({ type: 'schedule-created' }).lean();
    assert.strictEqual(notifs.length, 1, 'notification row created');
    assert.strictEqual(notifs[0].emailSent, true);
    ok('create + confirmation email + notification');

    // conflicts
    r = await req('facB', 'POST', '/api/v1/schedules', { ...base2, startTime: '11:00', endTime: '13:00', subject: 'Clash' });
    assert.strictEqual(r.status, 409, 'overlap 409');
    assert.strictEqual(r.json.error.code, 'LAB_CONFLICT');
    r = await req('facB', 'POST', '/api/v1/schedules', { ...base2, startTime: '10:00', endTime: '12:00', subject: 'Same' });
    assert.strictEqual(r.status, 409, 'identical slot 409');
    ok('overlap + identical rejected');

    // boundaries + other lab
    r = await req('facB', 'POST', '/api/v1/schedules', { ...base2, startTime: '12:00', endTime: '14:00', subject: 'Adjacent' });
    assert.strictEqual(r.status, 201, 'adjacent slot allowed');
    const adjId = r.json.data.schedule._id;
    r = await req('facB', 'POST', '/api/v1/schedules', { ...base2, laboratoryId: String(phys._id), startTime: '10:00', endTime: '12:00', subject: 'Other lab' });
    assert.strictEqual(r.status, 201, 'other lab allowed');
    ok('adjacent + different-lab allowed');

    // validation
    r = await req('facA', 'POST', '/api/v1/schedules', { ...base2, startTime: '14:00', endTime: '12:00' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'INVALID_TIME_RANGE');
    r = await req('facA', 'POST', '/api/v1/schedules', { ...base2, date: 'tomorrow', startTime: '10:00', endTime: '11:00' });
    assert.strictEqual(r.status, 422, 'bad date 422');
    r = await req('facA', 'POST', '/api/v1/schedules', { ...base2, date: '2020-01-01', startTime: '10:00', endTime: '11:00' });
    assert.strictEqual(r.status, 422, 'past date 422');
    r = await req('facA', 'POST', '/api/v1/schedules', { ...base2, laboratoryId: String(new mongoose.Types.ObjectId()), startTime: '15:00', endTime: '16:00' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.json.error.code, 'LAB_NOT_FOUND');
    r = await req('facA', 'POST', '/api/v1/schedules', { ...base2, laboratoryId: String(maint._id), startTime: '15:00', endTime: '16:00' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error.code, 'LAB_UNAVAILABLE');
    r = await req('facA', 'POST', '/api/v1/schedules', { ...base2, facultyId: String(chem._id), startTime: '15:00', endTime: '16:00' });
    assert.strictEqual(r.status, 400, 'client facultyId rejected');
    ok('validation (range/date/lab/client-id)');

    // role gates
    r = await req('stu', 'POST', '/api/v1/schedules', { ...base2, startTime: '15:00', endTime: '16:00' });
    assert.strictEqual(r.status, 403, 'student write 403');
    r = await req('stu', 'GET', '/api/v1/schedules');
    assert.strictEqual(r.status, 200, 'student read 200');
    r = await req('nobody', 'GET', '/api/v1/schedules');
    assert.strictEqual(r.status, 401, 'anon 401');
    r = await req('facA', 'GET', '/api/v1/schedules?mine=true');
    const det = await req('facA', 'GET', `/api/v1/schedules/${schedId}`);
    const ownId = String(det.json.data.schedule.facultyId._id);
    assert.ok(r.json.data.schedules.length >= 1, 'mine returns rows');
    assert.ok(r.json.data.schedules.every((s) => String(s.facultyId._id) === ownId), 'mine returns only own');
    ok('role gates (student read-only, anon denied)');

    // ownership
    r = await req('facB', 'PATCH', `/api/v1/schedules/${schedId}`, { notes: 'hijack' });
    assert.strictEqual(r.status, 403, 'cross-faculty edit 403');
    clearOutbox();
    r = await req('facA', 'PATCH', `/api/v1/schedules/${schedId}`, { notes: 'bring goggles' });
    assert.strictEqual(r.status, 200, 'own edit 200');
    assert.strictEqual(getOutbox()[0].template, 'schedule-modified', 'modified email sent');
    r = await req('facA', 'PATCH', `/api/v1/schedules/${schedId}`, { startTime: '11:30', endTime: '12:30' });
    assert.strictEqual(r.status, 409, 'edit into conflict 409');
    r = await req('facB', 'DELETE', `/api/v1/schedules/${schedId}`, null);
    assert.strictEqual(r.status, 403, 'cross-faculty delete 403');
    ok('ownership (edit/delete own only)');

    // admin global + cancelled email + audit
    clearOutbox();
    r = await req('admin', 'DELETE', `/api/v1/schedules/${schedId}`, null);
    assert.strictEqual(r.status, 204, 'admin delete any 204');
    assert.strictEqual(getOutbox()[0].template, 'schedule-cancelled', 'cancelled email sent');
    const audits = await AuditLog.find({ action: /SCHEDULE_/ }).lean();
    for (const a of ['SCHEDULE_CREATED', 'SCHEDULE_UPDATED', 'SCHEDULE_DELETED']) {
      assert.ok(audits.some((x) => x.action === a), `audit ${a}`);
    }
    ok('admin delete + cancelled email + audit');

    await User.deleteMany({ email: /smoke4-/ });
    await Laboratory.deleteMany({ name: /Smoke4/ });
    await Schedule.deleteMany({});
    await Notification.deleteMany({ type: /schedule-/ });
    await AuditLog.deleteMany({ action: /SCHEDULE_/ });
    await mongoose.disconnect();
    await new Promise((res2) => srv.close(res2));
    console.log(`\nSMOKE OK (${passed} checks passed)`);
    process.exit(0);
  } catch (e) {
    console.error(`\nSMOKE FAIL: ${e.message}`);
    process.exit(1);
  }
})();
