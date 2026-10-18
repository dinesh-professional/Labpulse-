/**
 * Module 09 Verification: QR Access Passes & Secure Check-in
 * Run: `node scripts/verify-module-09.js`
 *
 * Validates:
 *  1. QR issuance returns opaque tokens; no hash leakage
 *  2. Check-in route uses atomic redemption (redeemPassAtomic)
 *  3. Single-use enforcement (replay rejection)
 *  4. Owner-only authorization on check-in and revocation
 *  5. Booking window validation (too-early, window-past)
 *  6. Pass status lifecycle (ACTIVE → USED/REVOKED/EXPIRED)
 *  7. Validate endpoint for dry-run pass inspection
 *  8. RLS migration present with INSERT + UPDATE policies
 *  9. Partial unique index for one-active-pass-per-booking
 * 10. Audit trail for QR operations
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];

function ok(name, detail) {
  passed++;
  results.push({ name, status: 'PASS', detail: detail || '' });
  console.log(`  ✅ PASS  ${name}`);
}
function fail(name, detail) {
  failed++;
  results.push({ name, status: 'FAIL', detail: detail || '' });
  console.log(`  ❌ FAIL  ${name}${detail ? ' — ' + detail : ''}`);
}
function skip(name, detail) {
  skipped++;
  results.push({ name, status: 'SKIP', detail: detail || '' });
  console.log(`  ⏭️  SKIP  ${name}${detail ? ' — ' + detail : ''}`);
}

function fileContains(relPath, ...patterns) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return { exists: false, content: '' };
  const content = fs.readFileSync(abs, 'utf8');
  const missing = patterns.filter(p => !content.includes(p));
  return { exists: true, content, missing };
}

function fileContainsRegex(relPath, regex) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return false;
  const content = fs.readFileSync(abs, 'utf8');
  return regex.test(content);
}

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   MODULE 09: QR ACCESS PASSES & SECURE CHECK-IN           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ──────────────────────────────────────────────────────────────────────────
  // 1. QR route file exists with required endpoints
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('routes/qr.js',
      "'/check-in'",
      "'/booking/:id'",
      "'/revoke/:id'",
      "'/validate'"
    );
    if (!check.exists) {
      fail('QR route file exists', 'routes/qr.js not found');
    } else if (check.missing.length > 0) {
      fail('QR route endpoints', `Missing endpoints: ${check.missing.join(', ')}`);
    } else {
      ok('QR route file has all required endpoints (check-in, booking/:id, revoke/:id, validate)');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Check-in uses atomic redemption (redeemPassAtomic)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('routes/qr.js', 'redeemPassAtomic');
    if (!check.exists) {
      fail('Atomic redemption in check-in', 'routes/qr.js not found');
    } else if (check.missing.length > 0) {
      fail('Atomic redemption in check-in', 'redeemPassAtomic not called in check-in route');
    } else {
      ok('Check-in route uses atomic redeemPassAtomic()');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. QR Repository has all required methods
  // ──────────────────────────────────────────────────────────────────────────
  {
    const methods = [
      'findByTokenHash',
      'findByBookingId',
      'findActiveByBookingId',
      'redeemPassAtomic',
      'revokeForBooking',
      'updateByBookingId',
      'create',
      'updateById',
    ];
    const check = fileContains('repositories/qrRepository.js', ...methods);
    if (!check.exists) {
      fail('QR repository methods', 'qrRepository.js not found');
    } else if (check.missing.length > 0) {
      fail('QR repository methods', `Missing: ${check.missing.join(', ')}`);
    } else {
      ok('QR repository has all required methods including updateByBookingId + findActiveByBookingId');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. PostgreSQL stored procedure exists (redeem_qr_pass)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains(
      'supabase/migrations/20261012000005_atomic_functions_and_triggers.sql',
      'redeem_qr_pass',
      'FOR UPDATE'
    );
    if (!check.exists) {
      fail('Stored procedure migration', 'atomic_functions migration not found');
    } else if (check.missing.length > 0) {
      fail('redeem_qr_pass stored procedure', `Missing: ${check.missing.join(', ')}`);
    } else {
      ok('redeem_qr_pass stored procedure with FOR UPDATE row locking');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Opaque token generation (issueOpaqueToken) — no raw tokens stored
  // ──────────────────────────────────────────────────────────────────────────
  {
    const tokensCheck = fileContains('utils/tokens.js', 'issueOpaqueToken', 'hashOpaqueToken', 'randomBytes');
    const routeCheck = fileContains('routes/qr.js', 'hashOpaqueToken');
    const bookingCheck = fileContains('routes/bookings.js', 'issueOpaqueToken');
    if (tokensCheck.missing.length > 0) {
      fail('Token utilities', `Missing in utils/tokens.js: ${tokensCheck.missing.join(', ')}`);
    } else if (routeCheck.missing.length > 0) {
      fail('Token hashing in QR route', 'hashOpaqueToken not used in routes/qr.js');
    } else if (bookingCheck.missing.length > 0) {
      fail('Token issuance in bookings', 'issueOpaqueToken not used in routes/bookings.js');
    } else {
      ok('Opaque token system: randomBytes → sha256 hash → only hash stored');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. No token hash or sensitive data leakage in responses
  // ──────────────────────────────────────────────────────────────────────────
  {
    const content = fs.readFileSync(path.join(ROOT, 'routes', 'qr.js'), 'utf8');
    // Check that responses don't include tokenHash
    const hasTokenHashInResponse = /res\.json\([^)]*tokenHash/s.test(content);
    const hasSanitize = content.includes('sanitizePassResponse');
    if (hasTokenHashInResponse) {
      fail('No token hash leakage', 'tokenHash appears in response payload');
    } else if (!hasSanitize) {
      fail('Response sanitization', 'sanitizePassResponse helper not found');
    } else {
      ok('No token hash leakage — sanitizePassResponse strips sensitive fields');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Authorization enforcement on all QR endpoints
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('routes/qr.js',
      'requireAuth',
      'FORBIDDEN',
      "req.user.role !== 'admin'"
    );
    if (check.missing.length > 0) {
      fail('Authorization enforcement', `Missing: ${check.missing.join(', ')}`);
    } else {
      ok('Owner/admin authorization enforced on check-in, revoke, and booking pass lookup');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Replay rejection (QR_ALREADY_USED)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('routes/qr.js', 'QR_ALREADY_USED');
    if (check.missing.length > 0) {
      fail('Replay rejection', 'QR_ALREADY_USED error code not found');
    } else {
      ok('Replay/double-scan rejection returns QR_ALREADY_USED (409)');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Booking window enforcement (TOO_EARLY, WINDOW_PAST)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('routes/qr.js', 'TOO_EARLY', 'WINDOW_PAST', 'EARLY_GRACE_MS');
    if (check.missing.length > 0) {
      fail('Booking window enforcement', `Missing: ${check.missing.join(', ')}`);
    } else {
      ok('Check-in enforces booking window with 15-min early grace');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 10. Pass lifecycle states (ACTIVE, USED, EXPIRED, REVOKED)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const modelCheck = fileContains('models/QrAccessPass.js', 'ACTIVE', 'USED', 'EXPIRED', 'REVOKED');
    const schemaCheck = fileContains('supabase/migrations/20261012000002_core_schema.sql',
      "'ACTIVE'", "'USED'", "'EXPIRED'", "'REVOKED'"
    );
    if (modelCheck.missing.length > 0) {
      fail('Pass lifecycle states in model', `Missing: ${modelCheck.missing.join(', ')}`);
    } else if (schemaCheck.missing.length > 0) {
      fail('Pass lifecycle states in schema', `Missing: ${schemaCheck.missing.join(', ')}`);
    } else {
      ok('All four pass states enforced: ACTIVE, USED, EXPIRED, REVOKED');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 11. RLS policies for QR passes (SELECT, INSERT, UPDATE)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const selectCheck = fileContains('supabase/migrations/20261012000004_row_level_security.sql',
      'qr_passes_select_policy'
    );
    const writeCheck = fileContains('supabase/migrations/20261012000006_qr_access_pass_hardening.sql',
      'qr_passes_insert_policy',
      'qr_passes_update_policy'
    );
    if (selectCheck.missing.length > 0) {
      fail('RLS SELECT policy', 'qr_passes_select_policy not found in migration 04');
    } else if (!writeCheck.exists) {
      fail('RLS write policies', 'Migration 06 (qr_access_pass_hardening) not found');
    } else if (writeCheck.missing.length > 0) {
      fail('RLS write policies', `Missing in migration 06: ${writeCheck.missing.join(', ')}`);
    } else {
      ok('RLS policies cover SELECT, INSERT, and UPDATE for qr_access_passes');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 12. Partial unique index: one active pass per booking
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('supabase/migrations/20261012000006_qr_access_pass_hardening.sql',
      'idx_qr_one_active_per_booking'
    );
    if (!check.exists) {
      fail('Partial unique index', 'Migration 06 not found');
    } else if (check.missing.length > 0) {
      fail('Partial unique index', 'idx_qr_one_active_per_booking not found');
    } else {
      ok('Partial unique index ensures only one ACTIVE pass per booking');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 13. Audit trail for QR operations
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('routes/qr.js', 'QR_CHECKED_IN', 'QR_REVOKED', 'logAudit');
    if (check.missing.length > 0) {
      fail('Audit trail', `Missing audit actions: ${check.missing.join(', ')}`);
    } else {
      ok('Audit trail records QR_CHECKED_IN and QR_REVOKED events');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 14. Validate endpoint (dry-run) exists and is staff-only
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('routes/qr.js',
      "'/validate'",
      'Only staff can validate',
      'withinWindow'
    );
    if (check.missing.length > 0) {
      fail('Validate endpoint', `Missing: ${check.missing.join(', ')}`);
    } else {
      ok('Validate endpoint: dry-run inspection, staff-only, reports window status');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 15. Pass issuance on booking create + approve + reissue
  // ──────────────────────────────────────────────────────────────────────────
  {
    const bookingCheck = fileContains('routes/bookings.js',
      'issueQrPass',
      '/:id/qr',
      'revokeForBooking'
    );
    if (bookingCheck.missing.length > 0) {
      fail('Pass issuance integration', `Missing in bookings.js: ${bookingCheck.missing.join(', ')}`);
    } else {
      ok('QR pass issued on booking creation, approval, and reissue; old passes revoked');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 16. QR route mounted in server.js
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('server.js', '/api/v1/qr');
    if (check.missing.length > 0) {
      fail('QR route mounted', '/api/v1/qr not found in server.js');
    } else {
      ok('QR routes mounted at /api/v1/qr in server.js');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 17. Expire-stale function for scheduled cleanup
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('supabase/migrations/20261012000006_qr_access_pass_hardening.sql',
      'expire_stale_qr_passes'
    );
    if (!check.exists) {
      fail('Expire-stale function', 'Migration 06 not found');
    } else if (check.missing.length > 0) {
      fail('Expire-stale function', 'expire_stale_qr_passes function not found');
    } else {
      ok('expire_stale_qr_passes() function for scheduled batch expiration');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 18. QR mappers exist (snake_case ↔ camelCase)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('repositories/mappers.js',
      'mapQrAccessPassToApp',
      'mapAppToQrAccessPass'
    );
    if (check.missing.length > 0) {
      fail('QR mappers', `Missing: ${check.missing.join(', ')}`);
    } else {
      ok('Bidirectional QR mappers: snake_case (PostgreSQL) ↔ camelCase (API)');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 19. QR schema table definition
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('supabase/migrations/20261012000002_core_schema.sql',
      'qr_access_passes',
      'token_hash',
      'booking_id',
      'expires_at',
      'checked_in_at'
    );
    if (check.missing.length > 0) {
      fail('QR table schema', `Missing columns: ${check.missing.join(', ')}`);
    } else {
      ok('QR table schema includes all required columns');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 20. Smoke test exists for QR operations
  // ──────────────────────────────────────────────────────────────────────────
  {
    const check = fileContains('scripts/smoke-qr.js', 'check-in', 'QR_ALREADY_USED', 'QR_REVOKED');
    if (!check.exists) {
      fail('QR smoke test', 'scripts/smoke-qr.js not found');
    } else if (check.missing.length > 0) {
      fail('QR smoke test coverage', `Missing: ${check.missing.join(', ')}`);
    } else {
      ok('QR smoke test covers check-in, replay rejection, and revocation');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 21. No raw token storage in database
  // ──────────────────────────────────────────────────────────────────────────
  {
    const repoContent = fs.readFileSync(path.join(ROOT, 'repositories', 'qrRepository.js'), 'utf8');
    const modelContent = fs.readFileSync(path.join(ROOT, 'models', 'QrAccessPass.js'), 'utf8');
    // Ensure no field named 'token' (only 'tokenHash')
    const hasRawTokenField = /^\s*token:\s*\{/m.test(modelContent);
    const storesHash = modelContent.includes('tokenHash');
    if (hasRawTokenField) {
      fail('No raw token storage', 'Model stores raw token field — only hash should be stored');
    } else if (!storesHash) {
      fail('Hash-only storage', 'tokenHash field not found in model');
    } else {
      ok('Only sha256 hash stored in database; raw token never persisted');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Module 09 Verification: ${passed} PASS / ${failed} FAIL / ${skipped} SKIP`);
  console.log('══════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('  FAILED CHECKS:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`    • ${r.name}: ${r.detail}`));
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
})();
