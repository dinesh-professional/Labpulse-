-- ==============================================================================
-- LabPulse Supabase Migration: 08_user_qualifications_membership.sql
-- Module 12: User Management, Laboratory Memberships & Operator Qualifications
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Laboratory Memberships
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.laboratory_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  laboratory_id UUID NOT NULL REFERENCES public.laboratories(id) ON DELETE CASCADE,
  role VARCHAR(40) NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER', 'MANAGER', 'PI', 'SUPERVISOR')),
  assigned_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_laboratory_membership UNIQUE (user_id, laboratory_id)
);

CREATE INDEX IF NOT EXISTS idx_lab_memberships_user ON public.laboratory_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_lab_memberships_lab ON public.laboratory_memberships (laboratory_id);

-- Enable RLS
ALTER TABLE public.laboratory_memberships ENABLE ROW LEVEL SECURITY;

-- Policies for laboratory_memberships
DROP POLICY IF EXISTS "Users can view own lab memberships" ON public.laboratory_memberships;
CREATE POLICY "Users can view own lab memberships"
  ON public.laboratory_memberships
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid() OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'faculty'))
  );

DROP POLICY IF EXISTS "Admins can manage lab memberships" ON public.laboratory_memberships;
CREATE POLICY "Admins can manage lab memberships"
  ON public.laboratory_memberships
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ------------------------------------------------------------------------------
-- 2. Enhance Operator Qualifications Table
-- ------------------------------------------------------------------------------
-- Add additional evidence and lifecycle columns if they don't exist
ALTER TABLE public.operator_qualifications
  ADD COLUMN IF NOT EXISTS evidence_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS evidence_notes TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS revocation_reason TEXT,
  ADD COLUMN IF NOT EXISTS category VARCHAR(100);

-- Update status check constraint to include REJECTED and REVOKED
DO $$
BEGIN
  ALTER TABLE public.operator_qualifications
    DROP CONSTRAINT IF EXISTS operator_qualifications_status_check;
  ALTER TABLE public.operator_qualifications
    ADD CONSTRAINT operator_qualifications_status_check
    CHECK (status IN ('ACTIVE', 'EXPIRED', 'SUSPENDED', 'PENDING', 'REJECTED', 'REVOKED'));
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_qualifications_status_user ON public.operator_qualifications (status, user_id);
CREATE INDEX IF NOT EXISTS idx_qualifications_inst ON public.operator_qualifications (instrument_id);

-- Enable RLS on operator_qualifications
ALTER TABLE public.operator_qualifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own qualifications" ON public.operator_qualifications;
CREATE POLICY "Users can view own qualifications"
  ON public.operator_qualifications
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid() OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'faculty'))
  );

DROP POLICY IF EXISTS "Admins and Faculty can manage qualifications" ON public.operator_qualifications;
CREATE POLICY "Admins and Faculty can manage qualifications"
  ON public.operator_qualifications
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'faculty'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'faculty'))
  );
