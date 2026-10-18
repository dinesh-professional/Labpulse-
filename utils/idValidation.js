/**
 * Unified ID Validation Helper (Module 06)
 * Validates identifiers across both MongoDB ObjectIds (24 hex) and PostgreSQL UUIDs (v4).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

function isUuid(id) {
  if (!id) return false;
  return UUID_RE.test(String(id).trim());
}

function isMongoObjectId(id) {
  if (!id) return false;
  return OBJECT_ID_RE.test(String(id).trim());
}

function isValidId(id) {
  if (!id) return false;
  const str = String(id).trim();
  return UUID_RE.test(str) || OBJECT_ID_RE.test(str);
}

module.exports = {
  isValidId,
  isUuid,
  isMongoObjectId,
  UUID_RE,
  OBJECT_ID_RE,
};
