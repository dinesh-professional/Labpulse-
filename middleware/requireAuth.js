/**
 * requireAuth middleware (Phase 02 / Module 06). Server-side enforcement; frontend hiding is not security.
 * Loads user per request so deactivation takes effect (within access-token lifetime).
 * Backed by userRepository (supports both native JWT and Supabase Auth tokens).
 */
const { userRepository } = require('../repositories');
const { verifyAccessToken } = require('../utils/tokens');
const { getAuthSecrets } = require('../config/auth');
const { verifySupabaseToken, isSupabaseConfigured } = require('../services/supabaseAuth');

function getBearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  if (req.query && req.query.token) return req.query.token;
  return null;
}

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });
    }
    const { accessSecret } = getAuthSecrets();
    let user = null;

    try {
      const payload = verifyAccessToken(token, accessSecret);
      user = await userRepository.findById(payload.sub);
    } catch (jwtErr) {
      if (isSupabaseConfigured()) {
        try {
          const supaPayload = verifySupabaseToken(token);
          if (supaPayload.sub) {
            user = await userRepository.findById(supaPayload.sub);
          }
          if (!user && supaPayload.email) {
            user = await userRepository.findByEmail(supaPayload.email);
          }
        } catch (_) {
          // Both native and Supabase token verification failed
        }
      }
    }

    if (!user) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, error: { code: 'ACCOUNT_INACTIVE', message: 'Account is deactivated.' } });
    }
    req.user = user;
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token.' } });
  }
}

module.exports = { requireAuth };
