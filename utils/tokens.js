/**
 * Token helpers (Phase 02).
 * - Access/refresh: JWT. Access short-lived (15m), refresh 7d with rotation via tokenVersion.
 * - Reset/activation: opaque crypto-random tokens; only sha256 hashes stored.
 * Secrets come from env; production refuses to boot on missing/default secrets (see routes/auth.js).
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '7d';

function signAccessToken(user, accessSecret) {
  return jwt.sign({ sub: String(user._id), role: user.role }, accessSecret, { expiresIn: ACCESS_TTL });
}

function signRefreshToken(user, refreshSecret) {
  return jwt.sign({ sub: String(user._id), v: user.tokenVersion || 0 }, refreshSecret, {
    expiresIn: REFRESH_TTL,
  });
}

function verifyAccessToken(token, accessSecret) {
  return jwt.verify(token, accessSecret);
}

function verifyRefreshToken(token, refreshSecret) {
  return jwt.verify(token, refreshSecret);
}

/** Opaque single-use token; return { token (send to user), tokenHash (store) }. */
function issueOpaqueToken(bytes = 32) {
  const token = crypto.randomBytes(bytes).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

function hashOpaqueToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  issueOpaqueToken,
  hashOpaqueToken,
};
