/**
 * Supabase Auth Bridge Service (Module 04).
 * Provides server-side token verification and integration helpers for Supabase Auth
 * while preserving the active custom JWT implementation until the PostgreSQL
 * migration in Modules 05 & 06.
 *
 * Security:
 * - Service-role key is kept strictly on the backend.
 * - Client-supplied role claims in user_metadata are NEVER trusted for privileged roles.
 * - Validates JWT signature, expiration, and issuer.
 */
const jwt = require('jsonwebtoken');

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const jwtSecret = process.env.SUPABASE_JWT_SECRET || '';
  const isConfigured = !!(url && (jwtSecret || serviceKey));

  return {
    url,
    anonKey,
    serviceKey,
    jwtSecret,
    isConfigured,
  };
}

function isSupabaseConfigured() {
  return getSupabaseConfig().isConfigured;
}

/**
 * Verify a Supabase-issued access token on the server using the configured JWT secret.
 * Returns decoded payload { sub, email, aud, appMetadata, userMetadata } or throws.
 */
function verifySupabaseToken(token) {
  const { jwtSecret, url, isConfigured } = getSupabaseConfig();
  if (!isConfigured) {
    throw new Error('Supabase Auth is not configured in this environment.');
  }

  if (!jwtSecret) {
    throw new Error('SUPABASE_JWT_SECRET is required to verify Supabase tokens.');
  }

  // Supabase JWTs are signed with HMAC-SHA256 using the project JWT secret
  const decoded = jwt.verify(token, jwtSecret, {
    algorithms: ['HS256'],
  });

  // Basic issuer validation if URL is known
  if (url && decoded.iss && !decoded.iss.includes(url.replace(/^https?:\/\//, '')) && !decoded.iss.includes('supabase')) {
    throw new Error('Invalid token issuer.');
  }

  return {
    sub: decoded.sub,
    email: decoded.email,
    aud: decoded.aud,
    appMetadata: decoded.app_metadata || {},
    userMetadata: decoded.user_metadata || {},
  };
}

module.exports = {
  getSupabaseConfig,
  isSupabaseConfigured,
  verifySupabaseToken,
};
