/**
 * Auth secret resolution (Phase 02).
 * - Production: JWT_ACCESS_SECRET + JWT_REFRESH_SECRET must be set and non-default, else boot fails.
 * - Dev/test: ephemeral random secrets (tokens invalidate on restart) with a loud warning.
 */
const crypto = require('crypto');

let cached = null;

function resolveSecrets() {
  if (cached) return cached;
  const isProd = process.env.NODE_ENV === 'production';
  let { JWT_ACCESS_SECRET, JWT_REFRESH_SECRET } = process.env;
  const weak = (s) => !s || s.length < 32 || s === 'change-me' || s === 'dev-only';

  if (isProd && (weak(JWT_ACCESS_SECRET) || weak(JWT_REFRESH_SECRET))) {
    throw new Error('Missing/weak JWT secrets in production. Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (>=32 chars).');
  }
  if (weak(JWT_ACCESS_SECRET) || weak(JWT_REFRESH_SECRET)) {
    console.warn('[auth] Using ephemeral dev JWT secrets (tokens invalidate on restart). Set real secrets via env.');
    JWT_ACCESS_SECRET = crypto.randomBytes(48).toString('hex');
    JWT_REFRESH_SECRET = crypto.randomBytes(48).toString('hex');
  }
  cached = { accessSecret: JWT_ACCESS_SECRET, refreshSecret: JWT_REFRESH_SECRET, isProd };
  return cached;
}

function getAuthSecrets() {
  return resolveSecrets();
}

module.exports = { getAuthSecrets, resolveSecrets };
