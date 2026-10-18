/** Persistent test DB for Phase 12 (replaces per-run with-mongo). Writes URI to /tmp/test-mongo-uri and stays alive. */
const fs = require('fs');
const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  const m = await MongoMemoryServer.create();
  fs.writeFileSync('/tmp/test-mongo-uri', m.getUri());
  console.log(`ready ${m.getUri()}`);
  setInterval(() => {}, 60000);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
