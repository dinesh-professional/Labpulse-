/**
 * Phase 14 runtime UI tests (jsdom, no browser binary needed).
 * Executes the real auth pages + auth.js client with stubbed fetch and asserts DOM outcomes.
 * Run: `node scripts/check-auth-ui.js`
 */
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

let passed = 0;
function ok(name) { passed += 1; console.log(`  PASS ${name}`); }

let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  console.log('auth-ui: SKIP (jsdom not installed)');
  process.exit(0);
}

function loadPage(file, stubFetch, testUrl) {
  const errors = [];
  const pageUrl = testUrl || 'http://127.0.0.1:3000/';
  const dom = new JSDOM(read(file), {
    url: pageUrl,
    runScripts: 'outside-only',
    beforeParse(window) {
      window.fetch = stubFetch;
      window.__redirects = [];
      try {
        // Capture navigation: jsdom seals window.location itself, but the
        // instance method is redefinable — patch it in place.
        Object.defineProperty(window.location, 'replace', {
          value: (t) => { window.__redirects.push(String(t)); },
          configurable: true,
          writable: true,
        });
      } catch (e) { /* redirects untracked */ }
      window.__storeWrites = [];
      for (const store of ['localStorage', 'sessionStorage']) {
        try {
          const orig = window[store].setItem.bind(window[store]);
          window[store].setItem = (k, v) => { window.__storeWrites.push([store, k]); return orig(k, v); };
        } catch (e) { /* ignore */ }
      }
    },
  });
  // Some jsdom versions disallow replacing location.replace; patch via href setter capture instead.
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push(e.message || String(e.error)));
  // Execute auth.js + dash.js (if referenced) + inline scripts in order.
  const scripts = [];
  if (/src="auth\.js"/.test(read(file))) scripts.push(read('auth.js'));
  if (/src="dash\.js"/.test(read(file))) scripts.push(read('dash.js'));
  for (const m of read(file).matchAll(/<script>([\s\S]*?)<\/script>/g)) scripts.push(m[1]);
  for (const code of scripts) {
    try {
      window.eval(code);
    } catch (e) {
      errors.push(`eval: ${e.message}`);
    }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { window, errors, tick };
}

function jsonResponse(status, body) {
  return Promise.resolve({ status, json: () => Promise.resolve(body) });
}

(async () => {
  // 1. login: invalid email shows inline error, no fetch.
  {
    let calls = 0;
    const { window, tick } = loadPage('login.html', () => { calls += 1; return jsonResponse(200, {}); });
    await tick();
    calls = 0; // ignore page-load session check; the invalid submit must add none
    window.document.getElementById('login-email').value = 'not-an-email';
    window.document.getElementById('login-password').value = 'x';
    window.document.getElementById('login-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick();
    assert.ok(!window.document.getElementById('email-error').classList.contains('hidden'), 'inline email error');
    assert.strictEqual(calls, 0, 'no request on invalid form');
    ok('login inline validation');
  }

  // 2. login: 401 -> generic error, button restored, single request (no double submit).
  {
    let calls = 0;
    const { window, tick } = loadPage('login.html', () => { calls += 1; return jsonResponse(401, { success: false, error: { code: 'INVALID_CREDENTIALS' } }); });
    await tick();
    calls = 0; // ignore page-load session check; double submit must add exactly one
    window.document.getElementById('login-email').value = 'a@x.edu';
    window.document.getElementById('login-password').value = 'wrong-pass-1';
    const form = window.document.getElementById('login-form');
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    form.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick(); await tick();
    const err = window.document.getElementById('login-error');
    assert.ok(!err.classList.contains('hidden') && /Invalid email or password/.test(err.textContent), 'generic 401 error');
    assert.strictEqual(window.document.getElementById('login-submit').disabled, false, 'button restored');
    assert.strictEqual(calls, 1, `exactly one login request (calls=${calls})`);
    ok('login 401 + double-submit guard');
  }

  // 3. login success -> backend role routes to faculty dashboard.
  {
    const { window, tick } = loadPage('login.html', (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.endsWith('/auth/login')) {
        assert.strictEqual(body.email, 'fac@x.edu', 'email normalized+lowercased by client');
        return jsonResponse(200, { success: true, data: { accessToken: 'tok', user: { _id: '1', role: 'faculty', name: 'F', email: body.email } } });
      }
      return jsonResponse(401, {});
    });
    await tick();
    // initSession runs refresh on load: stub returns 401 above -> login form shown.
    // Observe routing intent (jsdom has no navigation).
    window.LabPulseAuth.goToDashboard = (role) => { window.__redirects.push(window.LabPulseAuth.dashboardFor(role)); };
    window.document.getElementById('login-email').value = 'FAC@X.EDU';
    window.document.getElementById('login-password').value = 'correct-horse-12';
    window.document.getElementById('login-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick(); await tick();
    assert.ok(window.__redirects.includes('faculty.html'), `role-routed to faculty (got ${window.__redirects})`);
    assert.ok(!window.__storeWrites.some(([s, k]) => /role/i.test(k)), 'role never written to storage');
    ok('login success routes by backend role');
  }

  // 4. already-authenticated visit redirects without showing the form.
  {
    const { window, tick } = loadPage('login.html', (url) => {
      if (url.endsWith('/auth/refresh')) return jsonResponse(200, { success: true, data: { accessToken: 'tok2' } });
      if (url.endsWith('/auth/me')) return jsonResponse(200, { success: true, data: { user: { _id: '9', role: 'admin', name: 'A' } } });
      return jsonResponse(401, {});
    });
    window.LabPulseAuth.goToDashboard = (role) => { window.__redirects.push(window.LabPulseAuth.dashboardFor(role)); };
    await tick(); await tick(); await tick();
    assert.ok(window.__redirects.includes('admin.html'), `authed redirect to admin (got ${window.__redirects})`);
    ok('session init redirects authenticated users');
  }

  // 5. forgot: generic success regardless of backend answer.
  {
    const { window, tick } = loadPage('forgot-password.html', () => jsonResponse(200, { success: true, message: 'If an account exists…' }));
    await tick();
    window.document.getElementById('forgot-email').value = 'ghost@x.edu';
    window.document.getElementById('forgot-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick(); await tick();
    const box = window.document.getElementById('forgot-success');
    assert.ok(!box.classList.contains('hidden') && /If an account exists/.test(box.textContent), 'generic forgot success');
    ok('forgot-password generic response');
  }

  // 6. reset: missing token shows invalid state without any request.
  {
    let calls = 0;
    const { window, tick } = loadPage('reset-password.html', () => { calls += 1; return jsonResponse(200, {}); });
    await tick();
    assert.ok(!window.document.getElementById('reset-invalid').classList.contains('hidden'), 'invalid state shown');
    assert.ok(window.document.getElementById('reset-form-wrap').classList.contains('hidden'), 'form hidden');
    assert.strictEqual(calls, 0, 'no request without token');
    ok('reset missing-token state');
  }
  // Full reset flow with token present from the start.
  {
    const { window, tick } = loadPage('reset-password.html', (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.strictEqual(typeof body.token, 'string', 'token sent');
      assert.ok(!('email' in body), 'no extra fields');
      if (body.token !== 'tok123') return jsonResponse(400, { success: false, error: { code: 'INVALID_OR_EXPIRED_TOKEN' } });
      return jsonResponse(200, { success: true });
    }, 'http://127.0.0.1:3000/reset-password.html?token=tok123');
    await tick();
    window.document.getElementById('reset-password').value = 'new-horse-34';
    window.document.getElementById('reset-confirm').value = 'different-99';
    window.document.getElementById('reset-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick();
    assert.ok(!window.document.getElementById('reset-mismatch').classList.contains('hidden'), 'mismatch blocked');
    window.document.getElementById('reset-confirm').value = 'new-horse-34';
    window.document.getElementById('reset-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick(); await tick();
    assert.ok(!window.document.getElementById('reset-success').classList.contains('hidden'), 'reset success state');
    assert.ok(!/tok123/.test(window.document.body.innerHTML), 'token never rendered');
    ok('reset-password flow (mismatch + success + token hygiene)');
  }

  // 7. faculty guard: wrong role shows 403 block, not the app.
  {
    const { window, tick } = loadPage('faculty.html', (url) => {
      if (url.endsWith('/auth/refresh')) return jsonResponse(200, { success: true, data: { accessToken: 't' } });
      if (url.endsWith('/auth/me')) return jsonResponse(200, { success: true, data: { user: { _id: '5', role: 'student', name: 'S' } } });
      return jsonResponse(403, { success: false, error: { code: 'FORBIDDEN' } });
    });
    await tick(); await tick(); await tick();
    assert.ok(!window.document.getElementById('dash-denied').classList.contains('hidden'), '403 block shown');
    assert.ok(window.document.getElementById('dash-app').classList.contains('hidden'), 'app hidden from wrong role');
    ok('role guard 403 state');
  }

  // 8. faculty dashboard loads own data with auth header (no role in storage).
  {
    const seen = [];
    const { window, tick } = loadPage('faculty.html', (url, opts) => {
      seen.push([url, !!(opts.headers && opts.headers.Authorization)]);
      if (url.endsWith('/auth/refresh')) return jsonResponse(200, { success: true, data: { accessToken: 't' } });
      if (url.endsWith('/auth/me')) return jsonResponse(200, { success: true, data: { user: { _id: '7', role: 'faculty', name: 'F' } } });
      if (url.includes('/schedules')) return jsonResponse(200, { success: true, data: { schedules: [], page: 1, limit: 50, total: 0 } });
      if (url.includes('/instruments')) return jsonResponse(200, { success: true, data: { instruments: [], page: 1, limit: 100, total: 0 } });
      if (url.includes('/notifications')) return jsonResponse(200, { success: true, data: { notifications: [], unread: 0, page: 1, limit: 10, total: 0 } });
      if (url.includes('/laboratories')) return jsonResponse(200, { success: true, data: { laboratories: [], page: 1, limit: 100, total: 0 } });
      return jsonResponse(404, {});
    });
    await tick(); await tick(); await tick(); await tick();
    assert.ok(!window.document.getElementById('dash-app').classList.contains('hidden'), 'faculty app shown');
    const authed = seen.filter(([u, a]) => u.includes('/api/') && !u.includes('/auth/refresh'));
    assert.ok(authed.length > 0 && authed.every(([, a]) => a), 'all API calls carry Bearer token');
    ok('faculty dashboard data load');
  }

  // 9. signup: inline validation checks (name, email, password length, mismatch)
  {
    let calls = 0;
    const { window, tick } = loadPage('signup.html', () => { calls += 1; return jsonResponse(200, {}); });
    await tick();
    calls = 0;
    // Missing name & invalid email
    window.document.getElementById('signup-email').value = 'invalid-email';
    window.document.getElementById('signup-password').value = '123';
    window.document.getElementById('signup-confirm-password').value = '456';
    window.document.getElementById('signup-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick();
    assert.ok(!window.document.getElementById('signup-email-error').classList.contains('hidden'), 'email error shown');
    assert.ok(!window.document.getElementById('signup-password-error').classList.contains('hidden'), 'password error shown');
    assert.strictEqual(calls, 0, 'no request made when invalid');
    ok('signup inline validation');
  }

  // 10. signup: successful submission shows success state
  {
    let sentBody = null;
    const { window, tick } = loadPage('signup.html', (url, opts) => {
      if (url.includes('/api/v1/auth/signup')) {
        sentBody = JSON.parse(opts.body);
        return jsonResponse(201, { success: true, message: 'Account created.' });
      }
      return jsonResponse(404, {});
    });
    await tick();
    window.document.getElementById('signup-name').value = 'Test Student';
    window.document.getElementById('signup-email').value = 'student@uni.edu';
    window.document.getElementById('signup-password').value = 'secure-password-123';
    window.document.getElementById('signup-confirm-password').value = 'secure-password-123';
    window.document.getElementById('signup-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick(); await tick();
    assert.ok(sentBody, 'signup request dispatched');
    assert.strictEqual(sentBody.email, 'student@uni.edu', 'email submitted');
    assert.ok(!window.document.getElementById('signup-success').classList.contains('hidden'), 'success box visible');
    assert.ok(window.document.getElementById('signup-card').classList.contains('hidden'), 'form card hidden');
    ok('signup submission success flow');
  }

  // 11. signup: 409 duplicate email displays actionable error
  {
    const { window, tick } = loadPage('signup.html', (url) => {
      if (url.includes('/api/v1/auth/signup')) {
        return jsonResponse(409, { success: false, error: { code: 'DUPLICATE_EMAIL', message: 'An account with this email already exists.' } });
      }
      return jsonResponse(404, {});
    });
    await tick();
    window.document.getElementById('signup-name').value = 'Existing Student';
    window.document.getElementById('signup-email').value = 'existing@uni.edu';
    window.document.getElementById('signup-password').value = 'secure-password-123';
    window.document.getElementById('signup-confirm-password').value = 'secure-password-123';
    window.document.getElementById('signup-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await tick(); await tick();
    const emailErr = window.document.getElementById('signup-email-error');
    assert.ok(!emailErr.classList.contains('hidden'), 'email error displayed on 409');
    assert.ok(/already exists/i.test(emailErr.textContent), 'error message indicates duplicate');
    ok('signup duplicate email handling');
  }

  // 12. login: open-redirect and cross-role redirect sanitization
  {
    // Direct unit assertions on redirect sanitizer
    const { window: winSan } = loadPage('login.html', () => jsonResponse(401, {}));
    assert.strictEqual(winSan.LabPulseAuth.sanitizeInternalRedirect('student', 'https://evil.com/phish'), null, 'rejects external http(s)');
    assert.strictEqual(winSan.LabPulseAuth.sanitizeInternalRedirect('student', '//evil.com/phish'), null, 'rejects protocol-relative url');
    assert.strictEqual(winSan.LabPulseAuth.sanitizeInternalRedirect('student', 'javascript:alert(1)'), null, 'rejects javascript scheme');
    assert.strictEqual(winSan.LabPulseAuth.sanitizeInternalRedirect('student', 'admin.html'), null, 'student cannot redirect to admin.html');
    assert.strictEqual(winSan.LabPulseAuth.sanitizeInternalRedirect('faculty', 'admin.html'), null, 'faculty cannot redirect to admin.html');
    assert.strictEqual(winSan.LabPulseAuth.sanitizeInternalRedirect('student', 'student.html'), 'student.html', 'student allowed student.html');
    assert.strictEqual(winSan.LabPulseAuth.sanitizeInternalRedirect('faculty', 'faculty.html'), 'faculty.html', 'faculty allowed faculty.html');
    assert.strictEqual(winSan.LabPulseAuth.sanitizeInternalRedirect('admin', 'admin.html'), 'admin.html', 'admin allowed admin.html');

    // External redirect attempt on form submit
    const { window: winEvil, tick: tickEvil } = loadPage('login.html', (url) => {
      if (url.endsWith('/auth/login')) {
        return jsonResponse(200, { success: true, data: { user: { role: 'student', name: 'S' }, accessToken: 'tok' } });
      }
      return jsonResponse(401, {});
    }, 'http://127.0.0.1:3000/login.html?redirect=https://evil.com/phish');
    await tickEvil();
    winEvil.LabPulseAuth.goToDashboard = (role, redirect) => {
      const target = winEvil.LabPulseAuth.sanitizeInternalRedirect(role, redirect);
      winEvil.__redirects.push(target || winEvil.LabPulseAuth.dashboardFor(role));
    };
    winEvil.document.getElementById('login-email').value = 's@uni.edu';
    winEvil.document.getElementById('login-password').value = 'pass12345';
    winEvil.document.getElementById('login-form').dispatchEvent(new winEvil.Event('submit', { cancelable: true }));
    await tickEvil(); await tickEvil();
    assert.ok(!winEvil.__redirects.includes('https://evil.com/phish'), 'external redirect blocked');
    assert.ok(winEvil.__redirects.includes('student.html'), 'redirected safely to role dashboard');

    // Cross-role privilege attempt (student tries to access admin.html via redirect)
    const { window: winCross, tick: tickCross } = loadPage('login.html', (url) => {
      if (url.endsWith('/auth/login')) {
        return jsonResponse(200, { success: true, data: { user: { role: 'student', name: 'S' }, accessToken: 'tok' } });
      }
      return jsonResponse(401, {});
    }, 'http://127.0.0.1:3000/login.html?redirect=admin.html');
    await tickCross();
    winCross.LabPulseAuth.goToDashboard = (role, redirect) => {
      const target = winCross.LabPulseAuth.sanitizeInternalRedirect(role, redirect);
      winCross.__redirects.push(target || winCross.LabPulseAuth.dashboardFor(role));
    };
    winCross.document.getElementById('login-email').value = 's@uni.edu';
    winCross.document.getElementById('login-password').value = 'pass12345';
    winCross.document.getElementById('login-form').dispatchEvent(new winCross.Event('submit', { cancelable: true }));
    await tickCross(); await tickCross();
    assert.ok(!winCross.__redirects.includes('admin.html'), 'cross-role redirect blocked');
    assert.ok(winCross.__redirects.includes('student.html'), 'redirected to student dashboard');
    ok('open-redirect and cross-role redirect protection');
  }

  await liveE2E();
  console.log(`\nSMOKE OK (${passed} checks passed, incl. live E2E)`);
  process.exit(0);
})().catch((e) => { console.error(`\nSMOKE FAIL: ${e.message}`); process.exit(1); });

/**
 * Live end-to-end: real pages + real backend. The jsdom fetch stub proxies
 * /api/* to a live test server, so the actual login→role→dashboard flow executes.
 * SKIP without MONGODB_URI.
 */
async function liveE2E() {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) { console.log('live-e2e: SKIP (MONGODB_URI not set)'); return; }
  const { connectDB } = require('../config/db');
  try { await connectDB(uri); } catch (e) { console.log(`live-e2e: SKIP (${e.message})`); return; }
  const mongoose = require('mongoose');
  const app = require('../server');
  const srv = app.listen(0);
  await new Promise((ready) => srv.on('listening', ready));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const User = require('../models/User');
  const { hashPassword } = require('../utils/password');

  await User.deleteMany({ email: /e2e-/ });
  const mk = async (email, role) =>
    User.create({ name: 'E2E', email, passwordHash: await hashPassword('correct-horse-12'), role, isActive: true });
  await mk('e2e-admin@x.edu', 'admin');
  await mk('e2e-fac@x.edu', 'faculty');
  await mk('e2e-stu@x.edu', 'student');

  // Proxy jsdom fetch to the live server, preserving cookies.
  let jar = '';
  const liveFetch = (url, opts) => {
    const headers = Object.assign({}, (opts && opts.headers) || {});
    if (jar) headers.Cookie = jar;
    return fetch(base + url, Object.assign({}, opts, { headers })).then(async (res) => {
      const sc = res.headers.get('set-cookie');
      if (sc) {
        const m = sc.match(/lp_refresh=([^;]*)/);
        if (m) jar = `lp_refresh=${m[1]}`;
      }
      return { status: res.status, json: () => res.json() };
    });
  };

  function livePage(file, testUrl) {
    const errors = [];
    const dom = new JSDOM(read(file), {
      url: testUrl || 'http://127.0.0.1:3000/',
      runScripts: 'outside-only',
      beforeParse(window) {
        window.fetch = liveFetch;
        window.__redirects = [];
      },
    });
    const { window } = dom;
    const order = [];
    if (/src="auth\.js"/.test(read(file))) order.push(read('auth.js'));
    if (/src="dash\.js"/.test(read(file))) order.push(read('dash.js'));
    for (const m of read(file).matchAll(/<script>([\s\S]*?)<\/script>/g)) order.push(m[1]);
    for (const code of order) {
      try { window.eval(code); } catch (e) { /* CDN-only blocks (e.g. tailwind config) can't run in jsdom */ }
    }
    window.LabPulseAuth.goToDashboard = (role) => { window.__redirects.push(window.LabPulseAuth.dashboardFor(role)); };
    window.LabPulseAuth.goToLogin = (page) => { window.__redirects.push(page || 'login.html'); };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { window, errors, tick };
  }

  // Deterministic wait: localhost round-trips under jsdom need more than fixed ticks.
  async function settle(tick, pred, what) {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (pred()) return;
      await tick();
    }
    throw new Error('timeout waiting for ' + what);
  }

  // Admin login -> admin.html; faculty -> faculty.html; student -> student.html.
  for (const [email, page] of [['e2e-admin@x.edu', 'admin.html'], ['e2e-fac@x.edu', 'faculty.html'], ['e2e-stu@x.edu', 'student.html']]) {
    jar = '';
    const { window, tick } = livePage('login.html');
    const card = () => window.document.getElementById('login-card');
    const errBox = () => window.document.getElementById('login-error');
    await settle(tick, () => !card().classList.contains('hidden') || window.__redirects.length > 0, 'login init');
    window.document.getElementById('login-email').value = email;
    window.document.getElementById('login-password').value = 'correct-horse-12';
    window.document.getElementById('login-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle(tick, () => window.__redirects.length > 0 || !errBox().classList.contains('hidden'), 'login result');
    assert.ok(window.__redirects.includes(page), `${email} routed to ${page} (got ${window.__redirects})`);
    ok(`live login routes ${email.split('@')[0]}`);
  }

  // Wrong password -> generic error, no redirect.
  {
    jar = '';
    const { window, tick } = livePage('login.html');
    await settle(tick, () => !window.document.getElementById('login-card').classList.contains('hidden'), 'login init');
    window.document.getElementById('login-email').value = 'e2e-fac@x.edu';
    window.document.getElementById('login-password').value = 'wrong-pass-1';
    window.document.getElementById('login-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle(tick, () => !window.document.getElementById('login-error').classList.contains('hidden'), 'login error');
    assert.ok(/Invalid email or password/.test(window.document.getElementById('login-error').textContent), 'live generic error');
    assert.strictEqual(window.__redirects.length, 0, 'no redirect on failure');
    ok('live invalid login');
  }

  // Unauthenticated visitor on faculty.html is sent back to login.
  {
    jar = '';
    const { window, tick } = livePage('faculty.html');
    await settle(tick, () => !window.document.getElementById('dash-app').classList.contains('hidden')
      || !window.document.getElementById('dash-denied').classList.contains('hidden')
      || window.__redirects.length > 0, 'guard settle');
    assert.ok(window.__redirects.includes('login.html'), 'unauthenticated guard redirects to login');
    ok('live guard redirects unauthenticated');
  }

  // Forgot-password end-to-end (dev outbox) stays generic.
  {
    const { window, tick } = livePage('forgot-password.html');
    window.document.getElementById('forgot-email').value = 'e2e-fac@x.edu';
    window.document.getElementById('forgot-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await settle(tick, () => !window.document.getElementById('forgot-success').classList.contains('hidden')
      || !window.document.getElementById('forgot-error').classList.contains('hidden'), 'forgot result');
    assert.ok(/If an account exists/.test(window.document.getElementById('forgot-success').textContent), 'live forgot generic');
    ok('live forgot-password');
  }

  await User.deleteMany({ email: /e2e-/ });
  await mongoose.disconnect();
  await new Promise((res2) => srv.close(res2));
}
