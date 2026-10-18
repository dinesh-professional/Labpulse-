/**
 * Unit Test Suite: Time & Scheduling Logic (Module 16)
 * Validates canonical UTC day boundaries, HH:MM conversions, slot durations,
 * and conflict detection math in isolation.
 */
const assert = require('assert');
const {
  isHHMM,
  toMinutes,
  fromMinutes,
  toDayString,
  parseDayUTC,
  dayRangeUTC,
} = require('../../utils/time');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS [unit/time] ${name}`);
}

function run() {
  console.log('\n--- Unit: Time & Scheduling Logic ---');

  // 1. HH:MM format validation
  assert.strictEqual(isHHMM('08:00'), true);
  assert.strictEqual(isHHMM('18:30'), true);
  assert.strictEqual(isHHMM('00:00'), true);
  assert.strictEqual(isHHMM('23:59'), true);
  assert.strictEqual(isHHMM('24:00'), false);
  assert.strictEqual(isHHMM('8:00'), false);
  assert.strictEqual(isHHMM('invalid'), false);
  assert.strictEqual(isHHMM(null), false);
  ok('isHHMM strictly validates 24-hour military format (HH:MM)');

  // 2. Minute conversions
  assert.strictEqual(toMinutes('00:00'), 0);
  assert.strictEqual(toMinutes('01:30'), 90);
  assert.strictEqual(toMinutes('08:00'), 480);
  assert.strictEqual(toMinutes('18:00'), 1080);
  assert.strictEqual(toMinutes('23:59'), 1439);
  ok('toMinutes accurately converts HH:MM to elapsed daily minutes');

  // 3. Reverse conversion from minutes
  assert.strictEqual(fromMinutes(0), '00:00');
  assert.strictEqual(fromMinutes(90), '01:30');
  assert.strictEqual(fromMinutes(480), '08:00');
  assert.strictEqual(fromMinutes(1080), '18:00');
  assert.strictEqual(fromMinutes(1439), '23:59');
  ok('fromMinutes correctly formats minute integers back into zero-padded HH:MM');

  // 4. Overlap & Conflict Math
  function checkSlotOverlap(startA, endA, startB, endB) {
    const aMin = toMinutes(startA);
    const aMax = toMinutes(endA);
    const bMin = toMinutes(startB);
    const bMax = toMinutes(endB);
    return Math.max(aMin, bMin) < Math.min(aMax, bMax);
  }

  assert.strictEqual(checkSlotOverlap('09:00', '11:00', '10:00', '12:00'), true, 'Overlapping slots detected');
  assert.strictEqual(checkSlotOverlap('09:00', '10:00', '10:00', '11:00'), false, 'Adjacent abutting slots do not overlap');
  assert.strictEqual(checkSlotOverlap('08:00', '09:00', '10:00', '11:00'), false, 'Disjoint slots do not overlap');
  assert.strictEqual(checkSlotOverlap('09:00', '12:00', '10:00', '11:00'), true, 'Contained slots overlap');
  ok('Slot intersection logic satisfies PostgreSQL GiST [start, end) half-open interval semantics');

  // 5. Day parsing & boundary generation
  const testDate = new Date('2026-10-15T00:00:00.000Z');
  assert.strictEqual(toDayString(testDate), '2026-10-15');

  const range = dayRangeUTC('2026-10-15');
  assert.strictEqual(range.start.toISOString(), '2026-10-15T00:00:00.000Z');
  assert.strictEqual(range.next.toISOString(), '2026-10-16T00:00:00.000Z');
  ok('dayRangeUTC creates exact 24-hour UTC window [start, next)');

  console.log(`  Summary: ${passed} time & scheduling checks passed.`);
}

run();
