/**
 * Unit Test Suite: Analytics & Aggregation Helper Logic (Module 16)
 * Validates operational utilization formulas, capacity calculations,
 * percentage rounding, and division-by-zero safeguards.
 */
const assert = require('assert');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS [unit/analytics] ${name}`);
}

function run() {
  console.log('\n--- Unit: Analytics & Operational Math ---');

  // 1. Operating Capacity Calculation
  function calculateCapacity(commissionedCount, daysInWindow, dailyOperatingHours = 10) {
    return Math.max(0, commissionedCount) * Math.max(1, daysInWindow) * dailyOperatingHours;
  }

  assert.strictEqual(calculateCapacity(5, 30, 10), 1500, '5 instruments over 30 days = 1500 hrs capacity');
  assert.strictEqual(calculateCapacity(1, 7, 10), 70, '1 instrument over 7 days = 70 hrs capacity');
  assert.strictEqual(calculateCapacity(0, 30, 10), 0, '0 instruments yields 0 capacity');
  ok('Operating capacity calculates accurate instrument-hours per window');

  // 2. Utilization Rate % Calculation with Zero Safeguards
  function calculateUtilization(bookedHours, capacityHours) {
    if (!capacityHours || capacityHours <= 0) return 0;
    const raw = (bookedHours / capacityHours) * 100;
    return Math.round(raw * 10) / 10;
  }

  assert.strictEqual(calculateUtilization(300, 1500), 20.0, '300 / 1500 = 20.0%');
  assert.strictEqual(calculateUtilization(75.5, 100), 75.5, '75.5 / 100 = 75.5%');
  assert.strictEqual(calculateUtilization(0, 1500), 0, '0 booked hours = 0.0%');
  assert.strictEqual(calculateUtilization(100, 0), 0, 'Division-by-zero safely returns 0 without NaN/Infinity');
  ok('Utilization rate percentage rounds to 1 decimal place and guards against division by zero');

  // 3. Availability Rate %
  function calculateAvailability(availableCount, totalCommissioned) {
    if (!totalCommissioned || totalCommissioned <= 0) return 0;
    const raw = (availableCount / totalCommissioned) * 100;
    return Math.round(raw * 10) / 10;
  }

  assert.strictEqual(calculateAvailability(8, 10), 80.0);
  assert.strictEqual(calculateAvailability(3, 3), 100.0);
  assert.strictEqual(calculateAvailability(0, 0), 0);
  ok('Availability rate calculation strictly computes proportion of available commissioned units');

  // 4. Calibration Compliance %
  function calculateCompliance(compliantCount, totalRequiring) {
    if (!totalRequiring || totalRequiring <= 0) return 100.0; // If none require calibration, compliance is 100%
    const raw = (compliantCount / totalRequiring) * 100;
    return Math.round(raw * 10) / 10;
  }

  assert.strictEqual(calculateCompliance(9, 10), 90.0);
  assert.strictEqual(calculateCompliance(0, 0), 100.0);
  assert.strictEqual(calculateCompliance(0, 5), 0.0);
  ok('Calibration compliance rate handles required units and empty catalog edge cases');

  console.log(`  Summary: ${passed} analytics & aggregation helper checks passed.`);
}

run();
