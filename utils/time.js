/**
 * Time helpers (Phase 04). UTC-first: days stored as UTC midnight; HH:mm zero-padded
 * strings compare lexicographically == chronologically (used by the conflict query).
 */
function isHHMM(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function toMinutes(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' -> UTC-midnight Date, or null. */
function parseDayUTC(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayRangeUTC(str) {
  const start = parseDayUTC(str);
  if (!start) return null;
  return { start, next: new Date(start.getTime() + 86400000) };
}

function isPastDay(str) {
  const r = dayRangeUTC(str);
  if (!r) return false;
  const n = new Date();
  const today = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  return r.start < today;
}

function toDayString(d) {
  return new Date(d).toISOString().slice(0, 10);
}

module.exports = { isHHMM, toMinutes, fromMinutes, parseDayUTC, dayRangeUTC, isPastDay, toDayString };

