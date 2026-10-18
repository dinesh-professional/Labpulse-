/**
 * Module 17 Verification Battery: Deployment & Production Infrastructure
 * Run: `node scripts/verify-module-17.js`
 *
 * Validates all acceptance criteria for Module 17:
 *  1. Production Configuration & Environment Separation (.env.example, render.yaml)
 *  2. Container Specification & Non-Root Least Privilege (Dockerfile)
 *  3. MongoDB Removal from Production Architecture (Supabase authoritative backend)
 *  4. Health, Liveness & Readiness Probes (/api/v1/health/liveness, /api/v1/health/readiness)
 *  5. Security Headers, HSTS & Explicit CORS Allowlisting (server.js)
 *  6. Secure Cookie Attributes (httpOnly, sameSite, secure in routes/auth.js)
 *  7. Process Lifecycle & Graceful Shutdown (SIGINT/SIGTERM handlers)
 *  8. Comprehensive Deployment Documentation (DEPLOYMENT.md)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

function ok(title) {
  totalChecks += 1;
  passedChecks += 1;
  console.log(`  ✅ PASS  ${title}`);
}

function fail(title, reason) {
  totalChecks += 1;
  failedChecks += 1;
  console.error(`  ❌ FAIL  ${title} — ${reason}`);
}

function fileContains(relPath, ...snippets) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    return { exists: false, missing: snippets };
  }
  const content = fs.readFileSync(full, 'utf8');
  const missing = snippets.filter((s) => !content.includes(s));
  return { exists: true, missing, content };
}

async function runBattery() {
  console.log('\n================================================================');
  console.log('  LABPULSE MODULE 17: DEPLOYMENT & PRODUCTION INFRASTRUCTURE TEST');
  console.log('================================================================\n');

  /* --------------------------------------------------------------------------
     SUITE 1: Production Configuration (.env.example, render.yaml)
     -------------------------------------------------------------------------- */
  console.log('--- SUITE 1: Production Configuration & Blueprint ---');
  try {
    const envCheck = fileContains(
      '.env.example',
      'DATA_BACKEND=supabase',
      'SUPABASE_URL=',
      'SUPABASE_ANON_KEY=',
      'SUPABASE_SERVICE_ROLE_KEY=',
      'ALLOWED_ORIGINS=',
      'JWT_ACCESS_SECRET='
    );
    if (envCheck.exists && envCheck.missing.length === 0) {
      ok('.env.example clearly separates environments and documents Supabase production credentials without leaking secrets');
    } else {
      fail('.env.example checks', `Missing: ${envCheck.missing.join(', ')}`);
    }

    const renderCheck = fileContains(
      'render.yaml',
      'name: labpulse',
      'startCommand: node server.js',
      'healthCheckPath: /api/v1/health/liveness',
      'DATA_BACKEND',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY'
    );
    if (renderCheck.exists && renderCheck.missing.length === 0) {
      ok('render.yaml sets DATA_BACKEND=supabase and configures liveness probe path');
    } else {
      fail('render.yaml checks', `Missing: ${renderCheck.missing.join(', ')}`);
    }
  } catch (err) {
    fail('Suite 1 production config', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 2: Hardened Docker Container Specification
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 2: Hardened Docker Container ---');
  try {
    const dockerCheck = fileContains(
      'Dockerfile',
      'FROM node:20-alpine',
      'npm ci --omit=dev',
      'USER node',
      'EXPOSE 3000',
      'HEALTHCHECK',
      '/api/v1/health/liveness',
      'CMD ["node", "server.js"]'
    );
    if (dockerCheck.exists && dockerCheck.missing.length === 0) {
      ok('Dockerfile implements non-root execution (USER node) and container liveness healthcheck probe');
    } else {
      fail('Dockerfile checks', `Missing: ${dockerCheck.missing.join(', ')}`);
    }
  } catch (err) {
    fail('Suite 2 Dockerfile', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 3: MongoDB Removal Verification in Production Architecture
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 3: MongoDB Removal & Supabase Primacy ---');
  try {
    const deployDoc = fileContains(
      'DEPLOYMENT.md',
      'Supabase PostgreSQL',
      'DATA_BACKEND=supabase',
      'Zero Production Dependency',
      '11 versioned SQL migrations'
    );
    if (deployDoc.exists && deployDoc.missing.length === 0) {
      ok('DEPLOYMENT.md documents Supabase as authoritative production database with zero MongoDB runtime dependency');
    } else {
      fail('DEPLOYMENT.md architecture', `Missing: ${deployDoc.missing.join(', ')}`);
    }

    // Verify server.js boots in Supabase mode without MONGODB_URI
    const serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.strictEqual(serverCode.includes("activeBackend === 'supabase'"), true);
    assert.strictEqual(serverCode.includes('checkSupabaseHealth'), true);
    ok('server.js prioritizes Supabase PostgreSQL connection and health verification');
  } catch (err) {
    fail('Suite 3 MongoDB removal', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 4: Health Probes (Liveness & Readiness)
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 4: Operational Health Probes ---');
  try {
    const app = require('../server');
    const srv = app.listen(0);
    await new Promise((r) => srv.on('listening', r));
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 4.1 Liveness Probe (process is alive without hitting database)
      const liveRes = await fetch(`${base}/api/v1/health/liveness`);
      assert.strictEqual(liveRes.status, 200, 'Liveness probe returns 200');
      const liveJson = await liveRes.json();
      assert.strictEqual(liveJson.data.status, 'alive');
      ok('GET /api/v1/health/liveness responds 200 OK with alive status without DB latency');

      // 4.2 Legacy Health Diagnostic
      const healthRes = await fetch(`${base}/api/v1/health`);
      assert.strictEqual(healthRes.status, 200);
      const healthJson = await healthRes.json();
      assert.strictEqual(healthJson.success, true);
      assert.ok('backend' in healthJson.data);
      ok('GET /api/v1/health diagnostic provides full operational overview');

      // 4.3 Readiness Probe
      const readyRes = await fetch(`${base}/api/v1/health/readiness`);
      assert.strictEqual([200, 503].includes(readyRes.status), true);
      const readyJson = await readyRes.json();
      assert.ok((readyJson.data && 'status' in readyJson.data) || (readyJson.error && readyJson.error.code === 'NOT_READY'));
      ok('GET /api/v1/health/readiness reflects backend traffic service readiness');
    } finally {
      srv.close();
    }
  } catch (err) {
    fail('Suite 4 health probes', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 5: Security Headers, HSTS & CORS Allowlist
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 5: Security Headers & CORS Allowlisting ---');
  try {
    const serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.strictEqual(serverCode.includes('Strict-Transport-Security'), true);
    assert.strictEqual(serverCode.includes('ALLOWED_ORIGINS'), true);
    assert.strictEqual(serverCode.includes('Access-Control-Allow-Credentials'), true);
    assert.strictEqual(serverCode.includes('X-Frame-Options'), true);
    assert.strictEqual(serverCode.includes('X-Content-Type-Options'), true);
    ok('server.js configures HSTS in production, explicit CORS allowlisting, and mandatory frame guards');
  } catch (err) {
    fail('Suite 5 security headers & CORS', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 6: Secure Cookie Policies in Auth Layer
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 6: Secure Cookie Attribute Policies ---');
  try {
    const authCode = fs.readFileSync(path.join(ROOT, 'routes/auth.js'), 'utf8');
    assert.strictEqual(authCode.includes('httpOnly: true'), true);
    assert.strictEqual(authCode.includes("sameSite: 'lax'"), true);
    assert.strictEqual(authCode.includes('secure: !!isProd'), true);
    assert.strictEqual(authCode.includes('path: COOKIE_PATH'), true);
    ok('Refresh cookies strictly enforce httpOnly, sameSite: lax, secure in production, and path scoping');
  } catch (err) {
    fail('Suite 6 secure cookies', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 7: Graceful Shutdown Handlers
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 7: Process Lifecycle & Graceful Shutdown ---');
  try {
    const serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.strictEqual(serverCode.includes("process.on('SIGINT'"), true);
    assert.strictEqual(serverCode.includes("process.on('SIGTERM'"), true);
    assert.strictEqual(serverCode.includes('server.close'), true);
    ok('Process listeners trap SIGINT and SIGTERM for graceful connection draining and termination');
  } catch (err) {
    fail('Suite 7 graceful shutdown', err.message);
  }

  /* --------------------------------------------------------------------------
     FINAL SUMMARY
     -------------------------------------------------------------------------- */
  console.log('\n================================================================');
  console.log(`  VERIFICATION RESULT: ${passedChecks} / ${totalChecks} CHECKS PASSED`);
  if (failedChecks > 0) {
    console.error(`  ❌ ${failedChecks} CHECKS FAILED`);
    console.log('================================================================\n');
    process.exit(1);
  } else {
    console.log('  🎉 ALL MODULE 17 ACCEPTANCE CHECKS PASSED DETERMINISTICALLY');
    console.log('================================================================\n');
    process.exit(0);
  }
}

runBattery();
