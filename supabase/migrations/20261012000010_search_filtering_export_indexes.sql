-- ==============================================================================
-- LabPulse Supabase Migration: 10_search_filtering_export_indexes.sql
-- Module 14: Search, Filtering & Data Export Query Optimization Indexes
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Instrument Discovery & Search Composite Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_instruments_search_composite
  ON public.instruments (name, model, category);

CREATE INDEX IF NOT EXISTS idx_instruments_lifecycle_status
  ON public.instruments (lifecycle_state, status);

CREATE INDEX IF NOT EXISTS idx_instruments_asset_tag
  ON public.instruments (asset_tag)
  WHERE asset_tag IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 2. Booking Search & Multi-Column Filter Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bookings_user_date_status
  ON public.bookings (user_id, date DESC, status);

CREATE INDEX IF NOT EXISTS idx_bookings_instrument_date_status
  ON public.bookings (instrument_id, date DESC, status);

CREATE INDEX IF NOT EXISTS idx_bookings_created_at_id
  ON public.bookings (created_at DESC, id DESC);

-- ------------------------------------------------------------------------------
-- 3. Maintenance & Calibration Historical Query Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_maintenance_status_dates
  ON public.maintenance (status, start_date DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_instrument_status
  ON public.maintenance (instrument_id, status);

CREATE INDEX IF NOT EXISTS idx_calibrations_status_date
  ON public.calibrations (status, date DESC);

-- ------------------------------------------------------------------------------
-- 4. Qualification Verification & Status Filters
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_operator_qualifications_user_status_expires
  ON public.operator_qualifications (user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_operator_qualifications_inst_status
  ON public.operator_qualifications (instrument_id, status);

-- ------------------------------------------------------------------------------
-- 5. Profile Directory & Identity Search Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_profiles_dept_role
  ON public.profiles (department, role);
