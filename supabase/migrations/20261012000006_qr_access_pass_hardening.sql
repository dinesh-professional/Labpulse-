-- ==============================================================================
-- LabPulse Supabase Migration: 06_qr_access_pass_hardening.sql
-- Module 09: QR Access Pass Security Hardening
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. RLS Write Policies for QR Access Passes
-- ------------------------------------------------------------------------------
-- INSERT: Only the service_role (backend) creates passes. Authenticated users
-- cannot directly insert passes — issuance flows through the API.
-- However, the Express backend uses service_role key, so RLS INSERT is
-- permissive for service_role (already granted) and restricted for others.

-- Allow authenticated users to insert passes only for their own bookings
-- (fallback safety — primary issuance is via service_role backend).
CREATE POLICY "qr_passes_insert_policy" ON public.qr_access_passes
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = qr_access_passes.booking_id
        AND b.user_id = auth.uid()
        AND b.status = 'CONFIRMED'
    )
  );

-- Allow authenticated users to update only passes linked to their own bookings.
-- Admin/Faculty can update any pass (for revocation at kiosk/terminal).
CREATE POLICY "qr_passes_update_policy" ON public.qr_access_passes
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = qr_access_passes.booking_id
        AND (b.user_id = auth.uid() OR public.current_user_role() IN ('admin', 'faculty'))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = qr_access_passes.booking_id
        AND (b.user_id = auth.uid() OR public.current_user_role() IN ('admin', 'faculty'))
    )
  );

-- ------------------------------------------------------------------------------
-- 2. Partial Unique Index: Only ONE active pass per booking
-- ------------------------------------------------------------------------------
-- Prevents accidental double-issuance while allowing historical REVOKED/USED/EXPIRED rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qr_one_active_per_booking
  ON public.qr_access_passes (booking_id)
  WHERE (status = 'ACTIVE');

-- ------------------------------------------------------------------------------
-- 3. Pass Expiry Cleanup Function (Optional scheduled job)
-- ------------------------------------------------------------------------------
-- Bulk-expire passes that have passed their expiration time but remain ACTIVE.
-- Designed to be called by pg_cron or an application-level scheduler.
CREATE OR REPLACE FUNCTION public.expire_stale_qr_passes()
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.qr_access_passes
  SET status = 'EXPIRED'
  WHERE status = 'ACTIVE'
    AND expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
