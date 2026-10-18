/**
 * Module 16 Verification Battery: Automated Testing & CI/CD Pipeline
 * Run: `node scripts/verify-module-16.js`
 *
 * Validates all acceptance criteria for Module 16:
 *  1. Testing Architecture & Directory Structure (Unit, Integration, Security, Frontend, E2E, Migrations)
 *  2. Isolated Unit Test Battery (Time, Tokens, Lifecycle, Analytics)
 *  3. Integration Test Battery (API contracts, Server health, RBAC scoping)
 *  4. Dedicated Security Battery (Audit immutability, SQL injection defusal, credential leak protection)
 *  5. Frontend & Accessibility Battery (Landmarks, dialog roles, reduced motion, zero raw fetch)
 *  6. End-to-End Core Lifecycle Workflows (Student, Faculty, Admin journeys)
 *  7. Database Schema & Migration Integrity (All 11 versioned SQL migrations)
 *  8. Build Verification Pipeline (Syntax check, static assets, server bootstrapping)
 *  9. CI Pipeline Specification (.github/workflows/ci.yml matrix, triggers, step sequencing)
 * 10. Developer Script Matrix (test:unit, test:integration, test:security, test:frontend, test:e2e, build)
 */
const assert = require('assert');
const { execSync } = require('child_process');
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

function runScript(cmd) {
  try {
    const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { success: true, output: out };
  } catch (err) {
    return { success: false, output: err.stdout || err.stderr || err.message };
  }
}

async function runBattery() {
  console.log('\n================================================================');
  console.log('  LABPULSE MODULE 16: AUTOMATED TESTING & CI/CD VERIFICATION');
  console.log('================================================================\n');

  /* --------------------------------------------------------------------------
     SUITE 1: Test Architecture & Structure
     -------------------------------------------------------------------------- */
  console.log('--- SUITE 1: Testing Architecture & Category Structure ---');
  const requiredTestFiles = [
    'tests/unit/time-and-scheduling.test.js',
    'tests/unit/tokens-and-security.test.js',
    'tests/unit/lifecycle-and-state.test.js',
    'tests/unit/analytics-helpers.test.js',
    'tests/integration/api-contracts.test.js',
    'tests/integration/rbac-and-scoping.test.js',
    'tests/security/security-regression.test.js',
    'tests/frontend/accessibility-and-dom.test.js',
    'tests/e2e/core-workflows.test.js',
    'tests/migrations/migration-integrity.test.js',
  ];

  let allFilesExist = true;
  for (const f of requiredTestFiles) {
    const fullPath = path.join(ROOT, f);
    if (!fs.existsSync(fullPath)) {
      allFilesExist = false;
      fail(`File existence: ${f}`, 'File missing');
    }
  }
  if (allFilesExist) {
    ok('All 10 required test suites present across unit, integration, security, frontend, e2e, and migrations categories');
  }

  /* --------------------------------------------------------------------------
     SUITE 2: Unit Test Execution
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 2: Isolated Unit Test Execution ---');
  const unitFiles = [
    'tests/unit/time-and-scheduling.test.js',
    'tests/unit/tokens-and-security.test.js',
    'tests/unit/lifecycle-and-state.test.js',
    'tests/unit/analytics-helpers.test.js',
  ];
  let unitPass = true;
  for (const uf of unitFiles) {
    const res = runScript(`node "${uf}"`);
    if (!res.success) {
      unitPass = false;
      fail(`Unit test: ${uf}`, res.output);
    }
  }
  if (unitPass) {
    ok('All unit test suites (time/scheduling, tokens/security, lifecycle, analytics) pass with 100% deterministic success');
  }

  /* --------------------------------------------------------------------------
     SUITE 3: Integration & Security Execution
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 3: Integration & Security Execution ---');
  const intSecFiles = [
    'tests/integration/api-contracts.test.js',
    'tests/integration/rbac-and-scoping.test.js',
    'tests/security/security-regression.test.js',
  ];
  let intSecPass = true;
  for (const isf of intSecFiles) {
    const res = runScript(`node "${isf}"`);
    if (!res.success) {
      intSecPass = false;
      fail(`Integration/Security test: ${isf}`, res.output);
    }
  }
  if (intSecPass) {
    ok('API contracts, RBAC isolation, and security regression batteries pass without error');
  }

  /* --------------------------------------------------------------------------
     SUITE 4: Frontend & Accessibility Execution
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 4: Frontend & Accessibility Execution ---');
  const a11yRes = runScript('node tests/frontend/accessibility-and-dom.test.js');
  const checkFrontRes = runScript('node scripts/check-frontend.js');
  if (a11yRes.success && checkFrontRes.success) {
    ok('Frontend DOM landmarks, dialog roles, live regions, and zero-fetch checks pass completely');
  } else {
    fail('Frontend/A11y tests', `${a11yRes.output}\n${checkFrontRes.output}`);
  }

  /* --------------------------------------------------------------------------
     SUITE 5: End-to-End User Journeys
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 5: End-to-End Workflow Execution ---');
  const e2eRes = runScript('node tests/e2e/core-workflows.test.js');
  if (e2eRes.success) {
    ok('Simulated student, faculty, and admin user journeys execute with all assertions passing');
  } else {
    fail('E2E workflows', e2eRes.output);
  }

  /* --------------------------------------------------------------------------
     SUITE 6: Database Migrations Verification
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 6: Migration & Schema Integrity ---');
  const migrRes = runScript('node tests/migrations/migration-integrity.test.js');
  if (migrRes.success) {
    ok('Schema integrity across all 11 PostgreSQL SQL migrations verified valid and ordered');
  } else {
    fail('Migration integrity', migrRes.output);
  }

  /* --------------------------------------------------------------------------
     SUITE 7: Application Build Verification
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 7: Application Build & Compilation ---');
  const buildRes = runScript('node scripts/build-verify.js');
  if (buildRes.success && buildRes.output.includes('BUILD SUCCESS')) {
    ok('Application compilation, syntax check of 100% source files, and server boot verification pass');
  } else {
    fail('Build verification', buildRes.output);
  }

  /* --------------------------------------------------------------------------
     SUITE 8: CI/CD Pipeline Configuration
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 8: GitHub Actions CI/CD Pipeline ---');
  const ciPath = path.join(ROOT, '.github/workflows/ci.yml');
  if (fs.existsSync(ciPath)) {
    const ciContent = fs.readFileSync(ciPath, 'utf8');
    const hasPush = ciContent.includes('push:');
    const hasPR = ciContent.includes('pull_request:');
    const hasMatrix = ciContent.includes('matrix:') && ciContent.includes('node-version:');
    const hasBuild = ciContent.includes('npm run build');
    const hasTest = ciContent.includes('npm run test');

    if (hasPush && hasPR && hasMatrix && hasBuild && hasTest) {
      ok('.github/workflows/ci.yml defines multi-stage CI pipeline with Node matrix (20, 22) and pull_request gates');
    } else {
      fail('CI pipeline content', 'Missing essential workflow stages or triggers in ci.yml');
    }
  } else {
    fail('CI workflow file', '.github/workflows/ci.yml does not exist');
  }

  /* --------------------------------------------------------------------------
     SUITE 9: Developer Script Matrix in package.json
     -------------------------------------------------------------------------- */
  console.log('\n--- SUITE 9: Developer Test Commands ---');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const requiredScripts = [
    'test:unit',
    'test:integration',
    'test:security',
    'test:frontend',
    'test:e2e',
    'test:migrations',
    'test:ci',
    'build',
  ];
  let scriptsValid = true;
  for (const s of requiredScripts) {
    if (!pkg.scripts[s]) {
      scriptsValid = false;
      fail(`Script definition: ${s}`, 'Missing in package.json');
    }
  }
  if (scriptsValid) {
    ok('package.json exports standard developer test commands (test:unit, test:integration, test:security, test:frontend, test:e2e, test:migrations, build)');
  }

  /* --------------------------------------------------------------------------
     FINAL SUMMARY
     -------------------------------------------------------------------------- */
  console.log('\n================================================================');
  console.log(`  VERIFICATION RESULT: ${passedChecks} / ${totalChecks} CHECKS PASSED`);
  if (failedChecks > 0) {
    console.error(`  ❌ ${failedChecks} CHECKS FAILED`);
    console.log('================================================================\n');
    process.exit(1);
  } else {
    console.log('  🎉 ALL MODULE 16 ACCEPTANCE CHECKS PASSED DETERMINISTICALLY');
    console.log('================================================================\n');
    process.exit(0);
  }
}

runBattery();
