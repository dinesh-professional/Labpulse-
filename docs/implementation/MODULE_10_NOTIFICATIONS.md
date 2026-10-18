# MODULE 10: NOTIFICATIONS & REAL-TIME UPDATES

**Status**: ✅ COMPLETE  
**Date**: 2026-10-12  
**Verification Battery**: 22/22 checks passed (`npm run test:notifications`)

---

## 1. Initial Implementation Findings

An architectural inspection of the repository prior to implementation revealed:
1. **Partial Data Model**: The core schema (`20261012000002_core_schema.sql`) and Mongoose model (`models/Notification.js`) contained basic fields (`userId`, `type`, `title`, `message`, `read`, `email_sent`, `email_attempts`), but lacked:
   - Target entity linkages (`entityType`, `entityId`) for actionable navigation.
   - Read timestamp tracking (`read_at` / `readAt`).
   - Deduplication / idempotency keys (`dedup_key` / `dedupKey`).
2. **Missing Outbox Queue**: The system lacked a durable transactional outbox mechanism to decouple business transaction commits from asynchronous delivery channels and external SMTP networks.
3. **Limited Endpoints**: `routes/notifications.js` only provided `GET /` and `PATCH /:id/read`. Missing endpoints included:
   - Fast unread counter (`GET /unread-count`).
   - Mark as unread (`PATCH /:id/unread`).
   - Bulk mark all as read (`POST /mark-all-read`).
   - Dismiss / delete (`DELETE /:id`).
   - Real-time event streaming (`GET /stream`).
   - Administrative queue processing (`POST /outbox/process`).
4. **Absent Frontend Shell Tray**: `dash.js` had no notification UI elements or live sync layer. The bell navigation link in the student sidebar navigated to a hash without active tray rendering.

---

## 2. Files Created or Modified

| Path | Change Type | Purpose |
| :--- | :--- | :--- |
| `supabase/migrations/20261012000007_notifications_enhancement.sql` | **Created** | Relational migration adding `entity_type`, `entity_id`, `read_at`, `dedup_key`, partial unique index, and `notification_outbox` table with RLS. |
| `models/Notification.js` | **Modified** | Added Mongoose schema fields for entity linking, read timestamp, and sparse unique `dedupKey`. |
| `models/NotificationOutbox.js` | **Created** | Mongoose transactional outbox model with status constraints and bounded retry fields. |
| `repositories/mappers.js` | **Modified** | Added `mapOutboxToApp` / `mapAppToOutbox` and updated `mapNotificationToApp` / `mapAppToNotification`. |
| `repositories/notificationRepository.js` | **Modified** | Implemented idempotent creation, read/unread status updates, unread counting, and transactional outbox operations. |
| `services/notificationService.js` | **Created** | Central notification service managing SSE client connections, channel isolation, outbox batch worker, and event broadcasting. |
| `services/notify.js` | **Modified** | Updated to support entity links, deduplication keys, and outbox mode delegation. |
| `services/templates.js` | **Modified** | Added titles and formatting for booking, instrument lifecycle, and QR access events. |
| `middleware/requireAuth.js` | **Modified** | Added support for `?token=` query parameter fallback for browser EventSource SSE connections. |
| `auth.js` | **Modified** | Exported `getAccessToken()` on `window.LabPulseAuth` for authenticating EventSource. |
| `routes/notifications.js` | **Modified** | Implemented complete REST & SSE endpoint surface with strict owner scoping. |
| `routes/bookings.js` | **Modified** | Wired `notifyBooking` with entity metadata and deduplication keys. |
| `routes/qr.js` | **Modified** | Wired check-in and revocation notifications with entity links. |
| `services/instrumentLifecycle.js` | **Modified** | Wired instrument unavailability notifications with entity links. |
| `dash.js` | **Modified** | Added notification bell icon, unread badge, dropdown tray, SSE real-time sync, and mark-read actions. |
| `scripts/verify-module-10.js` | **Created** | Acceptance verification battery covering all 22 criteria. |
| `package.json` | **Modified** | Added `test:notifications` script and integrated Module 10 into root `npm test`. |

---

## 3. Notification Schema & Event Mapping

### Schema Enhancements
```sql
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS entity_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS entity_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dedup_key VARCHAR(150);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup
  ON public.notifications (dedup_key)
  WHERE (dedup_key IS NOT NULL);
```

### Event-to-Notification Matrix

| Event Type | Producer Route / Service | Recipient | Entity Link | In-App / External |
| :--- | :--- | :--- | :--- | :--- |
| `booking-created` | `routes/bookings.js` | Reserving Student / User | `booking:<id>` | In-App + Email |
| `booking-confirmed` | `routes/bookings.js` | Reserving Student / User | `booking:<id>` | In-App + Email |
| `booking-cancelled` | `routes/bookings.js` | Reserving Student / User | `booking:<id>` | In-App + Email |
| `booking-rescheduled`| `routes/bookings.js` | Reserving Student / User | `booking:<id>` | In-App + Email |
| `booking-reminder` | `services/notificationService.js` | Reserving Student / User | `booking:<id>` | In-App + Email |
| `booking-rejected` | `routes/bookings.js` | Reserving Student / User | `booking:<id>` | In-App + Email |
| `instrument-unavailable` | `services/instrumentLifecycle.js` | Impacted Booking Holders | `instrument:<id>` | In-App + Email |
| `instrument-available` | `services/instrumentLifecycle.js` | Laboratory Technicians | `instrument:<id>` | In-App |
| `calibration-due-soon` | `routes/calibrations.js` | Faculty / Technicians | `instrument:<id>` | In-App + Email |
| `calibration-overdue` | `routes/calibrations.js` | Admin / Technicians | `instrument:<id>` | In-App + Email |
| `calibration-failed` | `routes/calibrations.js` | Admin / Technicians | `instrument:<id>` | In-App + Email |
| `maintenance-scheduled`| `routes/maintenance.js` | Technicians / Faculty | `instrument:<id>` | In-App + Email |
| `breakage-reported` | `routes/breakage.js` | Administrators | `breakage:<id>` | In-App + Email |
| `breakage-resolved` | `routes/breakage.js` | Reporting User | `breakage:<id>` | In-App + Email |
| `qr-pass-issued` | `routes/bookings.js` | Reserving Student | `qr_pass:<id>` | In-App + Pass |
| `qr-pass-revoked` | `routes/qr.js` | Reserving Student | `qr_pass:<id>` | In-App |
| `qr-check-in-success` | `routes/qr.js` | Reserving Student | `booking:<id>` | In-App |

---

## 4. Delivery, Retry & Deduplication Design

### 1. Transactional Outbox Pattern
Critical business operations write pending notification events to `notification_outbox` / `NotificationOutbox` atomically with the business state change.
- `status`: `PENDING` -> `PROCESSING` -> `COMPLETED` / `FAILED`.
- `attempts`: Incremented per execution round.
- Bounded retries: Events failing 3 times transition to `FAILED` with `last_error` recorded, preventing infinite retry loops.

### 2. Idempotency & Duplicate Suppression
- Each notification can carry a unique `dedupKey` (e.g. `booking-confirmed-<bookingId>`).
- PostgreSQL enforces uniqueness via partial unique index `idx_notifications_dedup`.
- MongoDB enforces uniqueness via sparse unique index on `dedupKey`.
- `notificationRepository.create()` catches conflict keys and returns the existing notification without creating duplicate rows or erroring.

---

## 5. API Endpoints & Permission Requirements

All endpoints are mounted at `/api/v1/notifications` and enforce active session authentication via `requireAuth`.

| Method | Endpoint | Access | Purpose & Behavior |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/notifications` | Authenticated (Own) | Paginated list of notifications for `req.user.id` (supports `page`, `limit`, `read`, `type`, `entityType`). |
| `GET` | `/api/v1/notifications/unread-count` | Authenticated (Own) | Fast scalar unread count for badge indicators. |
| `GET` | `/api/v1/notifications/stream` | Authenticated (Own) | Server-Sent Events (SSE) live connection for authenticated user. |
| `PATCH` | `/api/v1/notifications/:id/read` | Authenticated (Owner) | Marks notification as read, sets `read_at = now()`. Foreign IDs return 404. |
| `PATCH` | `/api/v1/notifications/:id/unread` | Authenticated (Owner) | Reverts notification to unread, clears `read_at`. Foreign IDs return 404. |
| `POST` | `/api/v1/notifications/mark-all-read` | Authenticated (Own) | Marks all unread notifications for `req.user.id` as read. |
| `DELETE`| `/api/v1/notifications/:id` | Authenticated (Owner) | Dismisses/deletes notification. Foreign IDs return 404. |
| `POST` | `/api/v1/notifications/outbox/process` | Admin Only (`admin`) | Triggers batch execution of pending outbox queue. Non-admins receive 403. |

---

## 6. Real-Time Updates & Fallback Behavior

### 1. Server-Sent Events (SSE)
- Endpoint: `GET /api/v1/notifications/stream`.
- Authentication: Uses Authorization header or `?token=` query parameter with `requireAuth`.
- Isolation: Connection sockets are mapped in-memory in `services/notificationService.js` strictly by `userId`. An event for user A is dispatched only to user A's sockets.
- Heartbeat: Keepalive pings (`: keepalive\n\n`) are broadcast periodically to keep intermediate proxies from timing out.
- Socket Cleanup: `res.on('close')` removes disconnected sockets automatically.

### 2. Graceful Fallback
- If SSE is blocked by client firewalls or unsupported, `dash.js` retains a background polling sync interval (every 60 seconds) that refreshes unread counts and notifications using `window.LabPulseAuth.api`.
- Opening the notification tray immediately triggers an on-demand refresh.

---

## 7. Row Level Security (RLS) & Data Protection

- `public.notifications`:
  - `notifications_select_policy`: `user_id = auth.uid()`
  - `notifications_update_policy`: `user_id = auth.uid()`
  - `notifications_delete_policy`: `user_id = auth.uid()`
  - Direct database queries from authenticated users can only view, update, and delete their own notifications.
- `public.notification_outbox`:
  - `outbox_admin_select_policy`: Restricted to `current_user_role() = 'admin'`.
  - `outbox_admin_write_policy`: Restricted to `current_user_role() = 'admin'`.
- Token Hygiene:
  - Notifications never embed raw passwords, JWT tokens, or single-use session tokens.

---

## 8. Verification Results

Running `npm run test:notifications`:
```
╔══════════════════════════════════════════════════════════════╗
║   MODULE 10: NOTIFICATIONS & REAL-TIME UPDATES             ║
╚══════════════════════════════════════════════════════════════╝

  ✅ PASS  Relational migration 07 defines schema additions, dedup index, and outbox table
  ✅ PASS  Mongoose Notification model includes entity links, readAt, and dedupKey
  ✅ PASS  Mongoose NotificationOutbox model defined with status tracking
  ✅ PASS  Domain mappers support bidirectional conversion for notifications and outbox
  ✅ PASS  Notification repository implements complete CRUD, unread counts, and outbox operations
  ✅ PASS  Central notification service provides event dispatching, SSE streaming, and outbox worker
  ✅ PASS  Real-time SSE stream enforces strict per-user channel isolation
  ✅ PASS  Outbox worker enforces bounded retries (max 3) and records failures
  ✅ PASS  In-app notification routes mounted at /api/v1/notifications
  ✅ PASS  GET /api/v1/notifications/unread-count provides fast unread counting
  ✅ PASS  GET /api/v1/notifications/stream provides authenticated SSE real-time connection
  ✅ PASS  PATCH /:id/read and PATCH /:id/unread enforce owner scoping (foreign ID returns 404)
  ✅ PASS  POST /api/v1/notifications/mark-all-read marks all user notifications as read
  ✅ PASS  DELETE /api/v1/notifications/:id dismisses notification with owner validation
  ✅ PASS  POST /api/v1/notifications/outbox/process restricted strictly to administrators
  ✅ PASS  Event templates cover all booking, instrument lifecycle, and QR access events
  ✅ PASS  Booking operations generate notifications with entity linking and deduplication keys
  ✅ PASS  QR check-in and pass revocation dispatch user notifications
  ✅ PASS  Instrument lifecycle transitions notify affected reservation holders
  ✅ PASS  PostgreSQL RLS policies strictly enforce user notification isolation & admin outbox access
  ✅ PASS  Frontend notification center in dash.js provides unread badge, dropdown tray, and SSE listener
  ✅ PASS  Frontend API client hygiene: zero raw fetch in dash.js (LabPulseAuth used exclusively)

══════════════════════════════════════════════════════════════
  Module 10 Verification: 22 PASS / 0 FAIL / 0 SKIP
══════════════════════════════════════════════════════════════
```

Running full suite `npm test`: **All 19 acceptance batteries and smoke test suites passed cleanly**.

---

## 9. Known Limitations & Deployment Requirements

1. **Email Provider Configuration**:
   - `services/email.js` defaults to the in-memory development outbox unless `EMAIL_PROVIDER=smtp` and standard SMTP environment variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) are configured.
2. **Supabase Realtime vs. SSE**:
   - The platform supports both Server-Sent Events (SSE) via the Express API server and Supabase Realtime publication on `public.notifications`. When deploying in purely serverless Express environments where long-lived HTTP streams are buffered, Supabase Realtime or 60s controlled polling serves as the transport.

---

## 10. Manual Verification Instructions

1. **Start Server**:
   ```bash
   npm start
   ```
2. **Inspect SSE Stream**:
   Log in to obtain a bearer token, then connect to the event stream:
   ```bash
   curl -N -H "Authorization: Bearer <TOKEN>" http://localhost:5000/api/v1/notifications/stream
   ```
3. **Verify Unread Count & Mark Read**:
   ```bash
   curl -H "Authorization: Bearer <TOKEN>" http://localhost:5000/api/v1/notifications/unread-count
   curl -X POST -H "Authorization: Bearer <TOKEN>" http://localhost:5000/api/v1/notifications/mark-all-read
   ```
4. **UI Notification Tray**:
   - Log into `student.html`, `faculty.html`, or `admin.html`.
   - Click the bell icon in the top-right navigation bar to view the animated dropdown tray, unread indicators, and relative timestamps.

---

## 11. Checklist for Module 11 (Audit Logging & Compliance)

- [ ] Audit log schema records actor, action, resource, timestamp, and IP metadata.
- [ ] Strict append-only guarantees enforced via PostgreSQL RLS (no UPDATE or DELETE policies).
- [ ] Exportable compliance reports for regulatory inspections.
- [ ] Retention policy and partition/archival strategy documented.
