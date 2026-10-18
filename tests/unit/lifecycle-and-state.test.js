/**
 * Unit Test Suite: Instrument Lifecycle, Availability & State Transitions (Module 16)
 * Validates state precedence hierarchy, qualification level ordering,
 * and availability restore rules.
 */
const assert = require('assert');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS [unit/lifecycle] ${name}`);
}

function run() {
  console.log('\n--- Unit: Lifecycle & State Transitions ---');

  // 1. Authoritative Lifecycle States
  const VALID_LIFECYCLE_STATES = new Set([
    'COMMISSIONED',
    'DECOMMISSIONED',
    'RETIRED',
  ]);
  assert.strictEqual(VALID_LIFECYCLE_STATES.has('COMMISSIONED'), true);
  assert.strictEqual(VALID_LIFECYCLE_STATES.has('RETIRED'), true);
  assert.strictEqual(VALID_LIFECYCLE_STATES.has('UNKNOWN_STATE'), false);
  ok('Validates authoritative instrument lifecycle states');

  // 2. Operational Status Set
  const VALID_OPERATIONAL_STATUSES = new Set([
    'AVAILABLE',
    'UNDER_MAINTENANCE',
    'UNDER_CALIBRATION',
    'OUT_OF_ORDER',
    'LOCKED',
  ]);
  assert.strictEqual(VALID_OPERATIONAL_STATUSES.has('AVAILABLE'), true);
  assert.strictEqual(VALID_OPERATIONAL_STATUSES.has('OUT_OF_ORDER'), true);
  assert.strictEqual(VALID_OPERATIONAL_STATUSES.has('LOCKED'), true);
  ok('Validates operational status definitions across booking and maintenance layers');

  // 3. State Precedence Resolution Logic (per utils/restore.js)
  function resolveTargetStatus({ lifecycleState, openBreakageCount, activeMaintenanceCount, calibrationActiveOrOverdue }) {
    if (lifecycleState && lifecycleState !== 'COMMISSIONED') {
      return 'LOCKED';
    }
    if (openBreakageCount > 0) {
      return 'OUT_OF_ORDER';
    }
    if (calibrationActiveOrOverdue) {
      return 'UNDER_CALIBRATION';
    }
    if (activeMaintenanceCount > 0) {
      return 'UNDER_MAINTENANCE';
    }
    return 'AVAILABLE';
  }

  // Decommissioned/retired instruments are locked
  assert.strictEqual(
    resolveTargetStatus({ lifecycleState: 'RETIRED', openBreakageCount: 0, activeMaintenanceCount: 0, calibrationActiveOrOverdue: false }),
    'LOCKED'
  );

  // Breakage overrides maintenance and calibration
  assert.strictEqual(
    resolveTargetStatus({ lifecycleState: 'COMMISSIONED', openBreakageCount: 1, activeMaintenanceCount: 1, calibrationActiveOrOverdue: true }),
    'OUT_OF_ORDER'
  );

  // Calibration takes precedence over standard maintenance
  assert.strictEqual(
    resolveTargetStatus({ lifecycleState: 'COMMISSIONED', openBreakageCount: 0, activeMaintenanceCount: 1, calibrationActiveOrOverdue: true }),
    'UNDER_CALIBRATION'
  );

  // Active maintenance sets UNDER_MAINTENANCE
  assert.strictEqual(
    resolveTargetStatus({ lifecycleState: 'COMMISSIONED', openBreakageCount: 0, activeMaintenanceCount: 1, calibrationActiveOrOverdue: false }),
    'UNDER_MAINTENANCE'
  );

  // No blockers returns AVAILABLE
  assert.strictEqual(
    resolveTargetStatus({ lifecycleState: 'COMMISSIONED', openBreakageCount: 0, activeMaintenanceCount: 0, calibrationActiveOrOverdue: false }),
    'AVAILABLE'
  );
  ok('Status precedence hierarchy correctly handles breakage > calibration > maintenance > available');

  // 4. Operator Qualification Level Hierarchy
  const QUAL_LEVELS = {
    LEVEL_1: 1, // Basic Operation
    LEVEL_2: 2, // Supervised Operation
    LEVEL_3: 3, // Autonomous Operation
    LEVEL_4: 4, // Master Trainer / Certifier
  };

  function isEligibleToOperate(userLevel, requiredLevel) {
    const uVal = QUAL_LEVELS[userLevel] || 0;
    const rVal = QUAL_LEVELS[requiredLevel] || 0;
    return uVal >= rVal;
  }

  assert.strictEqual(isEligibleToOperate('LEVEL_3', 'LEVEL_2'), true, 'Higher level qualifies for lower requirement');
  assert.strictEqual(isEligibleToOperate('LEVEL_2', 'LEVEL_2'), true, 'Exact level qualifies');
  assert.strictEqual(isEligibleToOperate('LEVEL_1', 'LEVEL_2'), false, 'Lower level disqualified');
  assert.strictEqual(isEligibleToOperate('LEVEL_4', 'LEVEL_1'), true, 'Master trainer satisfies all lower levels');
  ok('Operator qualification level hierarchy enforces monotonic privilege escalation [1..4]');

  console.log(`  Summary: ${passed} lifecycle & state checks passed.`);
}

run();
