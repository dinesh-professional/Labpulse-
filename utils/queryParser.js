/**
 * LabPulse Unified Query Parser (Module 14)
 * Provides standardized parameter parsing, field allowlisting, SQL-injection prevention,
 * deterministic secondary sorting, and bounded pagination.
 */

/**
 * Parses and bounds pagination parameters.
 *
 * @param {Object} query - Express req.query
 * @param {number} [defaultLimit=20]
 * @param {number} [maxLimit=100]
 * @returns {{ page: number, limit: number, offset: number }}
 */
function parsePagination(query = {}, defaultLimit = 20, maxLimit = 100) {
  let page = parseInt(query.page, 10);
  if (Number.isNaN(page) || page < 1) page = 1;

  let limit = parseInt(query.limit, 10);
  if (Number.isNaN(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;

  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Validates and normalizes sort parameters against an explicit allowlist.
 * Prevents arbitrary SQL/NoSQL injection via sort/order keys.
 *
 * @param {Object} query - Express req.query
 * @param {Object.<string, string>} allowedSortMap - Map of allowed query keys to DB columns
 * @param {string} defaultField - Fallback query key if requested field is missing/invalid
 * @param {'asc'|'desc'} [defaultOrder='desc']
 * @returns {{ sortBy: string, sortOrder: 'asc'|'desc', dbSortField: string, mongoSort: Object }}
 */
function parseSort(query = {}, allowedSortMap = {}, defaultField, defaultOrder = 'desc') {
  const requestedKey = (query.sort || query.sortBy || '').trim();
  const sortKey = Object.prototype.hasOwnProperty.call(allowedSortMap, requestedKey)
    ? requestedKey
    : defaultField;

  const dbEntry = allowedSortMap[sortKey];
  const dbSortField = (dbEntry && typeof dbEntry === 'object') ? (dbEntry.dbField || sortKey) : (dbEntry || sortKey);
  const mongoField = (dbEntry && typeof dbEntry === 'object') ? (dbEntry.mongoField || sortKey) : (dbEntry || sortKey);

  const rawOrder = (query.order || query.sortOrder || '').toLowerCase().trim();
  const sortOrder = rawOrder === 'asc' || rawOrder === 'ascending' ? 'asc' : 'desc';

  const mongoOrder = sortOrder === 'asc' ? 1 : -1;
  const mongoSort = { [mongoField]: mongoOrder };

  // Always append secondary deterministic sort for MongoDB
  if (mongoField !== 'id' && mongoField !== '_id' && mongoField !== 'createdAt') {
    mongoSort.createdAt = -1;
    mongoSort._id = -1;
  } else if (mongoField !== '_id' && mongoField !== 'id') {
    mongoSort._id = -1;
  }

  return {
    sortBy: sortKey,
    sortOrder,
    dbSortField,
    mongoSort,
  };
}

/**
 * Sanitizes search query string.
 *
 * @param {any} term
 * @param {number} [maxLength=80]
 * @returns {string|null}
 */
function sanitizeSearchTerm(term, maxLength = 80) {
  if (typeof term !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const stripped = term.replace(/[\x00-\x1F\x7F]/g, '');
  const cleaned = stripped.trim().slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Validates and extracts optional date ranges.
 *
 * @param {Object} query
 * @returns {{ startDate: string|null, endDate: string|null, error: string|null }}
 */
function parseDateRange(query = {}) {
  let startDate = null;
  let endDate = null;

  if (query.startDate) {
    const raw = String(query.startDate).trim();
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return { startDate: null, endDate: null, error: 'Invalid startDate. Must be valid ISO date.' };
    }
    startDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : d.toISOString();
  }

  if (query.endDate) {
    const raw = String(query.endDate).trim();
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return { startDate: null, endDate: null, error: 'Invalid endDate. Must be valid ISO date.' };
    }
    endDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : d.toISOString();
  }

  if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
    return { startDate: undefined, endDate: undefined, error: 'startDate cannot be after endDate.' };
  }

  return { startDate, endDate, error: null };
}

module.exports = {
  parsePagination,
  parseSort,
  sanitizeSearchTerm,
  parseDateRange,
};
