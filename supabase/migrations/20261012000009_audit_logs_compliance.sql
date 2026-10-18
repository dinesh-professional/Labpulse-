-- ==============================================================================
-- LabPulse Supabase Migration: 09_audit_logs_compliance.sql
-- Module 13: Audit Logs & Compliance Reporting Architecture
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Schema Enhancements on public.audit_logs
-- ------------------------------------------------------------------------------
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS actor_role VARCHAR(50),
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS'
    CHECK (status IN ('SUCCESS', 'FAILURE', 'DENIED')),
  ADD COLUMN IF NOT EXISTS laboratory_id UUID REFERENCES public.laboratories(id) ON DELETE SET NULL;

-- ------------------------------------------------------------------------------
-- 2. Query Optimization & Governance Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON public.audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
  ON public.audit_logs (action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
  ON public.audit_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_created
  ON public.audit_logs (resource, resource_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_lab_created
  ON public.audit_logs (laboratory_id, created_at DESC)
  WHERE laboratory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_status_created
  ON public.audit_logs (status, created_at DESC);

-- ------------------------------------------------------------------------------
-- 3. Immutability Hardening (Strict Append-Only Invariant)
-- ------------------------------------------------------------------------------
-- Ensure Row Level Security remains strictly enforced
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke any theoretical UPDATE or DELETE privileges from client roles
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM authenticated, anon, public;

-- Policy reaffirmation: Only administrators can read audit logs
DROP POLICY IF EXISTS "audit_logs_select_policy" ON public.audit_logs;
CREATE POLICY "audit_logs_select_policy" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

-- System & authenticated sessions can append audit rows (with self-actor check)
DROP POLICY IF EXISTS "audit_logs_insert_policy" ON public.audit_logs;
CREATE POLICY "audit_logs_insert_policy" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id IS NULL OR user_id = auth.uid());

-- NOTE: STRICT IMMUTABILITY
-- No UPDATE or DELETE policies are created for audit_logs.
-- Direct table modifications are rejected by PostgreSQL engine policy.
