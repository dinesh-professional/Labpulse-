/**
 * Single-instance async mutex (Phase 12).
 * Serializes check-then-create critical sections per resource key so concurrent
 * requests cannot both pass an availability gate (verified: 10/10 double-schedule wins).
 * Keys are shared across bookings/calibrations/maintenance per instrument-day so
 * cross-type window races serialize too.
 * NOTE: single Node process only. Multi-instance deployments must additionally use
 * MongoDB transactions for the same guarantee.
 */
const chains = new Map();

function acquireLock(key) {
  const prev = chains.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((res) => { release = res; });
  const chained = prev.catch(() => {}).then(() => mine);
  chains.set(key, chained);
  return prev.catch(() => {}).then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      chained.then(() => { if (chains.get(key) === chained) chains.delete(key); });
    };
  });
}

module.exports = { acquireLock };
