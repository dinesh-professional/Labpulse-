-- ==============================================================================
-- LabPulse Supabase Migration: 04_row_level_security.sql
-- Module 05: Row Level Security Policies and Database Role Grants
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Helper Function: Authenticated Role Resolution (Security Definer)
-- ------------------------------------------------------------------------------
-- Fetches the authoritative application role from public.profiles.
-- Fixed search_path prevents search_path injection attacks.
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS VARCHAR AS $$
DECLARE
  v_role VARCHAR;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  RETURN COALESCE(v_role, 'student');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Helper to check if current user is active
CREATE OR REPLACE FUNCTION public.current_user_is_active()
RETURNS BOOLEAN AS $$
DECLARE
  v_active BOOLEAN;
BEGIN
  SELECT is_active INTO v_active FROM public.profiles WHERE id = auth.uid();
  RETURN COALESCE(v_active, false);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ------------------------------------------------------------------------------
-- 2. Enable Row Level Security on Every Public Table
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.laboratories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calibrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.breakage_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_access_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- 3. Database Privilege Grants
-- ------------------------------------------------------------------------------
-- Revoke all default public permissions
REVOKE ALL ON SCHEMA public FROM public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Service role has full unrestricted administrative access
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;

-- Anon and Authenticated grants (controlled by RLS policies)
GRANT SELECT ON public.laboratories, public.instruments TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.profiles, public.bookings, public.breakage_reports,
  public.notifications, public.operator_qualifications, public.qr_access_passes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.schedules, public.calibrations, public.maintenance TO authenticated;
GRANT SELECT, INSERT ON public.audit_logs TO authenticated;

-- ------------------------------------------------------------------------------
-- 4. RLS Policies: Profiles
-- ------------------------------------------------------------------------------
-- Users can read their own profile; Admins and Faculty can view all profiles for institutional operations.
CREATE POLICY "profiles_select_policy" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid() OR
    public.current_user_role() IN ('admin', 'faculty')
  );

-- Users can update basic personal details, but CANNOT self-escalate role or isActive status.
CREATE POLICY "profiles_update_self_policy" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid() AND
    role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid()) AND
    is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = auth.uid())
  );

-- Administrators have full management rights over profiles
CREATE POLICY "profiles_admin_all_policy" ON public.profiles
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- ------------------------------------------------------------------------------
-- 5. RLS Policies: Laboratories
-- ------------------------------------------------------------------------------
-- Laboratories catalog is visible to public visitors and authenticated users
CREATE POLICY "laboratories_select_policy" ON public.laboratories
  FOR SELECT TO anon, authenticated
  USING (true);

-- Modifications restricted strictly to Administrators
CREATE POLICY "laboratories_admin_write_policy" ON public.laboratories
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- ------------------------------------------------------------------------------
-- 6. RLS Policies: Instruments
-- ------------------------------------------------------------------------------
-- Catalog instruments visible unless marked LOCKED
CREATE POLICY "instruments_select_policy" ON public.instruments
  FOR SELECT TO anon, authenticated
  USING (status != 'LOCKED' OR public.current_user_role() = 'admin');

-- Instrument modifications restricted to Administrators
CREATE POLICY "instruments_admin_write_policy" ON public.instruments
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- ------------------------------------------------------------------------------
-- 7. RLS Policies: Schedules
-- ------------------------------------------------------------------------------
-- All authenticated users can view class schedules
CREATE POLICY "schedules_select_policy" ON public.schedules
  FOR SELECT TO authenticated
  USING (true);

-- Faculty can manage their own class schedules; Admins can manage any schedule
CREATE POLICY "schedules_faculty_write_policy" ON public.schedules
  FOR ALL TO authenticated
  USING (faculty_id = auth.uid() OR public.current_user_role() = 'admin')
  WITH CHECK (faculty_id = auth.uid() OR public.current_user_role() = 'admin');

-- ------------------------------------------------------------------------------
-- 8. RLS Policies: Bookings
-- ------------------------------------------------------------------------------
-- Students read own bookings; Faculty and Admins can view laboratory reservations
CREATE POLICY "bookings_select_policy" ON public.bookings
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid() OR
    public.current_user_role() IN ('admin', 'faculty')
  );

-- Authenticated active users can create reservations for themselves only
CREATE POLICY "bookings_insert_policy" ON public.bookings
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid() AND
    public.current_user_is_active() = true
  );

-- Users can cancel their own CONFIRMED bookings; Admins have full management
CREATE POLICY "bookings_update_policy" ON public.bookings
  FOR UPDATE TO authenticated
  USING (
    (user_id = auth.uid() AND status = 'CONFIRMED') OR
    public.current_user_role() IN ('admin', 'faculty')
  )
  WITH CHECK (
    (user_id = auth.uid() AND status IN ('CONFIRMED', 'CANCELLED')) OR
    public.current_user_role() IN ('admin', 'faculty')
  );

-- ------------------------------------------------------------------------------
-- 9. RLS Policies: Calibrations & Maintenance
-- ------------------------------------------------------------------------------
CREATE POLICY "calibrations_select_policy" ON public.calibrations
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "calibrations_write_policy" ON public.calibrations
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'faculty'))
  WITH CHECK (public.current_user_role() IN ('admin', 'faculty'));

CREATE POLICY "maintenance_select_policy" ON public.maintenance
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "maintenance_write_policy" ON public.maintenance
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('admin', 'faculty'))
  WITH CHECK (public.current_user_role() IN ('admin', 'faculty'));

-- ------------------------------------------------------------------------------
-- 10. RLS Policies: Breakage Reports
-- ------------------------------------------------------------------------------
-- Users can view their own reported breakages; Admins and Faculty can triage all reports
CREATE POLICY "breakage_select_policy" ON public.breakage_reports
  FOR SELECT TO authenticated
  USING (
    reported_by = auth.uid() OR
    public.current_user_role() IN ('admin', 'faculty')
  );

-- Users can submit breakage reports
CREATE POLICY "breakage_insert_policy" ON public.breakage_reports
  FOR INSERT TO authenticated
  WITH CHECK (reported_by = auth.uid());

-- Triage, fee setting, and resolution are restricted strictly to Administrators
CREATE POLICY "breakage_admin_update_policy" ON public.breakage_reports
  FOR UPDATE TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- ------------------------------------------------------------------------------
-- 11. RLS Policies: Notifications
-- ------------------------------------------------------------------------------
-- Strictly private: users cannot read, mark read, or delete another user's notifications
CREATE POLICY "notifications_select_policy" ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "notifications_update_policy" ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "notifications_delete_policy" ON public.notifications
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- ------------------------------------------------------------------------------
-- 12. RLS Policies: QR Access Passes
-- ------------------------------------------------------------------------------
-- Users can view QR passes linked to their own bookings
CREATE POLICY "qr_passes_select_policy" ON public.qr_access_passes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = qr_access_passes.booking_id
        AND (b.user_id = auth.uid() OR public.current_user_role() IN ('admin', 'faculty'))
    )
  );

-- ------------------------------------------------------------------------------
-- 13. RLS Policies: Operator Qualifications
-- ------------------------------------------------------------------------------
-- Users can view their own certifications; Faculty and Admins can view all qualifications
CREATE POLICY "qualifications_select_policy" ON public.operator_qualifications
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid() OR
    public.current_user_role() IN ('admin', 'faculty')
  );

-- Certifications can be issued or revoked only by Administrators
CREATE POLICY "qualifications_admin_write_policy" ON public.operator_qualifications
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- ------------------------------------------------------------------------------
-- 14. RLS Policies: Audit Logs (Append-Only)
-- ------------------------------------------------------------------------------
-- Only Administrators can read security audit logs
CREATE POLICY "audit_logs_select_policy" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

-- System & authenticated sessions can append audit rows
CREATE POLICY "audit_logs_insert_policy" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Note: NO UPDATE OR DELETE policies are created for audit_logs.
-- The audit table is strictly append-only.
