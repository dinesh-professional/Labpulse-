/**
 * Password helpers (Phase 02).
 * bcrypt acceptable per spec §16 (pure-JS bcryptjs: no native toolchain needed).
 * Policy: 8–128 chars. Never log or persist plaintext.
 */
const bcrypt = require('bcryptjs');

const MIN_LEN = 8;
const MAX_LEN = 128;
const SALT_ROUNDS = 12;

function validatePasswordPolicy(password) {
  if (typeof password !== 'string') return 'Password must be a string.';
  if (password.length < MIN_LEN) return `Password must be at least ${MIN_LEN} characters.`;
  if (password.length > MAX_LEN) return `Password must be at most ${MAX_LEN} characters.`;
  return null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password, passwordHash) {
  if (!password || !passwordHash) return false;
  return bcrypt.compare(password, passwordHash);
}

module.exports = { validatePasswordPolicy, hashPassword, verifyPassword, MIN_LEN, MAX_LEN };
