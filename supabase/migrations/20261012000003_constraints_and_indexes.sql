-- ==============================================================================
-- LabPulse Supabase Migration: 03_constraints_and_indexes.sql
-- Module 05: Exclusion Constraints, Relational Integrity & Performance Indexes
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Database-Enforced Exclusion Constraints (Concurrency Protection)
-- ------------------------------------------------------------------------------

-- Bookings: ACTIVE reservations ('CONFIRMED', 'CHECKED_IN') must NEVER overlap
-- on the same instrument. Uses half-open [start_at, end_at) intervals.
-- Cancelled and completed bookings release their timeslots automatically.
ALTER TABLE public.bookings
  ADD CONSTRAINT active_booking_no_overlap
  EXCLUDE USING gist (
    instrument_id WITH =,
    booking_interval WITH &&
  ) WHERE (status IN ('CONFIRMED', 'CHECKED_IN', 'PENDING_APPROVAL'));
-- Module 05 baseline: WHERE (status IN ('CONFIRMED', 'CHECKED_IN'))

-- Schedules: SCHEDULED classes in the same laboratory must not overlap.
ALTER TABLE public.schedules
  ADD CONSTRAINT active_schedule_no_overlap
  EXCLUDE USING gist (
    laboratory_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status = 'SCHEDULED');

-- ------------------------------------------------------------------------------
-- 2. Query Performance Indexes
-- ------------------------------------------------------------------------------

-- Profiles
CREATE INDEX IF NOT EXISTS idx_profiles_role_active ON public.profiles(role, is_active);
CREATE INDEX IF NOT EXISTS idx_profiles_student_id ON public.profiles(student_id);

-- Laboratories
CREATE INDEX IF NOT EXISTS idx_laboratories_status ON public.laboratories(status);
CREATE INDEX IF NOT EXISTS idx_laboratories_name ON public.laboratories(name);

-- Instruments
CREATE INDEX IF NOT EXISTS idx_instruments_laboratory_status ON public.instruments(laboratory_id, status);
CREATE INDEX IF NOT EXISTS idx_instruments_category_status ON public.instruments(category, status);
CREATE INDEX IF NOT EXISTS idx_instruments_next_calibration ON public.instruments(next_calibration_due);

-- Schedules
CREATE INDEX IF NOT EXISTS idx_schedules_laboratory_date ON public.schedules(laboratory_id, date, status);
CREATE INDEX IF NOT EXISTS idx_schedules_faculty_date ON public.schedules(faculty_id, date);
CREATE INDEX IF NOT EXISTS idx_schedules_time_range ON public.schedules(start_at, end_at);

-- Bookings
CREATE INDEX IF NOT EXISTS idx_bookings_instrument_time ON public.bookings(instrument_id, start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_user_status ON public.bookings(user_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_date_status ON public.bookings(date, status);

-- Calibrations
CREATE INDEX IF NOT EXISTS idx_calibrations_instrument_date ON public.calibrations(instrument_id, date, status);
CREATE INDEX IF NOT EXISTS idx_calibrations_technician ON public.calibrations(technician_id);

-- Maintenance
CREATE INDEX IF NOT EXISTS idx_maintenance_instrument_status ON public.maintenance(instrument_id, status, start_date);
CREATE INDEX IF NOT EXISTS idx_maintenance_dates ON public.maintenance(start_date, end_date);

-- Breakage Reports
CREATE INDEX IF NOT EXISTS idx_breakage_instrument_status ON public.breakage_reports(instrument_id, status);
CREATE INDEX IF NOT EXISTS idx_breakage_reported_by ON public.breakage_reports(reported_by);

-- Notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications(user_id, read, created_at DESC);

-- QR Access Passes
CREATE INDEX IF NOT EXISTS idx_qr_booking_status ON public.qr_access_passes(booking_id, status);
CREATE INDEX IF NOT EXISTS idx_qr_expires_at ON public.qr_access_passes(expires_at);
CREATE INDEX IF NOT EXISTS idx_qr_status ON public.qr_access_passes(status);

-- Operator Qualifications
CREATE INDEX IF NOT EXISTS idx_qualifications_user_instrument ON public.operator_qualifications(user_id, instrument_id);
CREATE INDEX IF NOT EXISTS idx_qualifications_status_expires ON public.operator_qualifications(status, expires_at);

-- Audit Logs
CREATE INDEX IF NOT EXISTS idx_audit_user_created ON public.audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_resource ON public.audit_logs(action, resource, created_at DESC);
