-- ==============================================================================
-- LabPulse Supabase Migration: 07_notifications_enhancement.sql
-- Module 10: Notifications & Real-Time Updates
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Schema Enhancements on public.notifications
-- ------------------------------------------------------------------------------
-- Add entity linking, read timestamp, and deduplication key to notifications table.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS entity_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dedup_key VARCHAR(150);

-- Partial unique index ensuring deduplication keys are globally unique when present
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup
  ON public.notifications (dedup_key)
  WHERE (dedup_key IS NOT NULL);

-- Index for fast user-specific descending timeline queries
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications (user_id, created_at DESC);

-- Index for entity-related notification lookups
CREATE INDEX IF NOT EXISTS idx_notifications_entity
  ON public.notifications (entity_type, entity_id)
  WHERE (entity_type IS NOT NULL);

-- ------------------------------------------------------------------------------
-- 2. Transactional Notification Outbox Table
-- ------------------------------------------------------------------------------
-- Outbox pattern: business operations write notification events atomically,
-- which background workers process with bounded retries and guaranteed delivery.

CREATE TABLE IF NOT EXISTS public.notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id VARCHAR(150) NOT NULL UNIQUE,
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Index for pending outbox processing queue
CREATE INDEX IF NOT EXISTS idx_outbox_queue
  ON public.notification_outbox (status, created_at ASC)
  WHERE (status IN ('PENDING', 'PROCESSING'));

-- ------------------------------------------------------------------------------
-- 3. Row Level Security for notification_outbox
-- ------------------------------------------------------------------------------
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

-- Admins can inspect the outbox delivery queue
CREATE POLICY "outbox_admin_select_policy" ON public.notification_outbox
  FOR SELECT TO authenticated
  USING (public.current_user_role() = 'admin');

-- System & service_role process and write outbox events
-- Authenticated users cannot directly manipulate the outbox queue
CREATE POLICY "outbox_admin_write_policy" ON public.notification_outbox
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- ------------------------------------------------------------------------------
-- 4. Enable Supabase Realtime on notifications table
-- ------------------------------------------------------------------------------
-- Adds notifications to supabase_realtime publication if the publication exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;
