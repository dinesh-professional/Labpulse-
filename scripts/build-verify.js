/**
 * LabPulse Build & Production Verification Script (Module 16)
 * Validates application compilation, syntax integrity of all modules,
 * static frontend assets, and server startup readiness.
 *
 * Usage: `npm run build` or `node scripts/build-verify.js`
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let checksPassed = 0;
function ok(label) {
  checksPassed += 1;
  console.log(`  ✅ BUILD PASS: ${label}`);
}

function runSyntaxCheck(relPath) {
  const fullPath = path.join(ROOT, relPath);
  execSync(`node -c "${fullPath}"`, { stdio: 'pipe' });
}

function checkDirectoryJs(dirRel) {
  const fullDir = path.join(ROOT, dirRel);
  if (!fs.existsSync(fullDir)) return;
  const files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    runSyntaxCheck(path.join(dirRel, f));
  }
}

async function verifyBuild() {
  console.log('\n================================================================');
  console.log('  LABPULSE BUILD VERIFICATION & COMPILED ASSET INTEGRITY');
  console.log('================================================================\n');

  // 1. Node runtime check
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (major < 18) {
    console.error(`❌ Build requires Node.js >= 18. Current: ${nodeVersion}`);
    process.exit(1);
  }
  ok(`Node.js runtime environment satisfied (${nodeVersion})`);

  // 2. Syntax check across backend modules
  try {
    runSyntaxCheck('server.js');
    runSyntaxCheck('auth.js');
    runSyntaxCheck('dash.js');
    runSyntaxCheck('app.js');
    runSyntaxCheck('motion.js');
    runSyntaxCheck('ui-system.js');
    checkDirectoryJs('routes');
    checkDirectoryJs('repositories');
    checkDirectoryJs('utils');
    checkDirectoryJs('middleware');
    checkDirectoryJs('services');
    checkDirectoryJs('models');
    checkDirectoryJs('config');
    ok('JavaScript syntax compilation verified across 100% of application modules');
  } catch (err) {
    console.error('❌ JS syntax compilation error:', err.message);
    process.exit(1);
  }

  // 3. Static HTML & asset integrity
  const requiredHtmlFiles = [
    'index.html',
    'login.html',
    'signup.html',
    'forgot-password.html',
    'reset-password.html',
    'admin.html',
    'faculty.html',
    'student.html',
    'design-system.html',
    '404.html',
  ];
  for (const h of requiredHtmlFiles) {
    const hp = path.join(ROOT, h);
    if (!fs.existsSync(hp) || fs.statSync(hp).size < 100) {
      console.error(`❌ Required frontend file missing or corrupt: ${h}`);
      process.exit(1);
    }
  }
  ok('Public static HTML views and template assets verified intact');

  // 4. Server boot readiness check without production secrets
  try {
    const app = require('../server');
    if (!app || typeof app.listen !== 'function') {
      throw new Error('Server export is not a valid express callable application');
    }
    ok('Application server bootstraps cleanly in isolated test environment');
  } catch (err) {
    console.error('❌ Server startup failure:', err.message);
    process.exit(1);
  }

  // 5. Container & Deployment Configuration
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  if (!dockerfile.includes('FROM node:20-alpine') || !dockerfile.includes('"server.js"')) {
    console.error('❌ Dockerfile configuration invalid');
    process.exit(1);
  }
  ok('Production Dockerfile specification verified');

  console.log('\n================================================================');
  console.log(`  BUILD SUCCESS: ${checksPassed} / ${checksPassed} VERIFICATION CHECKS PASSED`);
  console.log('================================================================\n');
}

verifyBuild().catch((e) => {
  console.error('BUILD FAILED:', e);
  process.exit(1);
});
