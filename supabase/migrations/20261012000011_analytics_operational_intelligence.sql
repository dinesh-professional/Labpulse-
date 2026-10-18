-- ==============================================================================
-- LabPulse Supabase Migration: 11_analytics_operational_intelligence.sql
-- Module 15: Analytics & Operational Intelligence Query Optimization Indexes
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Bookings Time-Series & Utilization Composite Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bookings_analytics_date_status
  ON public.bookings (date, status);

CREATE INDEX IF NOT EXISTS idx_bookings_analytics_inst_date_status
  ON public.bookings (instrument_id, date, status);

-- ------------------------------------------------------------------------------
-- 2. Maintenance History & Downtime Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_maintenance_analytics_start_type
  ON public.maintenance (start_date, type, status);

-- ------------------------------------------------------------------------------
-- 3. Calibration Compliance & Result Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_calibrations_analytics_date_status_result
  ON public.calibrations (date, status, result);

-- ------------------------------------------------------------------------------
-- 4. Equipment Breakage Incident Trend Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_breakage_analytics_created_severity_status
  ON public.breakage_reports (created_at DESC, severity, status);

-- ------------------------------------------------------------------------------
-- 5. Terminal QR Access Redemption Metrics Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_qr_analytics_status_created
  ON public.qr_access_passes (status, created_at DESC);

-- ------------------------------------------------------------------------------
-- 6. Operator Qualifications Compliance Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_qualifications_analytics_status_expires
  ON public.operator_qualifications (status, expires_at);

