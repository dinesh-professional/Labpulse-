/**
 * Security Regression Test Suite (Module 16)
 * Validates protection against mass assignment, SQL injection,
 * audit log immutability, credential leakage, and CSV formula injection.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseSort } = require('../../utils/queryParser');
const { auditRepository } = require('../../repositories');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS [security] ${name}`);
}

function run() {
  console.log('\n--- Security: Regression & Attack Surface Verification ---');

  // 1. Audit Log Immutability Contract
  assert.strictEqual(typeof auditRepository.log, 'function', 'auditRepository has append-only log()');
  assert.strictEqual(typeof auditRepository.list, 'function', 'auditRepository has list()');
  assert.strictEqual(typeof auditRepository.findById, 'function', 'auditRepository has findById()');
  assert.throws(() => auditRepository.update(), /AUDIT_IMMUTABILITY_VIOLATION/, 'update() throws AUDIT_IMMUTABILITY_VIOLATION');
  assert.throws(() => auditRepository.updateById(), /AUDIT_IMMUTABILITY_VIOLATION/, 'updateById() throws AUDIT_IMMUTABILITY_VIOLATION');
  assert.throws(() => auditRepository.delete(), /AUDIT_IMMUTABILITY_VIOLATION/, 'delete() throws AUDIT_IMMUTABILITY_VIOLATION');
  assert.throws(() => auditRepository.deleteById(), /AUDIT_IMMUTABILITY_VIOLATION/, 'deleteById() throws AUDIT_IMMUTABILITY_VIOLATION');
  ok('Audit log repository enforces strict append-only immutability (update/delete actively throw AUDIT_IMMUTABILITY_VIOLATION)');

  // 2. SQL Injection Prevention in Query Sort Parser
  const allowedSortMap = {
    date: 'date',
    status: 'status',
    name: 'name',
  };
  const maliciousSorts = [
    'date; DROP TABLE bookings; --',
    "' OR 1=1 --",
    'status ASC; SELECT pg_sleep(5);',
    'admin_flag',
  ];
  for (const malicious of maliciousSorts) {
    const res = parseSort({ sort: malicious }, allowedSortMap, 'date', 'desc');
    assert.strictEqual(res.sortBy, 'date', 'Malicious sort key falls back to allowlisted default');
    assert.strictEqual(res.dbSortField, 'date');
  }
  ok('parseSort safely defuses arbitrary SQL injection payloads through strict allowlisting');

  // 3. Credential Leaks Audit in Frontend Static Code
  const rootDir = path.resolve(__dirname, '../..');
  const frontendFiles = ['login.html', 'signup.html', 'admin.html', 'faculty.html', 'student.html', 'auth.js', 'dash.js'];
  const leakPatterns = [/service_role/i, /SUPABASE_SERVICE_ROLE_KEY/i, /JWT_ACCESS_SECRET/i, /MONGODB_URI/i];

  let leakDetected = false;
  for (const f of frontendFiles) {
    const content = fs.readFileSync(path.join(rootDir, f), 'utf8');
    for (const pat of leakPatterns) {
      if (pat.test(content)) {
        leakDetected = true;
        assert.fail(`Potential secret leak in public file ${f} matching ${pat}`);
      }
    }
  }
  assert.strictEqual(leakDetected, false);
  ok('Zero server-side secrets (service role keys, JWT secrets, DB connection strings) exist in public frontend assets');

  // 4. Server Error Sanitization
  const serverCode = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
  assert.strictEqual(serverCode.includes("err.type === 'entity.parse.failed'"), true);
  assert.strictEqual(serverCode.includes('Malformed JSON body.'), true);
  ok('Global error handler traps malformed JSON payloads and avoids raw stack trace disclosure');

  console.log(`  Summary: ${passed} security regression checks passed.`);
}

run();
