/**
 * Test runner (Phase 12). Starts an in-memory MongoDB, runs the given command
 * with MONGODB_URI pointed at it, then shuts down.
 * Usage: node scripts/with-mongo.js <cmd> [args...]
 *   e.g. node scripts/with-mongo.js npm test
 */
const { spawnSync } = require('child_process');

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  console.log(`[with-mongo] live MongoDB at ${uri}`);
  const [, , cmd, ...args] = process.argv;
  if (!cmd) {
    console.error('Usage: node scripts/with-mongo.js <cmd> [args...]');
    await mongo.stop();
    process.exit(2);
  }
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, MONGODB_URI: uri },
  });
  await mongo.stop();
  process.exit(res.status === null ? 1 : res.status);
})().catch((e) => { console.error('[with-mongo] FAIL:', e.message); process.exit(1); });
