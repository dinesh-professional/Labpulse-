-- ==============================================================================
-- LabPulse Supabase Migration: 01_extensions_and_prerequisites.sql
-- Module 05: Database Architecture Foundation
-- ==============================================================================

-- 1. Enable required PostgreSQL extensions
-- uuid-ossp: standard UUID v4 generation utilities
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- pgcrypto: cryptographic hashing utilities (digest, hmac)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- btree_gist: MANDATORY for multicolumn exclusion constraints combining scalar
-- types (UUID, VARCHAR) with range types (tstzrange) using GiST indexes.
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- 2. Mock auth schema if running outside full Supabase Cloud/local environment
-- This guarantees standalone reproducibility in any standard PostgreSQL instance.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    CREATE SCHEMA auth;
  END IF;
END $$;

-- Create minimal auth.users stub if not present in the runtime environment
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE,
  raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
  raw_app_meta_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Utility function for automatic updated_at timestamp maintenance
CREATE OR REPLACE FUNCTION public.set_current_timestamp_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
