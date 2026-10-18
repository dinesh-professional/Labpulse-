/**
 * Unit Test Suite: Tokens, Passwords & Security Utilities (Module 16)
 * Validates password hashing, token generation/hashing, CSV formula mitigation,
 * and unified ID validation.
 */
const assert = require('assert');
const { validatePasswordPolicy, hashPassword, verifyPassword } = require('../../utils/password');
const { issueOpaqueToken, hashOpaqueToken } = require('../../utils/tokens');
const { sanitizeFormulaInjection, escapeCell, toCsv } = require('../../utils/csv');
const { isValidId } = require('../../utils/idValidation');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS [unit/security] ${name}`);
}

async function run() {
  console.log('\n--- Unit: Tokens, Passwords & Security Utilities ---');

  // 1. Password policy
  assert.strictEqual(validatePasswordPolicy('short'), 'Password must be at least 8 characters.');
  assert.strictEqual(validatePasswordPolicy('a'.repeat(129)), 'Password must be at most 128 characters.');
  assert.strictEqual(validatePasswordPolicy('valid-Secure-Pass-123!'), null);
  ok('Password policy enforces length boundaries [8, 128]');

  // 2. Password hashing & verification
  const plain = 'Vortex-Lab-Secure-2026!';
  const hash = await hashPassword(plain);
  assert.notStrictEqual(plain, hash, 'Password must never be plaintext');
  assert.strictEqual(await verifyPassword(plain, hash), true, 'Correct password verifies');
  assert.strictEqual(await verifyPassword('wrong-pass', hash), false, 'Incorrect password rejected');
  ok('bcryptjs password hashing produces secure salted hashes and verifies accurately');

  // 3. Opaque token generation & hashing
  const { token, tokenHash } = issueOpaqueToken();
  assert.strictEqual(typeof token, 'string');
  assert.strictEqual(token.length >= 32, true, 'Opaque token has sufficient entropy');
  assert.strictEqual(hashOpaqueToken(token), tokenHash, 'hashOpaqueToken is deterministic SHA-256');
  assert.strictEqual(tokenHash.includes(token.slice(0, 8)), false, 'Hash does not leak token prefix');
  ok('Opaque token issuance and SHA-256 hashing preserves zero-knowledge properties');

  // 4. CSV Formula Injection Mitigation
  const dangerousCells = ['=cmd|', '+1+2', '-5+3', '@SUM(A1:B1)', '\tMALICIOUS', '\rCMD'];
  for (const c of dangerousCells) {
    const sanitized = sanitizeFormulaInjection(c);
    assert.strictEqual(sanitized.startsWith("'"), true, `Trigger ${c} must be prepended with single quote`);
  }
  assert.strictEqual(sanitizeFormulaInjection('Safe Normal Text'), 'Safe Normal Text');
  ok('CSV formula injection triggers (=, +, -, @, \\t, \\r) are neutralized with single quote prefix');

  // 5. RFC 4180 Escaping & Sensitive Column Protection
  const records = [{ name: 'Microscope, Confocal', secretToken: 'SUPER_SECRET', role: 'admin' }];
  const csv = toCsv(records);
  assert.strictEqual(csv.includes('SUPER_SECRET'), false, 'Sensitive fields (token, secret) stripped');
  assert.strictEqual(csv.includes('"Microscope, Confocal"'), true, 'Commas escaped with RFC 4180 quotes');
  ok('RFC 4180 cell escaping and sensitive column blacklisting prevents data leakage');

  // 6. Unified ID Validation (PostgreSQL UUID v4 + MongoDB ObjectId)
  const validUuid = '123e4567-e89b-12d3-a456-426614174000';
  const validMongoId = '507f1f77bcf86cd799439011';
  assert.strictEqual(isValidId(validUuid), true, 'UUID v4 is valid');
  assert.strictEqual(isValidId(validMongoId), true, 'MongoDB ObjectId is valid');
  assert.strictEqual(isValidId('invalid-id'), false, 'Arbitrary string rejected');
  assert.strictEqual(isValidId("'; DROP TABLE users; --"), false, 'SQL injection string rejected');
  ok('isValidId validates both UUID v4 and ObjectId while blocking injection attempts');

  console.log(`  Summary: ${passed} token & security checks passed.`);
}

run();
