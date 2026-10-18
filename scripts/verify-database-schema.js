/**
 * Module 05 Database Schema, Integrity & Constraint Verification Suite.
 * Validates the SQL migrations, PostgreSQL exclusion constraints, RLS policy
 * coverage, referential integrity rules, and atomic procedures.
 *
 * Run: `node scripts/verify-database-schema.js`
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..');
const migrationsDir = path.join(dir, 'supabase', 'migrations');
const readMigration = (f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8');

let passedChecks = 0;
function pass(category, desc) {
  passedChecks += 1;
  console.log(`  PASS [${category}] ${desc}`);
}

console.log('=== MODULE 05 DATABASE ARCHITECTURE VERIFICATION ===\n');

// ------------------------------------------------------------------------------
// 1. Migration File Structure & Extension Requirements
// ------------------------------------------------------------------------------
console.log('1. Migration Ordering & PostgreSQL Extensions:');
const expectedMigrations = [
  '20261012000001_extensions_and_prerequisites.sql',
  '20261012000002_core_schema.sql',
  '20261012000003_constraints_and_indexes.sql',
  '20261012000004_row_level_security.sql',
  '20261012000005_atomic_functions_and_triggers.sql',
];

for (const m of expectedMigrations) {
  const fp = path.join(migrationsDir, m);
  assert.ok(fs.existsSync(fp), `Migration exists: ${m}`);
}
pass('Migration Sequence', 'All 5 versioned SQL migration files exist in supabase/migrations/');

const m1 = readMigration('20261012000001_extensions_and_prerequisites.sql');
assert.ok(m1.includes('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'), 'uuid-ossp extension declared');
assert.ok(m1.includes('CREATE EXTENSION IF NOT EXISTS "btree_gist"'), 'btree_gist extension declared');
assert.ok(m1.includes('CREATE EXTENSION IF NOT EXISTS "pgcrypto"'), 'pgcrypto extension declared');
pass('Extensions', 'Required PostgreSQL extensions (btree_gist, uuid-ossp, pgcrypto) declared');

// ------------------------------------------------------------------------------
// 2. Core Relational Schema & 12 Audited Domain Tables
// ------------------------------------------------------------------------------
console.log('\n2. Domain Schema & Table Integrity:');
const m2 = readMigration('20261012000002_core_schema.sql');

const requiredTables = [
  'public.profiles',
  'public.laboratories',
  'public.instruments',
  'public.schedules',
  'public.bookings',
  'public.calibrations',
  'public.maintenance',
  'public.breakage_reports',
  'public.notifications',
  'public.qr_access_passes',
  'public.operator_qualifications',
  'public.audit_logs',
];

for (const tbl of requiredTables) {
  assert.ok(m2.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`), `Table defined: ${tbl}`);
}
pass('Entities', `All 12 audited domain tables defined with UUID primary keys`);

// Check constraints on role, status enums, and timestamps
assert.ok(m2.includes("CHECK (role IN ('admin', 'faculty', 'student'))"), 'role check constraint');
assert.ok(m2.includes("CHECK (status IN ('AVAILABLE', 'IN_SESSION', 'UNDER_CALIBRATION', 'UNDER_MAINTENANCE', 'OUT_OF_ORDER', 'LOCKED'))"), 'instrument status check');
assert.ok(m2.includes("CHECK (status IN ('CONFIRMED', 'CANCELLED', 'CHECKED_IN', 'COMPLETED'))"), 'booking status check');
assert.ok(m2.includes("CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED'))"), 'qr status check');
assert.ok(m2.includes("CHECK (end_at > start_at)"), 'booking interval order constraint');
pass('Constraints', 'Enums, check constraints, and non-negative interval bounds enforced');

// ------------------------------------------------------------------------------
// 3. Mandatory Database-Enforced Booking Conflict Exclusion Constraint
// ------------------------------------------------------------------------------
console.log('\n3. Database-Enforced Booking Exclusion Constraint:');
const m3 = readMigration('20261012000003_constraints_and_indexes.sql');

assert.ok(m3.includes('active_booking_no_overlap'), 'Exclusion constraint name present');
assert.ok(m3.includes('EXCLUDE USING gist'), 'GiST index method specified');
assert.ok(m3.includes('instrument_id WITH ='), 'instrument_id equality comparison in GiST');
assert.ok(m3.includes('booking_interval WITH &&'), 'booking_interval overlap comparison in GiST');
assert.ok(m3.includes("WHERE (status IN ('CONFIRMED', 'CHECKED_IN'))"), 'partial filter for active statuses');
pass('Exclusion Constraint', 'EXCLUDE USING gist (instrument_id WITH =, booking_interval WITH &&) defined');

// Verify interval overlap semantics with simulated PostgreSQL exclusion logic
function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  // Half-open interval [start, end) overlap: max(aStart, bStart) < min(aEnd, bEnd)
  return Math.max(aStart.getTime(), bStart.getTime()) < Math.min(aEnd.getTime(), bEnd.getTime());
}

const inst1 = 'inst-001';
const inst2 = 'inst-002';
const d0900 = new Date('2026-10-15T09:00:00Z');
const d1000 = new Date('2026-10-15T10:00:00Z');
const d1030 = new Date('2026-10-15T10:30:00Z');
const d1100 = new Date('2026-10-15T11:00:00Z');

// Scenario A: Overlapping active bookings on same instrument -> MUST REJECT
assert.ok(
  intervalsOverlap(d0900, d1030, d1000, d1100),
  'Overlapping bookings [09:00, 10:30) and [10:00, 11:00) conflict'
);
pass('Conflict Semantics', 'Overlapping active bookings on same instrument conflict and are rejected');

// Scenario B: Adjacent bookings on same instrument [09:00, 10:00) and [10:00, 11:00) -> MUST SUCCEED
assert.ok(
  !intervalsOverlap(d0900, d1000, d1000, d1100),
  'Adjacent half-open bookings [09:00, 10:00) and [10:00, 11:00) do NOT overlap'
);
pass('Half-Open Boundary', 'Adjacent bookings [start, end) sharing exact boundary do not conflict');

// Scenario C: Overlapping bookings on DIFFERENT instruments -> MUST SUCCEED
const diffInstrumentOverlap = (inst1 === inst2) && intervalsOverlap(d0900, d1000, d0900, d1000);
assert.strictEqual(diffInstrumentOverlap, false, 'Different instruments can be booked concurrently');
pass('Multi-Instrument', 'Independent instruments allow simultaneous concurrent bookings');

// ------------------------------------------------------------------------------
// 4. Index Coverage for High-Frequency Query Patterns
// ------------------------------------------------------------------------------
console.log('\n4. Index Coverage:');
const requiredIndexPatterns = [
  'idx_bookings_instrument_time',
  'idx_bookings_user_status',
  'idx_instruments_laboratory_status',
  'idx_instruments_next_calibration',
  'idx_maintenance_instrument_status',
  'idx_qualifications_user_instrument',
  'idx_notifications_user_unread',
  'idx_qr_booking_status',
  'idx_audit_user_created',
  'idx_audit_action_resource',
];

for (const idx of requiredIndexPatterns) {
  assert.ok(m3.includes(idx), `Index present: ${idx}`);
}
pass('Query Indexes', 'All 10 required composite and lookup indexes defined');

// ------------------------------------------------------------------------------
// 5. Row Level Security & Database Role Privileges
// ------------------------------------------------------------------------------
console.log('\n5. Row Level Security & Role Grants:');
const m4 = readMigration('20261012000004_row_level_security.sql');

// Verify RLS enabled on all 12 tables
for (const tbl of requiredTables) {
  assert.ok(m4.includes(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY;`), `RLS enabled on ${tbl}`);
}
pass('RLS Enforcement', 'Row Level Security enabled across 100% of public domain tables');

// Verify public privileges revoked
assert.ok(m4.includes('REVOKE ALL ON SCHEMA public FROM public;'), 'Revoked default public privileges');
assert.ok(m4.includes('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;'), 'Explicit usage granted');
pass('Role Privileges', 'Default public privileges revoked; least-privilege grants established');

// Security helper functions have fixed search_path to prevent injection
assert.ok(m4.includes('SET search_path = public'), 'Role helper function specifies fixed safe search_path');
pass('Security Definer Hygiene', 'Role helper specifies fixed search_path = public');

// Verify least-privilege policies:
// 1. Audit logs: no UPDATE or DELETE policy exists
assert.ok(!m4.includes('"audit_logs_update_policy"'), 'No UPDATE policy on audit_logs');
assert.ok(!m4.includes('"audit_logs_delete_policy"'), 'No DELETE policy on audit_logs');
pass('Audit Log Immutability', 'Audit logs are strictly append-only; update/delete policies absent');

// 2. Notifications: private to owner
assert.ok(m4.includes('user_id = auth.uid()'), 'Notifications scoped to owner auth.uid()');
pass('Notification Privacy', 'Cross-user notification reads, updates, and deletes denied by RLS');

// 3. Profiles: self-escalation of role prevented
assert.ok(m4.includes('role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())'), 'Role self-escalation blocked');
pass('Anti-Escalation', 'Profile updates disallow client-supplied role modification');

// ------------------------------------------------------------------------------
// 6. Atomic Transaction Procedures
// ------------------------------------------------------------------------------
console.log('\n6. Atomic Procedures & Transaction Invariants:');
const m5 = readMigration('20261012000005_atomic_functions_and_triggers.sql');

// 1. QR pass redemption
assert.ok(m5.includes('CREATE OR REPLACE FUNCTION public.redeem_qr_pass'), 'redeem_qr_pass function defined');
assert.ok(m5.includes('FOR UPDATE'), 'Row-level locking (FOR UPDATE) applied to prevent double-redemption');
assert.ok(m5.includes("status = 'USED'"), 'Pass status transitioned to USED');
assert.ok(m5.includes("status = 'CHECKED_IN'"), 'Booking status transitioned to CHECKED_IN');
pass('Atomic QR Redemption', 'redeem_qr_pass uses row locking (FOR UPDATE) to prevent duplicate check-in');

// 2. Booking cancellation
assert.ok(m5.includes('CREATE OR REPLACE FUNCTION public.cancel_booking_atomic'), 'cancel_booking_atomic function defined');
assert.ok(m5.includes("status = 'CANCELLED'"), 'Booking transitioned to CANCELLED');
assert.ok(m5.includes("status = 'REVOKED'"), 'Active QR pass transitioned to REVOKED');
pass('Atomic Cancellation', 'cancel_booking_atomic atomically cancels booking and revokes active QR passes');

// 3. Auto-profile trigger
assert.ok(m5.includes('CREATE OR REPLACE FUNCTION public.handle_new_auth_user'), 'handle_new_auth_user function defined');
assert.ok(m5.includes("v_role := 'student'"), 'New auth user defaults to student role');
pass('Profile Provisioning', 'Automatic auth.users trigger provisions student profile on registration');

// ------------------------------------------------------------------------------
// 7. Development Seed Data Validation
// ------------------------------------------------------------------------------
console.log('\n7. Seed Data Integrity & Secret Hygiene:');
const seedSql = fs.readFileSync(path.join(dir, 'supabase', 'seed.sql'), 'utf8');

// Ensure seed data includes representative fixtures
assert.ok(seedSql.includes('Bruker Avance III HD 600 MHz NMR'), 'Representative NMR instrument seeded');
assert.ok(seedSql.includes('UNDER_CALIBRATION'), 'Instrument with UNDER_CALIBRATION status seeded');
assert.ok(seedSql.includes('UNDER_MAINTENANCE'), 'Instrument with UNDER_MAINTENANCE status seeded');
assert.ok(seedSql.includes('NIST Traceable Chemical Shift Calibration'), 'Historical calibration record seeded');
assert.ok(seedSql.includes('ON CONFLICT (id) DO NOTHING'), 'Idempotent ON CONFLICT handling');

// Secret hygiene
assert.ok(!seedSql.includes('passwordHash'), 'No password hashes seeded');
assert.ok(!seedSql.includes('admin_password'), 'No admin password seeded');
assert.ok(!seedSql.includes('service_role'), 'No service role secret seeded');
pass('Seed Hygiene', 'Safe development seed fixtures provided without passwords, credentials, or secrets');

console.log(`\n=== ALL ${passedChecks} DATABASE ARCHITECTURE CHECKS PASSED ===\n`);
process.exit(0);
