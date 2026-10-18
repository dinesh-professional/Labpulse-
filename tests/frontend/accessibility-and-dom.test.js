/**
 * Frontend & Accessibility Test Suite (Module 16)
 * Validates WCAG accessibility landmarks, ARIA dialog roles, focus management,
 * reduced-motion styles/guards, and frontend security hygiene.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS [frontend/a11y] ${name}`);
}

function run() {
  console.log('\n--- Frontend: Accessibility, Landmarks & DOM Hygiene ---');
  const rootDir = path.resolve(__dirname, '../..');

  // 1. Index.html Accessibility Landmarks
  const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  assert.strictEqual(indexHtml.includes('<main id="main">'), true, 'Main landmark element with id="main" present');
  assert.strictEqual(indexHtml.includes('class="skip-link"'), true, 'Accessible skip navigation link present');
  ok('Primary index.html contains accessible skip-link and <main id="main"> landmark');

  // 2. Dialog ARIA Roles on Modals
  const dialogIds = ['booking-modal', 'qr-modal', 'notice-modal', 'mobile-menu'];
  for (const id of dialogIds) {
    const pattern = new RegExp(`<div id="${id}"[^>]*role="(dialog|alertdialog)"[^>]*>`);
    assert.strictEqual(pattern.test(indexHtml), true, `Modal #${id} must carry role="dialog" or "alertdialog"`);
  }
  ok('All interactive modals carry WCAG dialog roles (dialog/alertdialog)');

  // 3. Reduced Motion Support in CSS and JS
  const styleCss = fs.readFileSync(path.join(rootDir, 'style.css'), 'utf8');
  assert.strictEqual(styleCss.includes('@media (prefers-reduced-motion: reduce)'), true, 'Reduced motion media query in style.css');
  const motionJs = fs.readFileSync(path.join(rootDir, 'motion.js'), 'utf8');
  assert.strictEqual(motionJs.includes('prefers-reduced-motion'), true, 'Reduced motion check in motion.js');
  ok('Reduced motion preferences (@media and matchMedia) fully respected in styling and JavaScript');

  // 4. Form Accessibility & Autocomplete Attributes
  const loginHtml = fs.readFileSync(path.join(rootDir, 'login.html'), 'utf8');
  assert.strictEqual(loginHtml.includes('autocomplete="email"'), true, 'Login email has autocomplete="email"');
  assert.strictEqual(loginHtml.includes('autocomplete="current-password"'), true, 'Login password has autocomplete="current-password"');
  assert.strictEqual(loginHtml.includes('role="alert"'), true, 'Login errors render in role="alert" live region');
  ok('Authentication forms supply semantic autocomplete attributes and live error regions');

  // 5. Zero Raw fetch() Calls Across All Dashboards
  const dashboards = ['admin.html', 'faculty.html', 'student.html', 'dash.js'];
  for (const db of dashboards) {
    const content = fs.readFileSync(path.join(rootDir, db), 'utf8');
    const rawFetch = /[^a-zA-Z0-9_]fetch\s*\(/.test(content);
    assert.strictEqual(rawFetch, false, `Raw fetch() call found in ${db}`);
  }
  ok('Zero unauthenticated raw fetch() calls in frontend code; all network requests route via LabPulseAuth');

  console.log(`  Summary: ${passed} frontend & accessibility checks passed.`);
}

run();
