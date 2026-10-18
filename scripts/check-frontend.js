/**
 * Static frontend checks (Phase 11). Run: `node scripts/check-frontend.js` (no DB, no deps).
 * - Every getElementById target exists in index.html.
 * - Every inline onclick handler is defined in app.js.
 * - No window.alert in product code.
 * - No monetary/grant content in the booking flow (Phase 05 regression guard).
 * - Local asset references are served (server.js whitelist parity).
 * - Dialogs carry accessible roles.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');

let failures = 0;
function check(cond, label) {
  if (cond) { console.log(`  PASS ${label}`); }
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

// IDs referenced from JS must exist (hero-bg-img intentionally removed; guarded in JS).
const NULLABLE_IDS = new Set(['hero-bg-img']);
const ids = [...new Set([...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))];
const missingIds = ids.filter((id) => !NULLABLE_IDS.has(id) && !html.includes(`id="${id}"`));
check(missingIds.length === 0, `JS-referenced IDs exist (${ids.length} checked${missingIds.length ? `: missing ${missingIds.join(', ')}` : ''})`);

// Inline handlers must be defined.
const handlers = [...new Set([...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))];
const missingFn = handlers.filter((fn) => !new RegExp(`function ${fn}\\s*\\(`).test(js));
check(missingFn.length === 0, `inline handlers defined (${handlers.length} checked${missingFn.length ? `: missing ${missingFn.join(', ')}` : ''})`);

// No alert() in product code (strip comments first).
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const alertLines = jsCode.split('\n').filter((l) => /\balert\s*\(/.test(l));
check(alertLines.length === 0, `no window.alert (${alertLines.length} found)`);

// Booking flow stays money-free (grants section is grant tracking, not booking — allow its heading only).
const badMoney = html.split('\n').filter((l) => {
  if (/RESEARCH GRANTS/.test(l)) return false;
  return /RATE \(INTERNAL\)|\/ HOUR|\$[0-9]+\/hr|GRANT ACCOUNT|EST\. COST|book-grant-select|book-est-cost|chargeback/i.test(l);
});
check(badMoney.length === 0, `booking flow money-free (${badMoney.length} offending lines)`);

// Local assets must be whitelisted in server.js.
const refs = [...new Set([...html.matchAll(/(?:src|href)="(?!https?:|#|mailto:)([^"]+)"/g)].map((m) => m[1]))];
const unserved = refs.filter((r) => r !== 'style.css' && r !== 'app.js' && !server.includes(`'/${r}'`));
check(unserved.length === 0, `local assets served (${refs.length} refs${unserved.length ? `: unserved ${unserved.join(', ')}` : ''})`);

// Dialogs need accessible roles.
for (const id of ['booking-modal', 'qr-modal', 'notice-modal', 'mobile-menu']) {
  const tag = html.match(new RegExp(`<div id="${id}"[^>]*>`));
  check(!!tag && /role="(dialog|alertdialog)"/.test(tag[0]), `dialog role on #${id}`);
}

// Landmarks + labels.
check(/<main id="main">/.test(html), 'main landmark present');
check(/class="skip-link"/.test(html), 'skip link present');
check(/prefers-reduced-motion/.test(fs.readFileSync(path.join(dir, 'style.css'), 'utf8')), 'reduced-motion CSS present');
check(/prefers-reduced-motion/.test(js), 'reduced-motion JS guards present');

// ---- Phase 14: auth UI + role dashboards ----
const PAGES = ['login.html', 'signup.html', 'forgot-password.html', 'reset-password.html', 'admin.html', 'faculty.html', 'student.html'];
const pageSrc = {};
for (const p of PAGES) {
  const fp = path.join(dir, p);
  check(fs.existsSync(fp), `page exists: ${p}`);
  try { pageSrc[p] = fs.readFileSync(fp, 'utf8'); } catch (e) { pageSrc[p] = ''; }
}
const authJs = fs.readFileSync(path.join(dir, 'auth.js'), 'utf8');
const dashJs = fs.readFileSync(path.join(dir, 'dash.js'), 'utf8');

function inlineScripts(src) {
  return [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}
// ONE api client: page scripts must go through LabPulseAuth, never raw fetch.
for (const p of PAGES) {
  check(!/fetch\s*\(/.test(inlineScripts(pageSrc[p])), `${p}: no competing API client`);
}
check(!/fetch\s*\(/.test(dashJs), 'dash.js: no direct fetch');
// Role never trusted from storage.
const allClientCode = authJs + '\n' + dashJs + '\n' + PAGES.map((p) => inlineScripts(pageSrc[p])).join('\n');
check(!/getItem\s*\(\s*['"]role['"]\s*\)/.test(allClientCode), 'no role read from storage');
check(!/localStorage\s*\.\s*role/.test(allClientCode), 'no localStorage.role');
// No alert() in new client code (strip comments first).
const clientCode = allClientCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check(!/\balert\s*\(/.test(clientCode), 'no window.alert in auth UI');
// No public faculty registration anywhere on auth pages.
for (const p of ['login.html', 'signup.html', 'forgot-password.html', 'reset-password.html']) {
  check(!/register as faculty|faculty signup|faculty registration|create faculty account/i.test(pageSrc[p]), `${p}: no public faculty signup`);
}
// Booking stays free on new pages.
for (const p of PAGES) {
  const bad = pageSrc[p].split('\n').filter((l) => {
    if (/RESEARCH GRANTS/.test(l)) return false;
    return /RATE \(INTERNAL\)|\/ HOUR|\$[0-9]+\/hr|GRANT ACCOUNT|EST\. COST|book-grant-select|book-est-cost|chargeback/i.test(l);
  });
  check(bad.length === 0, `${p}: money-free`);
}
// Per-page DOM wiring: inline-referenced IDs exist in the same page.
for (const p of PAGES) {
  const used = [...new Set([...inlineScripts(pageSrc[p]).matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !pageSrc[p].includes(`id="${id}"`));
  check(missing.length === 0, `${p}: inline IDs resolve (${used.length} checked${missing.length ? `: missing ${missing.join(', ')}` : ''})`);
}
// Shared helper IDs resolve on all dashboards.
for (const id of [...dashJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])) {
  const missingOn = ['admin.html', 'faculty.html', 'student.html'].filter((p) => !pageSrc[p].includes(`id="${id}"`));
  check(missingOn.length === 0, `dash.js #${id} on all dashboards${missingOn.length ? `: missing on ${missingOn.join(', ')}` : ''}`);
}
// Server whitelist parity.
for (const f of [...PAGES, 'auth.js', 'dash.js']) {
  check(server.includes(`'/${f}'`), `whitelisted: ${f}`);
}
// Reset token hygiene + login a11y markers.
check(!/console\.log|localStorage|sessionStorage/.test(inlineScripts(pageSrc['reset-password.html'])), 'reset token never logged/stored');
check(/autocomplete="email"/.test(pageSrc['login.html']) && /autocomplete="current-password"/.test(pageSrc['login.html']), 'login autocomplete attrs');
check(/role="alert"/.test(pageSrc['login.html']), 'login error live region');

if (failures) { console.error(`\nCHECK FAIL (${failures} failing)`); process.exit(1); }
console.log('\nCHECK OK');
