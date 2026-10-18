-- ==============================================================================
-- LabPulse Supabase Migration: 02_core_schema.sql
-- Module 05: Core Relational Schema Definition
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Profiles (Application Users mapped to auth.users)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  role VARCHAR(20) NOT NULL DEFAULT 'student' CHECK (role IN ('admin', 'faculty', 'student')),
  department VARCHAR(120),
  faculty_id VARCHAR(60) UNIQUE,
  student_id VARCHAR(60),
  year VARCHAR(20),
  section VARCHAR(20),
  is_active BOOLEAN NOT NULL DEFAULT true,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 2. Laboratories
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.laboratories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(160) NOT NULL,
  department VARCHAR(120),
  building VARCHAR(120),
  room_number VARCHAR(40),
  capacity INTEGER CHECK (capacity >= 0 AND capacity <= 10000),
  status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'UNAVAILABLE', 'UNDER_MAINTENANCE', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 3. Instruments
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instruments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  laboratory_id UUID REFERENCES public.laboratories(id) ON DELETE SET NULL,
  name VARCHAR(160) NOT NULL,
  category VARCHAR(80) NOT NULL,
  model VARCHAR(120),
  serial_number VARCHAR(80) NOT NULL UNIQUE,
  status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'IN_SESSION', 'UNDER_CALIBRATION', 'UNDER_MAINTENANCE', 'OUT_OF_ORDER', 'LOCKED')),
  breakage_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (breakage_fee >= 0),
  required_qualification_level INTEGER NOT NULL DEFAULT 0 CHECK (required_qualification_level >= 0 AND required_qualification_level <= 4),
  last_calibration_date TIMESTAMPTZ,
  next_calibration_due TIMESTAMPTZ,
  calibration_frequency_days INTEGER CHECK (calibration_frequency_days >= 0 AND calibration_frequency_days <= 3650),
  lifecycle_state VARCHAR(30) NOT NULL DEFAULT 'COMMISSIONED' CHECK (lifecycle_state IN ('COMMISSIONED', 'DECOMMISSIONED', 'RETIRED', 'DISPOSED')),
  asset_tag VARCHAR(80),
  manufacturer VARCHAR(120),
  location VARCHAR(160),
  responsible_person VARCHAR(160),
  installation_date DATE,
  decommissioned_date DATE,
  operational_restrictions TEXT,
  unavailability_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 4. Schedules (Curriculum-level laboratory teaching sessions)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  degree VARCHAR(120) NOT NULL,
  department VARCHAR(120) NOT NULL,
  year VARCHAR(20) NOT NULL,
  section VARCHAR(20) NOT NULL,
  subject VARCHAR(160) NOT NULL,
  laboratory_id UUID NOT NULL REFERENCES public.laboratories(id) ON DELETE RESTRICT,
  faculty_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'CANCELLED', 'COMPLETED')),
  session_type VARCHAR(60),
  student_count INTEGER CHECK (student_count >= 0 AND student_count <= 10000),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_time_order CHECK (end_at > start_at),
  CONSTRAINT schedule_time_clock_order CHECK (end_time > start_time)
);

-- ------------------------------------------------------------------------------
-- 5. Bookings (Free student / faculty instrument reservations)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id UUID NOT NULL REFERENCES public.instruments(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  booking_interval TSTZRANGE GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  purpose VARCHAR(500) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED', 'CHECKED_IN', 'COMPLETED', 'PENDING_APPROVAL', 'REJECTED', 'NO_SHOW')),
  -- Module 05 baseline: CHECK (status IN ('CONFIRMED', 'CANCELLED', 'CHECKED_IN', 'COMPLETED'))
  idempotency_key VARCHAR(120),
  approval_notes VARCHAR(500),
  rejection_reason VARCHAR(500),
  approved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_time_order CHECK (end_at > start_at),
  CONSTRAINT booking_time_clock_order CHECK (end_time > start_time)
);

-- ------------------------------------------------------------------------------
-- 6. Calibrations (Instrument quality and metrology calibration logs)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.calibrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id UUID NOT NULL REFERENCES public.instruments(id) ON DELETE RESTRICT,
  technician_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  calibration_type VARCHAR(120) NOT NULL,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  standard VARCHAR(160),
  status VARCHAR(40) NOT NULL DEFAULT 'CALIBRATION_SCHEDULED' CHECK (status IN (
    'CALIBRATED', 'CALIBRATION_DUE', 'CALIBRATION_SCHEDULED',
    'UNDER_CALIBRATION', 'CALIBRATION_OVERDUE', 'CERTIFICATE_PENDING'
  )),
  result VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (result IN ('PASSED', 'FAILED', 'PENDING')),
  performed_date DATE,
  reference_standard VARCHAR(160),
  certificate_number VARCHAR(120),
  drift VARCHAR(120),
  tolerance VARCHAR(120),
  certificate_url VARCHAR(500),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT calibration_time_order CHECK (end_at > start_at)
);

-- ------------------------------------------------------------------------------
-- 7. Maintenance (Preventive and corrective maintenance records)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.maintenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id UUID NOT NULL REFERENCES public.instruments(id) ON DELETE RESTRICT,
  technician_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  type VARCHAR(30) NOT NULL CHECK (type IN ('preventive', 'corrective')),
  description TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  start_time VARCHAR(5),
  end_time VARCHAR(5),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  status VARCHAR(30) NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  requires_calibration BOOLEAN NOT NULL DEFAULT false,
  work_performed TEXT,
  parts_replaced TEXT,
  resolution_notes TEXT,
  resolved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 8. Breakage Reports (Incident reports and confirmed damage fee tracking)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.breakage_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id UUID NOT NULL REFERENCES public.instruments(id) ON DELETE RESTRICT,
  reported_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  issue_type VARCHAR(120) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  description TEXT NOT NULL,
  evidence TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED', 'UNDER_REVIEW', 'CONFIRMED', 'REJECTED', 'RESOLVED')),
  breakage_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (breakage_fee >= 0),
  admin_reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  maintenance_id UUID REFERENCES public.maintenance(id) ON DELETE SET NULL,
  resolution_notes TEXT,
  return_to_service_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  return_to_service_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 9. Notifications (User in-app notifications and delivery status)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type VARCHAR(80) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  email_sent BOOLEAN NOT NULL DEFAULT false,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  email_error VARCHAR(500),
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 10. QR Access Passes (Single-use redemption passes linked to bookings)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.qr_access_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  checked_in_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 11. Operator Qualifications (User training and instrument qualification tiers)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.operator_qualifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  instrument_id UUID REFERENCES public.instruments(id) ON DELETE SET NULL,
  scope VARCHAR(160),
  level INTEGER NOT NULL CHECK (level >= 1 AND level <= 4),
  certified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  certified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'SUSPENDED', 'PENDING')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_instrument_qualification UNIQUE (user_id, instrument_id)
);

-- ------------------------------------------------------------------------------
-- 12. Audit Logs (Append-only audit trail for compliance and tracking)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action VARCHAR(120) NOT NULL,
  resource VARCHAR(120) NOT NULL,
  resource_id VARCHAR(120),
  details JSONB,
  ip_address VARCHAR(80),
  user_agent VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
