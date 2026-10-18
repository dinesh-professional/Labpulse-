# LabPulse Changelog (architectural decisions)

## Phase 01 — Foundation + Database (2026-09-06)
- Added Node+Express+Mongoose backend alongside existing static frontend; no existing files modified.
- 12 Mongoose models per spec §14 (users → auditLogs) with validation, enums, maxlengths, indexes.
- Booking model deliberately has NO price/rate/grant fields (spec §8: booking is FREE). Instrument keeps configurable `breakageFee` only (§11).
- Server serves existing `index.html` unchanged; `/api/v1/health` reports `{status, db, time}`.
- Safe startup: app boots without DB; unreachable MongoDB logs a warning, does not crash.
- Decisions: CommonJS modules; `strictQuery=true`; UTC Dates + HH:mm strings for schedules/bookings/calibrations; QR stores `tokenHash` only.

## Phase 02 — Authentication + Email Reset (2026-09-06)
- `POST /api/v1/auth/{login,logout,refresh,forgot-password,reset-password,activate}` + `GET /api/v1/auth/me`.
- bcryptjs hashing (spec-acceptable bcrypt; pure-JS avoids native toolchain); password policy 8–128 chars.
- JWT access 15m + rotating refresh 7d via `tokenVersion`; httpOnly `lp_refresh` cookie (Secure in prod, Lax).
- Reset/activation: opaque random tokens, sha256 at rest, 1h expiry, single-use, sessions killed on reset.
- Forgot response always generic (no enumeration). Strict body allowlists; login 20/15m + sensitive 10/15m rate limits.
- Email is dev-outbox abstraction (`services/email.js`); real provider in Phase 09. No public registration.
- Prod refuses to boot on missing/weak JWT secrets; dev uses ephemeral with warning. No existing UI files modified.

## Phase 03 — RBAC + Faculty Management (2026-09-06)
- `GET/POST /api/v1/admin/faculty`, `GET/PATCH/DELETE /api/v1/admin/faculty/:id` — all Admin-only via `requireAuth + requireRole('admin')`.
- Invite flow: unusable placeholder hash, 72h activation token, `faculty-invitation` email; no plaintext passwords, no public registration.
- Guards: no self role-change/deactivation/deletion; admin accounts not manageable here; role changes limited to faculty|student; deactivation bumps `tokenVersion`.
- `utils/audit.js` records FACULTY_CREATED/UPDATED/DELETED (§19). List supports role/isActive/q/page/limit.
- Fix-audit (Phase 01 item): static serving whitelisted to `/, /index.html, /app.js, /style.css, /favicon.ico` — backend source now 404.

## Phase 04 — Laboratory Scheduling (2026-09-06)
- `GET /api/v1/schedules(+/:id)` for all authenticated roles; `POST/PATCH/DELETE` admin-any + faculty-own-only.
- `facultyId` always from auth; client-sent `facultyId` rejected. Students 403 on writes, 200 on reads.
- Gate order: shape 400 → time/date 422 → lab 404 → lab status 422 → overlap 409 `LAB_CONFLICT` (DB string-range query on zero-padded HH:mm).
- Past dates rejected; adjacent slots allowed; CANCELLED never blocks; edits re-validate (excluding self).
- Post-commit notify: `schedule-created/modified/cancelled` emails (§5 fields) + Notification rows; email failure never rolls back.
- Audit SCHEDULE_CREATED/UPDATED/DELETED. Dates UTC-midnight + HH:mm (`utils/time.js`, `utils/scheduling.js`).

## Phase 05 — Free Instrument Booking (2026-09-06)
- Backend: `POST/GET/PATCH/DELETE /api/v1/bookings` (admin-any + faculty-own; students read-only).
  Booking = instrument/user/date/times/purpose/status/QR — zero money fields, `price/rate/grant/cost` rejected 400.
- Gate chain (`utils/bookingGates.js`): status (OUT_OF_ORDER/LOCKED/UNDER_MAINT/CALIB 422) → calibration 409 →
  maintenance 409 → qualification 403 → overlap 409. Client `CHECKED_IN` rejected (terminal-only, Phase 10).
- QR pass issued per booking (opaque token once, sha256 at rest, ACTIVE; REVOKED on cancel). Confirmation/cancel
  emails + notifications; audit BOOKING_*.
- Instruments: `GET /api/v1/instruments(+/:id)` for all roles (students never see `breakageFee`);
  `GET /:id/availability?date&days`; admin CRUD with serial-unique 409 and delete-blocked-by-live-deps 409.
  New `requiredQualificationLevel` 0–4 (0 = open; admin bypass, audited).
- Frontend (first UI touch, visual language preserved): catalog rates → FREE ×6; modal grant select → purpose input;
  chargeback box → FREE badge; table GRANT/EST.COST columns → PURPOSE; `app.js` cost math removed, row template
  escaped + listener-based QR button (fixes audited XSS on touched lines). Grants section kept (grant tracking, not
   booking flow). UI still local-only; API wiring waits for login UI.

## Phase 06 — Calibration Scheduling (2026-09-06)
- `GET /api/v1/calibrations(+/:id)` all roles; `POST/PATCH` admin-only. No DELETE per §15 (records are history).
- Create validates window, technician existence, LOCKED refusal; rejects cal/booking/maintenance overlaps (409).
  Repair calibrations allowed on OUT_OF_ORDER (Phase 08 flow).
- Guarded transitions: SCHEDULED→UNDER→CALIBRATED|CERTIFICATE_PENDING→CALIBRATED (+DUE/OVERDUE recovery);
  illegal jumps 422; window edits locked after start.
- START sets instrument UNDER_CALIBRATION (scheduling alone never flips status — windows block via Phase 05 gates).
- COMPLETE stamps lastCalibrationDate, recomputes nextCalibrationDue (last + frequency), restores AVAILABLE only
  if clear — else OUT_OF_ORDER (open breakage) or UNDER_MAINTENANCE (current maintenance).
- Technician notified on schedule/complete; audit CALIBRATION_CREATED/UPDATED/COMPLETED.

## Phase 07 — Maintenance (2026-09-06)
- `GET /api/v1/maintenance(+/:id)` all roles; `POST/PATCH` admin-only. No DELETE per §15.
- Preventive/corrective with date-range windows (≤365d) + optional times; past/inverted windows rejected.
- Create/reschedule clash-scan per day vs maintenance/calibration/booking (409). Corrective allowed on
  OUT_OF_ORDER (repair flow); LOCKED always refuses.
- Guarded transitions SCHEDULED→IN_PROGRESS|CANCELLED, IN_PROGRESS→COMPLETED|CANCELLED; window locked after start.
- START sets UNDER_MAINTENANCE; COMPLETE/CANCEL restores via shared `utils/restore.js` (also refactored Phase 06
  onto it — redirects: open breakage→OUT_OF_ORDER, calibration today→UNDER_CALIBRATION, else AVAILABLE).
- `requiresCalibration` (new model field): completion raises CALIBRATION_DUE + stamps nextCalibrationDue.
  Routine maintenance never touches fees. Technician notified; audit MAINTENANCE_CREATED/UPDATED/COMPLETED.

## Phase 08 — Breakage Management (2026-09-06)
- Reporter side `POST/GET /api/v1/breakage-reports` (faculty+admin report; all roles read): reportedBy from auth,
  `reportedBy`/`breakageFee` rejected; `breakageFee` stripped for non-admins; report flips instrument OUT_OF_ORDER
  (LOCKED keeps priority) which disables booking via Phase 05 gates. Admins + reporter notified; audit.
- Admin `PATCH /api/v1/admin/breakage-reports/:id`: guarded REPORTED→UNDER_REVIEW→CONFIRMED|REJECTED;
  fee settable only on CONFIRMED (else 422); confirm stamps confirmedAt+reviewer; REJECT restores via shared
  `restoreInstrument(id,'OUT_OF_ORDER')` when no other open report holds it.
- Admin `POST .../resolve` (CONFIRMED only): RESOLVED+resolvedAt; plain repair restores if clear;
  `requiresCalibration` raises POST_REPAIR DUE + holds OOO until that calibration completes (full chain verified).
- No reporter PATCH route (404 by design). Audit BREAKAGE_REPORTED/CONFIRMED/REJECTED/RESOLVED.

## Phase 09 — Email + Notifications (2026-09-06)
- `services/email.js`: dev outbox (unchanged interface) + SMTP via nodemailer, HTML+text bodies from
  `services/templates.js` (18 events, values escaped), 3-attempt backoff retry (no retry on auth errors).
  Logs carry recipient/template/attempts only — never bodies, tokens, or credentials.
- `services/notify.js`: single funnel — one Notification row + optional email per event; never throws;
  records emailSent/emailAttempts/emailError (new model fields). All 7 route notifiers migrated onto it;
  auth now emits password-changed email and activation/invite/reset rows.
- Read side `GET /notifications` (own rows, read/type filters, unread count) + `PATCH /:id/read`
  (owner-scoped, cross-user 404). `EMAIL_PROVIDER/SMTP_*` in `.env.example`. Nodemailer added (justified: core workflow).

## Phase 10 — QR + Terminal Access (2026-09-06)
- `POST /api/v1/bookings/:id/qr` (owner/admin, CONFIRMED only): rotates passes so exactly one live token
  exists per booking; token returned once; audit QR_ISSUED. Non-confirmed → 422.
- `POST /api/v1/qr/check-in` (authenticated; owner-or-admin): hash lookup, REVOKED→410, USED→409 replay
  rejection, expiry marked+410, cancelled/gone bookings refused, 15-min early grace, post-window expiry.
  Success flips booking CHECKED_IN + pass USED/checkedInAt and returns simulated interlock
  `{power: ON, interlock: ENGAGED}` with zero sensitive leakage. Audit QR_CHECKED_IN.
- Tokens stay opaque/random/hash-at-rest. Frontend QR modal untouched (still local demo until login UI lands).

## Phase 11 — Responsive UI + Accessibility (2026-09-06)
- Mobile: full-screen menu (links + reservation) — booking is reachable on small screens; tables get
  min-width inside existing scroll containers; 44px touch targets on coarse pointers.
- A11y: skip link, `<main>` landmark, dialog/alertdialog roles, labelled modals, focus-on-open, Esc closes
  topmost layer, `:focus-visible` outlines, reduced-motion kills cursor/parallax/transitions (JS + CSS).
- `alert()` replaced by custom notice dialog on all 4 call sites (audited rule-23 conflict closed).
- Fixed in passing (audited): broken absolute hero image path (gradient-only hero), undefined `fade-in`
  keyframes, `font-mono` stack now JetBrains Mono as designed.
- `scripts/check-frontend.js` (13 checks, in `npm test`): ID/handler wiring, no-alert, money-free booking
  regression guard, asset-whitelist parity, dialog roles, landmarks, reduced motion.
- NOT done: login/role-dashboard UI was never assigned to any phase — flagged as gap.

## Phase 12 — Security + Testing (2026-09-06)
- Live verification via mongodb-memory-server (devDependency; `scripts/with-mongo.js`, `start-test-db.js`).
  Full suite green on live DB: auth 15, rbac 12, scheduling 7, booking 9, calibration 8, maintenance 7,
  breakage 6, notify 7+6, qr 7, security 17, frontend 13 (~107 checks).
- `scripts/security-audit.js`: static (secrets/hash/prod-fail-fast/envelopes) + live attacks (bypass,
  escalation, IDOR, student lockdown, reset abuse/enumeration, NoSQLi, malformed input, 10-way booking +
  schedule races, QR auth order, secret/static/error leakage, rate limits).
- Verified + fixed: schedule double-create race (10/10 wins → 1) via `utils/mutex.js` per-resource locks
  (shared instrument-day key across bookings/calibrations/maintenance; lab-day for schedules); QR
  `bookingId` unique→history index (rotation revoked-then-creates); admin self-guard ordering (400 before 403);
  malformed-JSON envelope (VALIDATION_ERROR, no parser leakage); TDZ-safe lock release + empty-body guards;
  `server.js` require.main guard (no port bind on import) + entity.parse mapping.
- Residual: single-process locks (multi-instance needs transactions); cal/maint PATCH reschedule is
  best-effort atomic; helmet/CSP/global-limiter hardening deferred to deployment.
- Gap closures (§15): `GET /laboratories(+/:id)` all roles + admin CRUD (delete blocked by live schedules);
  `/admin/qualifications` CRUD (booking gates now operable end-to-end); `GET /admin/audit-logs` (admin-only).
- `scripts/seed-admin.js`: controlled first-admin provisioning (validated, hashed, dup-refused).

## Seed data
- `scripts/seed-catalog.js` (`npm run seed:catalog`): idempotent seed of 6 laboratories + 6 prototype
  instruments (serials, categories, cert levels 1–4, calibration dates, illustrative breakage fees).
  All instruments start AVAILABLE — degraded states arise only from real workflows. Verified live.

## Phase 14 — Authentication & Role Dashboard UI (2026-09-06)
- Static stack preserved (no framework): ONE client `auth.js` (memory-only token, role strictly from
  `/auth/me`, single-flight refresh+retry, no retry loops, zero storage identity) + `dash.js` presenters.
- Public: `login.html` (validation, show/hide, loading, generic errors, double-submit guard, authed
  redirect), `forgot-password.html` (generic either way), `reset-password.html` (?token=, match+policy
  checks, invalid/expired/success states, token never logged/stored/rendered). No public signup anywhere.
- Role landings (adapted paths, same vortex system): `admin.html` (counts, faculty invite/deactivate,
  audit), `faculty.html` (my schedules CRUD, availability, free booking, breakage report, notifications),
  `student.html` (read-only timetable/instruments/notifications). Per-page `guard(role)` → login redirect
  or inline 403 block; backend remains the only authority.
- Wiring: `server.js` whitelist + login links on public page (desktop/mobile). `auth.js` navigation
  funneled via goToDashboard/goToLogin.
- Tests: `check-frontend.js` +53 checks (single client, no role-from-storage, no alert, no signup,
  money-free, per-page wiring, whitelist, token hygiene, a11y markers); `check-auth-ui.js` 15 checks
  (jsdom runtime: validation, 401, routing by backend role, 403 guard, dashboard loads; live E2E:
  per-role login routing, invalid login, guard redirect, forgot). Full backend suite re-green.
