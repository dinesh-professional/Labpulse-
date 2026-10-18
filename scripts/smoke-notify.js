/**
 * Phase 09 smoke tests. Run: `node scripts/smoke-notify.js`
 * Unit (no DB): every template renders, values escaped, §5 schedule fields covered,
 * dev outbox still works, SMTP failure path retries then reports sent:false (no throw).
 * DB (needs MONGODB_URI, else SKIP): notifyUser records delivery status on the row.
 */
require('dotenv').config();
const assert = require('assert');

let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

const TEMPLATE_KEYS = [
  'faculty-invitation', 'password-reset', 'password-changed',
  'schedule-created', 'schedule-modified', 'schedule-cancelled',
  'booking-created', 'booking-cancelled',
  'calibration-scheduled', 'calibration-updated', 'calibration-completed',
  'maintenance-scheduled', 'maintenance-updated', 'maintenance-completed',
  'breakage-reported', 'breakage-confirmed', 'breakage-updated', 'breakage-resolved',
];

// Spec §5 required schedule-email fields.
const SCHEDULE_FIELDS = ['facultyName', 'degree', 'department', 'year', 'section', 'subject',
  'laboratory', 'date', 'startTime', 'endTime', 'status', 'referenceId'];

(async () => {
  const { renderTemplate } = require('../services/templates');

  for (const key of TEMPLATE_KEYS) {
    const { html, text, title } = renderTemplate(key, { sample: 'x' });
    assert.ok(title && html.includes('LabPulse') && text.includes('LabPulse'), `template ${key} renders`);
  }
  ok(`${TEMPLATE_KEYS.length} templates render`);

  const evil = '<script>alert(1)</script>';
  const { html } = renderTemplate('schedule-created', { subject: evil });
  assert.ok(!html.includes(evil) && html.includes('&lt;script&gt;'), 'values escaped');
  ok('HTML escaping');

  const schedData = Object.fromEntries(SCHEDULE_FIELDS.map((f) => [f, `v-${f}`]));
  const out = renderTemplate('schedule-created', schedData);
  for (const f of SCHEDULE_FIELDS) assert.ok(out.html.includes(`v-${f}`), `§5 field ${f} present`);
  ok('§5 schedule-email field coverage');

  // dev provider: outbox interface preserved for older smokes
  delete process.env.EMAIL_PROVIDER;
  const { sendEmail, getOutbox, clearOutbox } = require('../services/email');
  clearOutbox();
  const r1 = await sendEmail({ to: 'a@x.edu', subject: 't', template: 'password-reset', data: { resetToken: 'tok123' } });
  assert.ok(r1.sent && r1.attempts === 1 && getOutbox().length === 1, 'dev send queues');
  assert.strictEqual(getOutbox()[0].data.resetToken, 'tok123', 'token payload intact for tests');
  ok('dev outbox preserved');

  // smtp failure path: refuses fast locally, retries 3x, never throws
  process.env.EMAIL_PROVIDER = 'smtp';
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = '1';
  delete require.cache[require.resolve('../services/email')];
  const smtpMail = require('../services/email');
  const t0 = Date.now();
  const r2 = await smtpMail.sendEmail({ to: 'a@x.edu', subject: 't', template: 'password-reset', data: {} });
  assert.ok(!r2.sent && r2.attempts === 3 && r2.error, 'smtp failure retries then reports');
  assert.ok(Date.now() - t0 < 30000, 'backoff bounded');
  delete process.env.EMAIL_PROVIDER;
  ok('smtp retry/failure reporting');

  // DB-backed delivery-status recording
  const uri = process.env.MONGODB_URI || '';
  let dbUp = !!uri;
  if (!uri) {
    console.log('notify-db: SKIP (MONGODB_URI not set)');
  } else {
    const { connectDB } = require('../config/db');
    try { await connectDB(uri); } catch (e) { console.log(`notify-db: SKIP (${e.message})`); dbUp = false; }
  }
  if (dbUp) {
    const mongoose = require('mongoose');
    const User = require('../models/User');
    const Notification = require('../models/Notification');
    const { notifyUser } = require('../services/notify');
    const { hashPassword } = require('../utils/password');
    await User.deleteMany({ email: /smoke9-/ });
    await Notification.deleteMany({ type: /smoke9/ });
    const u = await User.create({ name: 'S9', email: 'smoke9-u@x.edu', passwordHash: await hashPassword('correct-horse-12'), role: 'faculty', isActive: true });
    const o1 = await notifyUser({ userId: u._id, type: 'smoke9-mail', title: 't', message: 'm', email: { to: u.email, subject: 't', template: 'schedule-created', data: { subject: 'x' } } });
    assert.ok(o1.emailSent && o1.emailAttempts === 1, 'dev delivery recorded sent');
    const o2 = await notifyUser({ userId: u._id, type: 'smoke9-inapp', title: 't', message: 'm', email: null });
    assert.ok(!o2.emailSent && o2.emailAttempts === 0, 'in-app-only recorded');
    const rows = await Notification.find({ type: /smoke9/ }).lean();
    assert.strictEqual(rows.length, 2, 'matching in-app rows');
    assert.ok(rows.every((x) => x.emailAttempts !== undefined), 'attempts persisted');
    ok('delivery-status recording');

    // read side: own rows, mark read, cross-user isolation
    const app = require('../server');
    const srv = app.listen(0);
    await new Promise((ready) => srv.on('listening', ready));
    const base = `http://127.0.0.1:${srv.address().port}`;
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
    const u2 = await User.create({ name: 'S9b', email: 'smoke9-v@x.edu', passwordHash: await hashPassword('correct-horse-12'), role: 'student', isActive: true });
    let lr = await http('u', 'POST', '/api/v1/auth/login', { email: 'smoke9-u@x.edu', password: 'correct-horse-12' });
    assert.strictEqual(lr.status, 200, 'login for notify read');
    lr = await http('v', 'POST', '/api/v1/auth/login', { email: 'smoke9-v@x.edu', password: 'correct-horse-12' });
    assert.strictEqual(lr.status, 200, 'second login');
    lr = await http('anon', 'GET', '/api/v1/notifications');
    assert.strictEqual(lr.status, 401, 'anon denied');
    lr = await http('u', 'GET', '/api/v1/notifications');
    assert.strictEqual(lr.status, 200);
    assert.strictEqual(lr.json.data.total, 2, 'own rows listed');
    assert.strictEqual(lr.json.data.unread, 2, 'unread counted');
    const nid = lr.json.data.notifications[0]._id;
    lr = await http('u', 'PATCH', `/api/v1/notifications/${nid}/read`);
    assert.strictEqual(lr.status, 200);
    assert.strictEqual(lr.json.data.notification.read, true, 'marked read');
    lr = await http('v', 'PATCH', `/api/v1/notifications/${nid}/read`);
    assert.strictEqual(lr.status, 404, 'cross-user read 404');
    lr = await http('u', 'GET', '/api/v1/notifications?read=false');
    assert.strictEqual(lr.json.data.total, 1, 'read filter works');
    ok('notification read API + isolation');
    await new Promise((res2) => srv.close(res2));
    await User.deleteMany({ email: /smoke9-/ });
    await Notification.deleteMany({ type: /smoke9/ });
    await mongoose.disconnect();
  }

  console.log(`\nSMOKE OK (${passed} checks passed)`);
  process.exit(0);
})().catch((e) => { console.error(`\nSMOKE FAIL: ${e.message}`); process.exit(1); });
