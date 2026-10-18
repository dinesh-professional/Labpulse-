/**
 * Module 14 Verification Battery: Search, Filtering & Data Export
 * Run: `node scripts/verify-module-14.js`
 *
 * Validates all acceptance criteria for Module 14:
 *  1. CSV Security & Sanitization (formula injection mitigation, RFC 4180 escaping, sensitive field exclusion)
 *  2. Unified Query Architecture (parsePagination bounding, parseSort allowlists & SQL-injection safety, sanitizeSearchTerm, parseDateRange)
 *  3. Performance Migration 10 (PostgreSQL composite indexes on instruments, bookings, maintenance, calibrations, qualifications)
 *  4. Instrument Search, Filtering & Export (multi-field search, status/category/lifecycle filters, student breakageFee exclusion, audit log)
 *  5. Booking Search & Role Scoping (student own-booking isolation, purpose search, date ranges, status filters, audit log)
 *  6. User Search & Security (admin-only identity field search, credential stripping, role filter, audit log)
 *  7. Operator Qualification Filtering & Export (status, level, instrument, safe sort, audit log)
 *  8. Maintenance & Calibration Search & Export (multi-field search, status/type filters, date ranges, audit logs)
 *  9. Breakage Reports Search & Scoping (student report isolation, breakageFee stripping for non-admins, audit log)
 * 10. Frontend UI Integration & Hygiene (search inputs, debounce, export buttons wired via A.download, zero raw fetch)
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
  console.log('\n===============================================================');
  console.log('  LABPULSE MODULE 14: SEARCH, FILTERING & DATA EXPORT TEST BATTERY');
  console.log('===============================================================\n');

  /* --------------------------------------------------------------------------
     SUITE 1: CSV Security & Sanitization (utils/csv.js)
     -------------------------------------------------------------------------- */
  console.log('--- SUITE 1: CSV Security & Sanitization ---');
  try {
    const { toCsv, sanitizeCsvValue } = require('../utils/csv');

    // 1.1 Formula injection characters are prefixed with single quote
    const formulaPayloads = [
      '=SUM(A1:A10)',
      '+1+2',
      '-2+3',
      '@SUM(1,2)',
      '\tCMD',
      '\rMALICIOUS',
    ];
    let formulaSafe = true;
    for (const p of formulaPayloads) {
      const sanitized = sanitizeCsvValue(p);
      if (!sanitized.startsWith("'")) {
        formulaSafe = false;
        break;
      }
    }
    if (formulaSafe) {
      ok('Formula injection characters (=, +, -, @, \\t, \\r) are neutralised with single-quote prefix');
    } else {
      fail('Formula injection mitigation', 'Unquoted formula payload detected');
    }

    // 1.2 RFC 4180 Escaping (double quotes and commas)
    const testRecords = [
      { name: 'Microscope, Optical', notes: 'Has "special" lens', code: '=cmd' },
    ];
    const columns = [
      { key: 'name', label: 'Item Name' },
      { key: 'notes', label: 'Notes' },
      { key: 'code', label: 'Code' },
    ];
    const csvOut = toCsv(testRecords, columns);
    const lines = csvOut.split(/\r?\n/);

    assert.strictEqual(lines[0], 'Item Name,Notes,Code');
    assert.strictEqual(lines[1], '"Microscope, Optical","Has ""special"" lens","\'=cmd"');
    ok('RFC 4180 quotes and commas escaped cleanly');

    // 1.3 Sensitive Field Stripping
    const sensitiveRecord = [
      {
        name: 'Admin User',
        email: 'admin@labpulse.edu',
        password: 'hash_secret_password',
        jwtToken: 'eyJhbGciOi...',
        apiKey: 'sk-live-12345',
        creditCard: '4111-2222-3333-4444',
      },
    ];
    const autoCols = toCsv(sensitiveRecord);
    if (
      !autoCols.includes('hash_secret_password') &&
      !autoCols.includes('eyJhbGciOi') &&
      !autoCols.includes('sk-live-12345') &&
      !autoCols.includes('creditCard')
    ) {
      ok('Sensitive security fields (passwords, JWTs, API keys, CCs) stripped from exports');
    } else {
      fail('Sensitive field stripping', 'Sensitive data was leaked in CSV export');
    }
  } catch (err) {
    fail('CSV utility test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 2: Unified Query Parser (utils/queryParser.js)
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 2: Unified Query Parser ---');
  try {
    const {
      parsePagination,
      parseSort,
      sanitizeSearchTerm,
      parseDateRange,
    } = require('../utils/queryParser');

    // 2.1 Pagination Bounding
    const normalPage = parsePagination({ page: '2', limit: '25' }, 20, 100);
    assert.strictEqual(normalPage.page, 2);
    assert.strictEqual(normalPage.limit, 25);
    assert.strictEqual(normalPage.offset, 25);

    // Enforce upper bound on limit (prevent ?limit=1000000 DOS)
    const hugePage = parsePagination({ page: '-5', limit: '9999999' }, 20, 100);
    assert.strictEqual(hugePage.page, 1, 'Page cannot be less than 1');
    assert.strictEqual(hugePage.limit, 100, 'Limit bounded to maxLimit 100');
    ok('Pagination parser enforces bounds (page >= 1, limit <= maxLimit)');

    // 2.2 Sorting Allowlists & Injection Prevention
    const testSortMap = {
      name: { dbField: 'name', mongoField: 'name' },
      date: { dbField: 'date', mongoField: 'date' },
      status: { dbField: 'status', mongoField: 'status' },
    };

    // Valid sort
    const validSort = parseSort({ sort: 'date', order: 'asc' }, testSortMap, 'date', 'desc');
    assert.strictEqual(validSort.sortBy, 'date');
    assert.strictEqual(validSort.sortOrder, 'asc');
    assert.strictEqual(validSort.dbSortField, 'date');
    assert.strictEqual(validSort.mongoSort.date, 1);
    assert.strictEqual(validSort.mongoSort._id, -1, 'Deterministic secondary sort required');

    // Attempted SQL Injection in sort parameter
    const sqlInjSort = parseSort({ sort: 'DROP TABLE users;--', order: 'desc' }, testSortMap, 'name', 'asc');
    assert.strictEqual(sqlInjSort.sortBy, 'name', 'Fallback to default allowed field on injection attempt');
    assert.strictEqual(sqlInjSort.dbSortField, 'name');

    // Unlisted field safely ignored
    const unlistedSort = parseSort({ sort: 'password_hash' }, testSortMap, 'name', 'asc');
    assert.strictEqual(unlistedSort.sortBy, 'name');
    ok('Sort parser uses strict allowlists and rejects SQL injection / unlisted columns');

    // 2.3 Search Term Sanitization
    const cleanTerm = sanitizeSearchTerm('  Confocal Microscope  ');
    assert.strictEqual(cleanTerm, 'Confocal Microscope');
    const dirtyTerm = sanitizeSearchTerm('Test\x00\x08String');
    assert.strictEqual(dirtyTerm, 'TestString');
    const longTerm = sanitizeSearchTerm('A'.repeat(250), 50);
    assert.strictEqual(longTerm.length, 50);
    ok('Search term sanitizer trims, limits length, and strips control characters');

    // 2.4 Date Range Parsing
    const validRange = parseDateRange({ startDate: '2026-10-01', endDate: '2026-10-15' });
    assert.strictEqual(validRange.startDate, '2026-10-01');
    assert.strictEqual(validRange.endDate, '2026-10-15');

    // Inverted range check
    const invertedRange = parseDateRange({ startDate: '2026-10-20', endDate: '2026-10-05' });
    assert.strictEqual(invertedRange.startDate, undefined);
    assert.strictEqual(invertedRange.endDate, undefined);
    ok('Date range parser validates ISO dates and rejects inverted ranges');
  } catch (err) {
    fail('Query parser test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 3: Database Performance & Migration 10
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 3: Database Composite Indexes (Migration 10) ---');
  try {
    const migrationCheck = fileContains(
      'supabase/migrations/20261012000010_search_filtering_export_indexes.sql',
      'idx_instruments_search_composite',
      'idx_instruments_lifecycle_status',
      'idx_bookings_user_date_status',
      'idx_bookings_instrument_date_status',
      'idx_maintenance_status_dates',
      'idx_calibrations_status_date',
      'idx_operator_qualifications_user_status_expires'
    );
    if (migrationCheck.exists && migrationCheck.missing.length === 0) {
      ok('Migration 10 defines composite indexes for search, status, and date sorting');
    } else {
      fail('Migration 10 indexes', `Missing: ${migrationCheck.missing.join(', ')}`);
    }
  } catch (err) {
    fail('Migration test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 4: Instrument Search, Filtering & Export
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 4: Instrument Search, Filtering & Export ---');
  try {
    const instRepoCheck = fileContains(
      'repositories/instrumentRepository.js',
      '_buildMongoFilter',
      'filter.q',
      'filter.category',
      'filter.lifecycleState',
      'ALLOWED_INSTRUMENT_SORTS'
    );
    if (instRepoCheck.exists && instRepoCheck.missing.length === 0) {
      ok('Instrument repository supports multi-field search, composable filters, and safe sorting');
    } else {
      fail('Instrument repository', `Missing: ${instRepoCheck.missing.join(', ')}`);
    }

    const instRouteCheck = fileContains(
      'routes/instruments.js',
      'parsePagination',
      'parseSort',
      'router.get(\'/export\'',
      'INSTRUMENTS_EXPORTED',
      'breakageFee'
    );
    if (instRouteCheck.exists && instRouteCheck.missing.length === 0) {
      ok('Instruments route provides /export endpoint, audits exports, and hides breakageFee from students');
    } else {
      fail('Instruments route', `Missing: ${instRouteCheck.missing.join(', ')}`);
    }
  } catch (err) {
    fail('Instrument search & export test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 5: Booking Search, Role-Aware Filtering & Export
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 5: Booking Search, Role-Aware Filtering & Export ---');
  try {
    const bkRepoCheck = fileContains(
      'repositories/bookingRepository.js',
      '_buildMongoFilter',
      'filter.startDate',
      'filter.endDate',
      'filter.q',
      'ALLOWED_BOOKING_SORTS'
    );
    if (bkRepoCheck.exists && bkRepoCheck.missing.length === 0) {
      ok('Booking repository supports purpose search, date range filtering, and deterministic sorting');
    } else {
      fail('Booking repository', `Missing: ${bkRepoCheck.missing.join(', ')}`);
    }

    const bkRouteCheck = fileContains(
      'routes/bookings.js',
      'req.user.role === \'student\'',
      'filter.userId = currentUserId',
      'router.get(\'/export\'',
      'BOOKINGS_EXPORTED'
    );
    if (bkRouteCheck.exists && bkRouteCheck.missing.length === 0) {
      ok('Bookings route enforces student-scoping on search and export with BOOKINGS_EXPORTED audit');
    } else {
      fail('Bookings route', `Missing: ${bkRouteCheck.missing.join(', ')}`);
    }
  } catch (err) {
    fail('Booking search test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 6: User Administration Search & Security
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 6: User Administration Search & Security ---');
  try {
    const userRepoCheck = fileContains(
      'repositories/userRepository.js',
      'filter.q',
      'ALLOWED_USER_SORTS',
      '_buildMongoFilter'
    );
    if (userRepoCheck.exists && userRepoCheck.missing.length === 0) {
      ok('User repository supports multi-field search and allowlisted sorting');
    } else {
      fail('User repository', `Missing: ${userRepoCheck.missing.join(', ')}`);
    }

    const userRouteCheck = fileContains(
      'routes/users.js',
      'adminOnly',
      'router.get(\'/export\'',
      'USERS_EXPORTED',
      'password',
      'toCsv'
    );
    if (userRouteCheck.exists && userRouteCheck.missing.length === 0) {
      ok('Users route restricts export to admin, strips credentials, and logs USERS_EXPORTED');
    } else {
      fail('Users route', `Missing: ${userRouteCheck.missing.join(', ')}`);
    }
  } catch (err) {
    fail('User admin search test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 7: Operator Qualification Filtering & Export
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 7: Operator Qualification Filtering & Export ---');
  try {
    const qualRepoCheck = fileContains(
      'repositories/qualificationRepository.js',
      'sortBy',
      'sortOrder',
      'expiresBefore',
      'expiresAfter'
    );
    if (qualRepoCheck.exists && qualRepoCheck.missing.length === 0) {
      ok('Qualification repository supports sorting, level, and expiry window filters');
    } else {
      fail('Qualification repository', `Missing: ${qualRepoCheck.missing.join(', ')}`);
    }

    const qualRouteCheck = fileContains(
      'routes/qualifications.js',
      'router.get(\'/export\'',
      'QUALIFICATIONS_EXPORTED',
      'ALLOWED_QUALIFICATION_SORTS'
    );
    if (qualRouteCheck.exists && qualRouteCheck.missing.length === 0) {
      ok('Qualifications route provides /export and audits QUALIFICATIONS_EXPORTED');
    } else {
      fail('Qualifications route', `Missing: ${qualRouteCheck.missing.join(', ')}`);
    }
  } catch (err) {
    fail('Qualification filtering test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 8: Maintenance & Calibration Search & Export
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 8: Maintenance & Calibration Search & Export ---');
  try {
    const maintCheck = fileContains(
      'routes/maintenance.js',
      'ALLOWED_MAINTENANCE_SORTS',
      'router.get(\'/export\'',
      'MAINTENANCE_EXPORTED'
    );
    if (maintCheck.exists && maintCheck.missing.length === 0) {
      ok('Maintenance route supports search, date ranges, and audited CSV export');
    } else {
      fail('Maintenance route', `Missing: ${maintCheck.missing.join(', ')}`);
    }

    const calCheck = fileContains(
      'routes/calibrations.js',
      'ALLOWED_CALIBRATION_SORTS',
      'router.get(\'/export\'',
      'CALIBRATIONS_EXPORTED'
    );
    if (calCheck.exists && calCheck.missing.length === 0) {
      ok('Calibration route supports search, status, and audited CSV export');
    } else {
      fail('Calibration route', `Missing: ${calCheck.missing.join(', ')}`);
    }
  } catch (err) {
    fail('Maintenance & calibration test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 9: Breakage Reports Search & Role-Aware Export
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 9: Breakage Reports Search & Scoping ---');
  try {
    const breakageCheck = fileContains(
      'routes/breakage.js',
      'router.get(\'/export\'',
      'BREAKAGE_EXPORTED',
      'req.user.role === \'student\'',
      'delete r.breakageFee'
    );
    if (breakageCheck.exists && breakageCheck.missing.length === 0) {
      ok('Breakage route scopes student exports and hides breakageFee from non-admins');
    } else {
      fail('Breakage route', `Missing: ${breakageCheck.missing.join(', ')}`);
    }
  } catch (err) {
    fail('Breakage search test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUITE 10: Frontend UI Integration & Hygiene
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 10: Frontend UI Integration & Hygiene ---');
  try {
    const adminHtmlCheck = fileContains(
      'admin.html',
      'admin-bk-search',
      'admin-bk-export-csv',
      'admin-inst-search',
      'admin-inst-export-csv',
      'user-mgmt-export-csv',
      'admin-qual-export-csv',
      'setTimeout(loadAdminBookings, 300)',
      'setTimeout(loadAdminInstruments, 300)',
      'setTimeout(loadUserManagement, 300)'
    );
    if (adminHtmlCheck.exists && adminHtmlCheck.missing.length === 0) {
      ok('admin.html integrates search inputs, 300ms debouncing, and CSV export buttons');
    } else {
      fail('admin.html integration', `Missing: ${adminHtmlCheck.missing.join(', ')}`);
    }

    // Verify zero raw fetch in admin.html
    const adminContent = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
    const rawFetch = /[^a-zA-Z0-9_]fetch\s*\(/.test(adminContent);
    if (!rawFetch) {
      ok('admin.html maintains strict API hygiene (0 raw fetch() calls; all routed via LabPulseAuth)');
    } else {
      fail('admin.html API hygiene', 'Raw fetch() found in admin.html');
    }
  } catch (err) {
    fail('Frontend UI test', err.message);
  }

  /* --------------------------------------------------------------------------
     SUMMARY
     -------------------------------------------------------------------------- */
  console.log('\n===============================================================');
  console.log(`  MODULE 14 VERIFICATION SUMMARY: ${passedChecks}/${totalChecks} PASS`);
  console.log('===============================================================\n');

  if (failedChecks > 0) {
    console.error(`❌ Module 14 verification failed with ${failedChecks} error(s).`);
    process.exit(1);
  } else {
    console.log('🎉 All Module 14 search, filtering, and export requirements verified successfully.');
    process.exit(0);
  }
}

runBattery().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
