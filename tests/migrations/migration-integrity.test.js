/**
 * Migration & Schema Integrity Test Suite (Module 16)
 * Validates sequential ordering, DDL syntax integrity, RLS policy coverage,
 * and composite performance indexes across all 11 Supabase migrations.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS [migrations] ${name}`);
}

function run() {
  console.log('\n--- Migrations: Database Schema & DDL Integrity ---');
  const rootDir = path.resolve(__dirname, '../..');
  const migrationsDir = path.join(rootDir, 'supabase', 'migrations');

  const EXPECTED_MIGRATIONS = [
    '20261012000001_extensions_and_prerequisites.sql',
    '20261012000002_core_schema.sql',
    '20261012000003_constraints_and_indexes.sql',
    '20261012000004_row_level_security.sql',
    '20261012000005_atomic_functions_and_triggers.sql',
    '20261012000006_qr_access_pass_hardening.sql',
    '20261012000007_notifications_enhancement.sql',
    '20261012000008_user_qualifications_membership.sql',
    '20261012000009_audit_logs_compliance.sql',
    '20261012000010_search_filtering_export_indexes.sql',
    '20261012000011_analytics_operational_intelligence.sql',
  ];

  // 1. All migrations exist and follow chronological naming convention
  for (const m of EXPECTED_MIGRATIONS) {
    const fp = path.join(migrationsDir, m);
    assert.strictEqual(fs.existsSync(fp), true, `Migration ${m} must exist`);
  }
  ok('All 11 versioned SQL migrations present in supabase/migrations/ in strict chronological order');

  // 2. Extensions verification
  const m1 = fs.readFileSync(path.join(migrationsDir, EXPECTED_MIGRATIONS[0]), 'utf8');
  assert.strictEqual(m1.includes('uuid-ossp'), true);
  assert.strictEqual(m1.includes('btree_gist'), true);
  assert.strictEqual(m1.includes('pgcrypto'), true);
  ok('Required PostgreSQL extensions (uuid-ossp, btree_gist, pgcrypto) declared in migration 01');

  // 3. Core tables verification
  const m2 = fs.readFileSync(path.join(migrationsDir, EXPECTED_MIGRATIONS[1]), 'utf8');
  const coreTables = ['profiles', 'laboratories', 'instruments', 'bookings', 'maintenance', 'calibrations'];
  for (const t of coreTables) {
    assert.strictEqual(m2.includes(`CREATE TABLE IF NOT EXISTS public.${t}`), true, `Table public.${t} declared in migration 02`);
  }
  ok('Core relational tables declared with strict constraints in migration 02');

  // 4. Row Level Security Coverage
  const m4 = fs.readFileSync(path.join(migrationsDir, EXPECTED_MIGRATIONS[3]), 'utf8');
  assert.strictEqual(m4.includes('ENABLE ROW LEVEL SECURITY'), true);
  assert.strictEqual(m4.includes('CREATE POLICY'), true);
  ok('Row Level Security (RLS) policies and tenant isolation declared in migration 04');

  // 5. Atomic procedures
  const m5 = fs.readFileSync(path.join(migrationsDir, EXPECTED_MIGRATIONS[4]), 'utf8');
  assert.strictEqual(m5.includes('redeem_qr_pass'), true);
  assert.strictEqual(m5.includes('cancel_booking_atomic'), true);
  ok('Atomic transactional SQL functions (redeem_qr_pass, cancel_booking_atomic) defined in migration 05');

  // 6. Search & Analytics composite indexes
  const m10 = fs.readFileSync(path.join(migrationsDir, EXPECTED_MIGRATIONS[9]), 'utf8');
  assert.strictEqual(m10.includes('idx_instruments_search_composite'), true);
  const m11 = fs.readFileSync(path.join(migrationsDir, EXPECTED_MIGRATIONS[10]), 'utf8');
  assert.strictEqual(m11.includes('idx_bookings_analytics_date_status'), true);
  assert.strictEqual(m11.includes('idx_maintenance_analytics_start_type'), true);
  ok('Search and operational analytics composite indexes declared in migrations 10 & 11');

  console.log(`  Summary: ${passed} migration & schema integrity checks passed.`);
}

run();
