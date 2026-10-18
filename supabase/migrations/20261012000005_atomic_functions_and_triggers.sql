-- ==============================================================================
-- LabPulse Supabase Migration: 05_atomic_functions_and_triggers.sql
-- Module 05: Atomic Transaction Functions and Database Triggers
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Automatic updated_at Triggers on Mutable Tables
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'profiles', 'laboratories', 'instruments', 'schedules',
    'bookings', 'calibrations', 'maintenance', 'breakage_reports',
    'qr_access_passes', 'operator_qualifications'
  ])
  LOOP
    EXECUTE format('
      DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I;
      CREATE TRIGGER trg_%I_updated_at
      BEFORE UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.set_current_timestamp_updated_at();
    ', t, t, t, t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- 2. Atomic QR Pass Redemption Procedure
-- ------------------------------------------------------------------------------
-- Enforces concurrency-safe single-use redemption using row-level locking (FOR UPDATE).
-- Atomically transitions pass to USED, marks booking CHECKED_IN, and writes an audit log.
CREATE OR REPLACE FUNCTION public.redeem_qr_pass(
  p_token_hash VARCHAR,
  p_operator_id UUID DEFAULT auth.uid()
)
RETURNS JSONB AS $$
DECLARE
  v_pass RECORD;
  v_booking RECORD;
BEGIN
  -- 1. Lock the QR pass record to prevent concurrent double-redemption
  SELECT * INTO v_pass
  FROM public.qr_access_passes
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_TOKEN', 'message', 'Access pass does not exist.');
  END IF;

  IF v_pass.status != 'ACTIVE' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_USED', 'message', 'Access pass has already been redeemed or revoked.');
  END IF;

  IF v_pass.expires_at < now() THEN
    UPDATE public.qr_access_passes SET status = 'EXPIRED' WHERE id = v_pass.id;
    RETURN jsonb_build_object('success', false, 'error', 'EXPIRED', 'message', 'Access pass has expired.');
  END IF;

  -- 2. Lock and update the associated booking
  SELECT * INTO v_booking
  FROM public.bookings
  WHERE id = v_pass.booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'BOOKING_NOT_FOUND', 'message', 'Associated reservation not found.');
  END IF;

  IF v_booking.status != 'CONFIRMED' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_BOOKING_STATE', 'message', 'Booking is not in confirmed state.');
  END IF;

  -- 3. Atomic transition
  UPDATE public.qr_access_passes
  SET status = 'USED',
      checked_in_at = now()
  WHERE id = v_pass.id;

  UPDATE public.bookings
  SET status = 'CHECKED_IN'
  WHERE id = v_booking.id;

  -- 4. Audit log entry
  INSERT INTO public.audit_logs (user_id, action, resource, resource_id, details)
  VALUES (
    p_operator_id,
    'QR_CHECKED_IN',
    'Booking',
    v_booking.id::text,
    jsonb_build_object('pass_id', v_pass.id, 'instrument_id', v_booking.instrument_id, 'user_id', v_booking.user_id)
  );

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Check-in confirmed successfully.',
    'booking_id', v_booking.id,
    'instrument_id', v_booking.instrument_id,
    'checked_in_at', now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ------------------------------------------------------------------------------
-- 3. Atomic Booking Cancellation Procedure
-- ------------------------------------------------------------------------------
-- Cancels a booking, revokes active QR passes, and records an audit event.
CREATE OR REPLACE FUNCTION public.cancel_booking_atomic(
  p_booking_id UUID,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS JSONB AS $$
DECLARE
  v_booking RECORD;
  v_role VARCHAR;
BEGIN
  -- Obtain caller's authoritative role
  SELECT role INTO v_role FROM public.profiles WHERE id = p_user_id;

  -- Lock the booking row
  SELECT * INTO v_booking
  FROM public.bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND', 'message', 'Booking not found.');
  END IF;

  -- Authorization check: user must own the booking OR be faculty/admin
  IF v_booking.user_id != p_user_id AND COALESCE(v_role, '') NOT IN ('faculty', 'admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Insufficient permissions to cancel this reservation.');
  END IF;

  IF v_booking.status = 'CANCELLED' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_CANCELLED', 'message', 'Booking is already cancelled.');
  END IF;

  IF v_booking.status NOT IN ('CONFIRMED', 'CHECKED_IN') THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_STATE', 'message', 'Completed bookings cannot be cancelled.');
  END IF;

  -- Transition booking status to CANCELLED (releases timeslot under GiST exclusion constraint)
  UPDATE public.bookings
  SET status = 'CANCELLED'
  WHERE id = p_booking_id;

  -- Revoke any active QR access passes for this reservation
  UPDATE public.qr_access_passes
  SET status = 'REVOKED'
  WHERE booking_id = p_booking_id AND status = 'ACTIVE';

  -- Audit log entry
  INSERT INTO public.audit_logs (user_id, action, resource, resource_id, details)
  VALUES (
    p_user_id,
    'BOOKING_CANCELLED',
    'Booking',
    p_booking_id::text,
    jsonb_build_object('cancelled_by', p_user_id, 'instrument_id', v_booking.instrument_id)
  );

  RETURN jsonb_build_object('success', true, 'message', 'Booking cancelled successfully.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ------------------------------------------------------------------------------
-- 4. Auth User Profile Auto-Creation Trigger
-- ------------------------------------------------------------------------------
-- Automatically provisions a matching public.profiles row when a new user registers.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER AS $$
DECLARE
  v_name VARCHAR(120);
  v_role VARCHAR(20);
BEGIN
  -- Safe defaults from user metadata (never trust client-supplied admin/faculty roles)
  v_name := COALESCE((NEW.raw_user_meta_data->>'name')::varchar, 'LabPulse User');
  v_role := 'student'; -- Always default public signups to student role

  INSERT INTO public.profiles (
    id,
    name,
    email,
    role,
    department,
    student_id,
    is_active,
    email_verified
  )
  VALUES (
    NEW.id,
    v_name,
    LOWER(NEW.email),
    v_role,
    (NEW.raw_user_meta_data->>'department')::varchar,
    (NEW.raw_user_meta_data->>'studentId')::varchar,
    true,
    COALESCE((NEW.raw_user_meta_data->>'email_verified')::boolean, false)
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Attach trigger to auth.users if available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'auth' AND tablename = 'users') THEN
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
  END IF;
END $$;
