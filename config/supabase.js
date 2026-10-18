/**
 * Supabase PostgreSQL Client Configuration (Module 06)
 * Initializes server-side Supabase client with security best practices:
 * - Service-role key is kept strictly backend and never leaked to frontend.
 * - Explicit connection health verification.
 * - Centralized client factory.
 */
const { createClient } = require('@supabase/supabase-js');

let adminClient = null;
let anonClient = null;

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const jwtSecret = process.env.SUPABASE_JWT_SECRET || '';
  const isConfigured = !!(url && serviceKey);

  return {
    url,
    serviceKey,
    anonKey,
    jwtSecret,
    isConfigured,
  };
}

function isSupabaseConfigured() {
  return getSupabaseConfig().isConfigured;
}

/**
 * Returns the privileged server-side Supabase client.
 * Strictly used by backend repositories where the server independently
 * enforces authentication, RBAC, and business rules before data access.
 */
function getSupabaseAdminClient() {
  const { url, serviceKey, isConfigured } = getSupabaseConfig();
  if (!isConfigured) {
    return null;
  }
  if (!adminClient) {
    adminClient = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return adminClient;
}

/**
 * Returns the public anon Supabase client.
 */
function getSupabaseAnonClient() {
  const { url, anonKey } = getSupabaseConfig();
  if (!url || !anonKey) {
    return null;
  }
  if (!anonClient) {
    anonClient = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return anonClient;
}

/**
 * Actively tests connectivity to Supabase PostgreSQL by querying a core table.
 * Returns { ok: boolean, healthy: boolean, configured: boolean, status: string, latencyMs?: number, error?: string }.
 */
async function checkSupabaseHealth() {
  const { isConfigured } = getSupabaseConfig();
  if (!isConfigured) {
    return { ok: false, healthy: false, configured: false, status: 'not_configured' };
  }
  const client = getSupabaseAdminClient();
  if (!client) {
    return { ok: false, healthy: false, configured: true, status: 'uninitialized' };
  }

  const start = Date.now();
  try {
    const { error } = await client.from('laboratories').select('id').limit(1);
    const latencyMs = Date.now() - start;
    if (error) {
      return { ok: false, healthy: false, configured: true, status: 'error', error: error.message, latencyMs };
    }
    return { ok: true, healthy: true, configured: true, status: 'connected', latencyMs };
  } catch (err) {
    return { ok: false, healthy: false, configured: true, status: 'unreachable', error: err.message, latencyMs: Date.now() - start };
  }
}

/**
 * Determines whether the active data backend is Supabase or MongoDB.
 * Defaults to 'supabase' if configured or requested via DATA_BACKEND=supabase.
 */
function getActiveDataBackend() {
  const explicit = (process.env.DATA_BACKEND || '').toLowerCase();
  if (explicit === 'supabase' || explicit === 'postgres') return 'supabase';
  if (explicit === 'mongodb' || explicit === 'mongo') return 'mongodb';
  return getSupabaseConfig().isConfigured ? 'supabase' : 'mongodb';
}

module.exports = {
  getSupabaseConfig,
  isSupabaseConfigured,
  getSupabaseAdminClient,
  getSupabaseAnonClient,
  checkSupabaseHealth,
  getActiveDataBackend,
};
