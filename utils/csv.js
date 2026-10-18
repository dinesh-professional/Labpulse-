/**
 * LabPulse Secure CSV Export Utility (Module 14)
 * RFC 4180 compliant CSV generator with spreadsheet formula injection protection.
 *
 * Security features:
 *  - Formula Injection (CSV Injection) Mitigation:
 *    Any cell beginning with '=', '+', '-', '@', '\t', or '\r' is prepended with a single quote (')
 *    to prevent spreadsheet software (Excel, Calc, Sheets) from executing dynamic formulas.
 *  - Sensitive Field Blacklisting:
 *    Prevents accidental leakage of authentication secrets, tokens, passwords, or hashes.
 *  - RFC 4180 Compliant Escaping:
 *    Internal quotes are doubled (" -> ""), and fields containing commas, quotes, or newlines are quoted.
 */

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'jwt',
  'secret',
  'apikey',
  'cookie',
  'authorization',
  'servicerole',
  'creditcard',
  'cardnumber',
  'cvv',
  'ssn',
]);

function isSensitiveKey(key = '') {
  const norm = String(key).toLowerCase().replace(/[-_]/g, '');
  for (const s of SENSITIVE_KEYS) {
    if (norm.includes(s)) return true;
  }
  return false;
}

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutralizes spreadsheet formula injection risks.
 * Prefixes triggers with a single quote (') per OWASP CSV Injection guidelines.
 */
function sanitizeFormulaInjection(value) {
  if (typeof value !== 'string') return value;
  if (!value.length) return value;
  const firstRaw = value[0];
  const trimmed = value.trimStart();
  const firstTrim = trimmed.length > 0 ? trimmed[0] : null;
  if (FORMULA_TRIGGERS.has(firstRaw) || (firstTrim && FORMULA_TRIGGERS.has(firstTrim))) {
    return `'${value}`;
  }
  return value;
}

/**
 * Escapes a cell value according to RFC 4180.
 */
function escapeCell(val) {
  if (val === null || val === undefined) return '';

  let str;
  if (val instanceof Date) {
    str = val.toISOString();
  } else if (typeof val === 'object') {
    str = JSON.stringify(val);
  } else {
    str = String(val);
  }

  // Neutralize formula injection
  str = sanitizeFormulaInjection(str);

  // Quote if contains special CSV characters or was formula sanitized
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r') || str.startsWith("'")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Serializes an array of records to an RFC 4180 CSV string.
 *
 * @param {Array<Object>} records - Array of data objects
 * @param {Array<Object>} columns - Array of { key, label, transform }
 * @returns {string} RFC 4180 CSV
 */
function toCsv(records = [], columns = []) {
  if (!columns.length && records.length) {
    // Derive columns from first record excluding sensitive fields
    columns = Object.keys(records[0])
      .filter((k) => !isSensitiveKey(k))
      .map((k) => ({ key: k, label: k }));
  }

  // Filter out any explicitly sensitive columns
  const safeCols = columns.filter((col) => !isSensitiveKey(col.key || col.label));

  const headerRow = safeCols.map((c) => escapeCell(c.label || c.key)).join(',');
  const dataRows = records.map((record) => {
    return safeCols
      .map((col) => {
        let val;
        if (typeof col.transform === 'function') {
          val = col.transform(record);
        } else {
          val = record[col.key];
        }
        return escapeCell(val);
      })
      .join(',');
  });

  return [headerRow, ...dataRows].join('\r\n');
}

module.exports = {
  toCsv,
  escapeCell,
  sanitizeFormulaInjection,
  sanitizeCsvValue: sanitizeFormulaInjection,
  SENSITIVE_KEYS,
};
