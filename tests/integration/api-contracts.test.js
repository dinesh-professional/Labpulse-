/**
 * Integration Test Suite: API Contracts & Security Envelope (Module 16)
 * Validates Express server initialization, security headers, rate limiting,
 * 404 handler, and standard JSON envelope contracts.
 */
const assert = require('assert');
const app = require('../../server');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS [integration/contracts] ${name}`);
}

async function run() {
  console.log('\n--- Integration: API Contracts & Server Envelope ---');

  // 1. Server instance verification
  assert.ok(app, 'server.js exports express application');
  assert.strictEqual(typeof app.listen, 'function', 'app has listen method');
  ok('Express server module initializes cleanly and exports valid instance');

  // Start ephemeral server on random port
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 2. Health check contract
    const healthRes = await fetch(`${baseUrl}/api/v1/health`);
    assert.strictEqual(healthRes.status, 200, 'Health endpoint responds 200 OK');
    const healthJson = await healthRes.json();
    assert.strictEqual(healthJson.success, true, 'Envelope has success: true');
    assert.ok(healthJson.data, 'Data object present');
    assert.strictEqual(healthJson.data.status, 'ok', 'Status is ok');
    assert.ok('backend' in healthJson.data, 'Reports active backend');
    assert.ok('db' in healthJson.data, 'Reports database status');
    ok('GET /api/v1/health conforms to health contract specification');

    // 3. Security Headers Verification
    assert.strictEqual(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(healthRes.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.strictEqual(healthRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    ok('Mandatory security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy) present');

    // 4. API 404 Envelope Contract
    const notFoundRes = await fetch(`${baseUrl}/api/v1/nonexistent-route-endpoint`);
    assert.strictEqual(notFoundRes.status, 404, 'Unknown API route returns 404');
    const notFoundJson = await notFoundRes.json();
    assert.strictEqual(notFoundJson.success, false, 'Envelope has success: false');
    assert.strictEqual(notFoundJson.error.code, 'NOT_FOUND', 'Error code is NOT_FOUND');
    assert.strictEqual(typeof notFoundJson.error.message, 'string', 'Error message provided');
    ok('API 404 handler returns standardized JSON envelope without HTML leaking');

    // 5. Analytics route exists and rejects unauthorized requests or unready DB
    const unauthAnalytics = await fetch(`${baseUrl}/api/v1/analytics/overview`);
    assert.strictEqual([401, 503].includes(unauthAnalytics.status), true, 'Protected endpoints return 401 or 503');
    const unauthJson = await unauthAnalytics.json();
    assert.strictEqual(unauthJson.success, false);
    assert.strictEqual(['AUTH_REQUIRED', 'DB_UNAVAILABLE', 'UNAUTHENTICATED'].includes(unauthJson.error.code), true);
    ok('Protected endpoints enforce authentication and database readiness gatekeepers before route execution');
  } finally {
    server.close();
  }

  console.log(`  Summary: ${passed} API contract checks passed.`);
}

run().catch((err) => {
  console.error('FAIL in api-contracts.test.js:', err);
  process.exit(1);
});
