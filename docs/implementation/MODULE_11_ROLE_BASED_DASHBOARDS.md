# MODULE 11: ROLE-BASED DASHBOARDS

**Status**: ✅ COMPLETE  
**Date**: 2026-10-12  
**Verification Battery**: 22/22 checks passed (`npm run test:dashboards`)

---

## 1. Initial Implementation Findings

An architectural inspection of the repository prior to Module 11 implementation revealed:

1. **Dashboard Shell & Layout Foundations**:
   - `student.html`, `faculty.html`, and `admin.html` were established in earlier phases with shared styling tokens from `style.css` and application shell utilities in `dash.js`.
   - The centralized navigation manifest `NAV_CONFIG` in `dash.js` correctly mapped top-level routes by role (`admin`, `faculty`, `student`).
   - Authentication route guards were mounted using `LabPulseAuth.guard(role)` to prevent unauthorized DOM rendering prior to token verification.

2. **Gaps in Dashboard Summary Metrics**:
   - The **Student Workspace** (`student.html`) had direct reservation forms and timetable tables, but lacked high-level operational summary cards summarizing active reservations, pending approvals, completed usage, and upcoming classes.
   - The **Faculty Workspace** (`faculty.html`) lacked at-a-glance cards summarizing teaching sessions, approval queue depth, personal apparatus bookings, and active breakage reports.
   - The **Admin Console** (`admin.html`) displayed 4 basic count badges loaded via four disparate API requests (`/api/v1/admin/faculty`, `/api/v1/schedules`, `/api/v1/bookings`, `/api/v1/instruments`), missing vital health metrics like pending approvals, open breakage reports, and calibration compliance.

3. **Missing Dedicated Aggregation Endpoint**:
   - No unified server-side `/api/v1/dashboard/stats` endpoint existed. Dashboards either loaded unbounded record lists to compute lengths on the client or performed multiple round-trip requests.
   - Client-side length aggregation violated performance and security boundaries, leaking row metadata across users.

4. **Visual State Deficiencies**:
   - Filter buttons (e.g., booking status filters in student and admin dashboards, instrument lifecycle filters in admin) did not maintain active visual highlighting to convey the current filter state.
   - Mutations (booking requests, cancellations, triage decisions, schedule deletions) refreshed their immediate table without synchronizing summary cards.

---

## 2. Files Created or Modified

| Path | Change Type | Purpose |
| :--- | :--- | :--- |
| `routes/dashboard.js` | **Created** | Dedicated role-scoped dashboard metrics endpoint (`GET /api/v1/dashboard/stats`) backed by domain repositories with fallback resilience. |
| `server.js` | **Modified** | Mounted `/api/v1/dashboard` route behind API routing table. |
| `student.html` | **Modified** | Added 6 semantic metric cards, active filter highlighting on booking filter buttons, parallel stats loading, and dynamic metric refreshes on booking mutations and incident reports. |
| `faculty.html` | **Modified** | Added 6 semantic metric cards, parallel stats loading, and dynamic metric refreshes on approval triage, schedule creation/cancellation, and breakage reports. |
| `admin.html` | **Modified** | Expanded overview to 8 operational metric cards, added active filter highlighting for booking and instrument filter buttons, upgraded `loadStats()` to `/api/v1/dashboard/stats`, and dynamic metric refreshes on triage actions. |
| `scripts/verify-module-11.js` | **Created** | Acceptance test suite containing 22 automated verification checks for Module 11. |
| `package.json` | **Modified** | Added `test:dashboards` script and integrated Module 11 into `npm test`. |

---

## 3. Dashboard Features by Role

### Student Dashboard (`student.html`)
- **Header & Breadcrumbs**: Contextual introduction to curriculum timetables and apparatus reservation engine.
- **Summary Metrics (6 Cards)**:
  1. *Total Bookings*: Total reservations created by the authenticated student.
  2. *Pending*: Reservations currently in `PENDING_APPROVAL` status.
  3. *Confirmed*: Approved reservations ready for lab access.
  4. *Completed*: Past utilized sessions.
  5. *Upcoming Classes*: Curriculum laboratory teaching sessions scheduled across departments.
  6. *Unread Alerts*: In-app notifications awaiting review.
- **Workflow Shortcuts & Actions**:
  - *Reserve Instrument*: Discrete available slot picker (`inspectAvailability`), duration calculations, and idempotent booking submission.
  - *My Reservations*: Filterable booking table (`ALL`, `PENDING`, `CONFIRMED`) with active button styling, cancel action, and reschedule modal.
  - *Class Schedule*: Date-filterable curriculum timetable lookup.
  - *Report Incident*: Breakage and equipment failure reporting form.
  - *QR Access Pass*: Access to generated QR passes with check-in instructions.

### Faculty Dashboard (`faculty.html`)
- **Header & Role Navigation**: Faculty workspace covering timetables, apparatus reservations, and approval queue triage.
- **Summary Metrics (6 Cards)**:
  1. *My Reservations*: Personal faculty equipment bookings.
  2. *Pending Approvals*: Active queue of student reservation requests requiring supervisor authorization.
  3. *My Schedules*: Curriculum lab teaching timetables authored by this faculty member.
  4. *Active Breakage*: Open equipment incident reports across laboratories.
  5. *Instruments*: Total commissioned laboratory instruments available for academic booking.
  6. *Unread Alerts*: In-app notifications and approval alerts.
- **Workflow Shortcuts & Actions**:
  - *Requests Queue*: Triage table with single-click `APPROVE` and prompt-driven `REJECT` actions.
  - *Class Schedules*: Teaching timetable scheduler (degree, department, year, section, lab slot) with conflict detection and cancellation.
  - *Free Apparatus Reservation*: Direct instrument reservation for research and lecture prep.
  - *Incident Reporting*: Immediate instrument degradation reporting with status transition to `OUT_OF_ORDER`.

### Admin Dashboard (`admin.html`)
- **Header & System Navigation**: System administration console for global operations, onboarding, audit, and platform metrics.
- **Summary Metrics (8 Cards)**:
  1. *Users*: Total registered accounts across the platform.
  2. *Faculty*: Active faculty members.
  3. *Schedules*: Total active laboratory curriculum timetables.
  4. *Bookings*: Total platform reservations across all statuses.
  5. *Pending*: Global backlog of reservations awaiting review.
  6. *Instruments*: Total laboratory apparatuses in inventory.
  7. *Breakage*: Open damage and malfunction reports requiring repair.
  8. *Calibrations*: Total scheduled or overdue instrument calibrations.
- **Workflow Shortcuts & Actions**:
  - *Reservation Lifecycle Oversight*: Full reservation table with filter buttons (`ALL`, `PENDING`, `CONFIRMED`, `COMPLETED`), active filter indicators, and actions (`APPROVE`, `REJECT`, `COMPLETE`, `NO-SHOW`, `CANCEL`).
  - *Faculty Management*: Onboarding form generating one-time activation tokens and account deactivation toggles.
  - *Instrument Management*: Inventory listing with lifecycle state tags, active filters (`ALL`, `AVAILABLE`, `UNDER_MAINTENANCE`, `UNDER_CALIBRATION`, `OUT_OF_ORDER`, `RETIRED`), timeline view, and affected bookings inspector.
  - *Preventive Maintenance & Calibration Schedulers*: Dedicated modal forms for scheduling maintenance downtime and metrology calibrations.
  - *System Audit Trail*: Tamper-evident audit log table displaying actor, action, timestamp, and target resource.

---

## 4. Metrics and Their Precise Definitions

| Metric Key | Target Role | Definition & Authority Rule |
| :--- | :--- | :--- |
| `totalBookings` | Student | Exact count of bookings where `user_id = req.user.id`. |
| `pendingBookings` | Student / Admin | Bookings where `status = 'PENDING_APPROVAL'` (scoped to student for Student; global for Admin). |
| `confirmedBookings` | Student / Admin | Bookings where `status = 'CONFIRMED'` (scoped to student for Student; global for Admin). |
| `completedBookings` | Student / Admin | Bookings where `status = 'COMPLETED'` (scoped to student for Student; global for Admin). |
| `cancelledBookings` | Student | Bookings where `user_id = req.user.id` and `status = 'CANCELLED'`. |
| `upcomingClasses` | Student | Schedules where `status = 'SCHEDULED'`. |
| `unreadNotifications`| All Roles | Unread notifications where `user_id = req.user.id` and `read = false`. |
| `myBookings` | Faculty | Exact count of bookings where `user_id = req.user.id`. |
| `pendingApprovals` | Faculty | Global pending booking count where `status = 'PENDING_APPROVAL'` awaiting faculty triage. |
| `mySchedules` | Faculty | Schedules created by the authenticated faculty user (`faculty_id = req.user.id`). |
| `activeBreakage` | Faculty / Admin | Incident reports where `status IN ('OPEN', 'REPORTED', 'INVESTIGATING')`. |
| `totalInstruments` | Faculty / Admin | Total instruments commissioned in inventory. |
| `availableInstruments`| Faculty / Admin | Instruments where `status = 'AVAILABLE'`. |
| `outOfOrderInstruments`| Admin | Instruments where `status = 'OUT_OF_ORDER'`. |
| `totalUsers` | Admin | Total profiles registered in the system. |
| `totalFaculty` | Admin | Profiles where `role = 'faculty'`. |
| `totalStudents` | Admin | Profiles where `role = 'student'`. |
| `totalSchedules` | Admin | Total curriculum schedules across all laboratories. |
| `totalCalibrations` | Admin | Total calibrations scheduled or completed. |

---

## 5. API Endpoints and Authorization Scope

### `GET /api/v1/dashboard/stats`
- **Authentication**: Required (`requireAuth`).
- **Authorization**: Role-aware; identity derived strictly from session JWT / cookie (`req.user.id` and `req.user.role`).
- **Query / Body Parameters**: None accepted (prevents IDOR and privilege escalation).
- **Response Format**:
```json
{
  "success": true,
  "data": {
    "role": "student | faculty | admin",
    "metrics": {
      /* Role-scoped key-value metrics */
    }
  }
}
```
- **Error Responses**:
  - `401 Unauthorized`: Unauthenticated request.
  - `403 Forbidden`: Unknown or invalid role token.
  - `500 Internal Server Error`: Safe error with code `INTERNAL_ERROR`.

---

## 6. Mock-Data Audit and Removal Results

An exhaustive repository scan was executed across all dashboard HTML and script assets (`student.html`, `faculty.html`, `admin.html`, `dash.js`):

- **Mock Strings & Synthetics**: Zero occurrences of `mock`, `placeholder_data`, `lorem`, `fake_*`, or `dummy_*`.
- **API Client Hygiene**: Zero occurrences of raw `fetch()`. All requests use `window.LabPulseAuth.api` (`A.api`), guaranteeing token attachment, CSRF hygiene, token refresh handling, and centralized error notification.
- **Empty & Unavailable States**: When zero records exist, dashboards present dedicated semantic empty table rows (`NO RESERVATIONS FOUND`, `NO CLASSES FOUND`, `NO INSTRUMENTS FOUND`) with guidance rather than mock rows.

---

## 7. Security and Data-Isolation Checks

1. **Server-Side Security Boundary**:
   - The frontend route guards (`A.guard('student')`, `A.guard('faculty')`, `A.guard('admin')`) act solely as UX routing conveniences.
   - All authorization and data isolation is enforced strictly on the server in `routes/dashboard.js`, `routes/bookings.js`, `routes/admin.js`, and `routes/schedules.js`.
2. **Session-Derived Identity**:
   - Metrics queries in `routes/dashboard.js` strictly use `req.user.id` and `req.user.role`.
   - Client-provided query parameters (`?role=...`, `?userId=...`) are ignored, blocking IDOR attacks.
3. **Data Isolation Across Roles**:
   - Students cannot view other students' reservations or administrative audit logs.
   - Faculty cannot view other departments' private data or edit admin configurations.
   - Non-administrators attempting to access `/admin/faculty` receive HTTP 403 `FORBIDDEN`.

---

## 8. Tests Executed and Actual Results

### Automated Verification Battery (`scripts/verify-module-11.js`)
All 22 automated acceptance criteria passed with zero failures:

```
╔══════════════════════════════════════════════════════════════╗
║   MODULE 11: ROLE-BASED DASHBOARDS                         ║
╚══════════════════════════════════════════════════════════════╝

  ✅ PASS  Dashboard stats router mounted at /api/v1/dashboard in server.js
  ✅ PASS  GET /api/v1/dashboard/stats enforces mandatory requireAuth middleware
  ✅ PASS  Student metrics return role-scoped personal booking & timetable counts
  ✅ PASS  Faculty metrics return queue, personal bookings, and teaching schedules
  ✅ PASS  Admin metrics return comprehensive system-wide operational metrics
  ✅ PASS  Identity & role derived strictly from verified session (no client parameter hijacking)
  ✅ PASS  Centralized role navigation config (NAV_CONFIG) defined for all 3 roles
  ✅ PASS  Shared application shell provides notification tray, error banners, and route guards
  ✅ PASS  Student dashboard provides 6 semantic overview metric cards
  ✅ PASS  Student booking filters provide active visual highlighting and click listeners
  ✅ PASS  Student dashboard fetches /api/v1/dashboard/stats in parallel during initialization
  ✅ PASS  Student dashboard reloads metrics dynamically upon booking creation, cancellation, and breakage report
  ✅ PASS  Faculty dashboard provides 6 semantic overview metric cards
  ✅ PASS  Faculty workspace integrates timetable management, free bookings, and approval triage
  ✅ PASS  Faculty dashboard fetches /api/v1/dashboard/stats in parallel during initialization
  ✅ PASS  Faculty dashboard reloads metrics dynamically upon approval triage, schedule creation, and cancellations
  ✅ PASS  Admin dashboard provides 8 comprehensive operational metric cards
  ✅ PASS  Admin reservation and instrument filter buttons provide visual active highlighting
  ✅ PASS  Admin loadStats updates all 8 metric cards via /api/v1/dashboard/stats with robust fallback
  ✅ PASS  Admin dashboard reloads operational metrics upon booking triage and faculty invitation
  ✅ PASS  Mock data audit: zero placeholder, dummy, or synthetic mock values across dashboards
  ✅ PASS  API client hygiene: zero raw fetch() calls; all communication routed through LabPulseAuth (A.api)

══════════════════════════════════════════════════════════════
  Module 11 Verification: 22 PASS / 0 FAIL / 0 SKIP
══════════════════════════════════════════════════════════════
```

### Static Frontend Audit (`scripts/check-frontend.js`)
All 65 frontend structure, accessibility, landmark, and ID validation checks passed cleanly (`CHECK OK`).

---

## 9. Known Limitations and Remaining Dependencies

1. **MongoDB Atlas IP Whitelist in Local Smoke Runs**:
   - Local smoke scripts using direct MongoDB Atlas connections skip execution when running on dynamic local IPs without Atlas IP whitelist entries. The architecture defaults to Supabase PostgreSQL or mock/memory fallbacks during tests.
2. **Chart Visualizations**:
   - In accordance with constraint §8 of the specification, heavy third-party charting libraries (e.g., Chart.js, Recharts) were intentionally excluded in favor of semantic, high-density metric cards and clean tabular overviews with active filter highlighting.

---

## 10. Manual Verification Steps for Each Role

1. **Student**:
   - Log in as a student user (`student@labpulse.test`).
   - Navigate to `student.html`. Verify that 6 summary cards appear (`Total Bookings`, `Pending`, `Confirmed`, `Completed`, `Upcoming Classes`, `Unread Alerts`).
   - Click `PENDING` filter button under *My Reservations*. Verify the button receives a cyan border and text highlighting.
   - Submit a new booking request. Verify that the `Pending` count increments immediately without a full page reload.
   - Cancel a pending booking. Verify that `Pending` decrements immediately.

2. **Faculty**:
   - Log in as a faculty user (`faculty@labpulse.test`).
   - Navigate to `faculty.html`. Verify that 6 summary cards appear (`My Reservations`, `Pending Approvals`, `My Schedules`, `Active Breakage`, `Instruments`, `Unread Alerts`).
   - Under *Requests Queue*, click `APPROVE` on a pending student reservation. Verify that `Pending Approvals` decrements immediately.
   - Schedule a new class in the *Class Schedules* form. Verify that `My Schedules` increments immediately.

3. **Admin**:
   - Log in as an administrator (`admin@labpulse.test`).
   - Navigate to `admin.html`. Verify that 8 system-wide summary cards appear (`Users`, `Faculty`, `Schedules`, `Bookings`, `Pending`, `Instruments`, `Breakage`, `Calibrations`).
   - Toggle through the reservation filter buttons (`ALL`, `PENDING`, `CONFIRMED`, `COMPLETED`). Verify that the active button highlights with cyan underline styling.
   - Toggle instrument filter buttons (`ALL`, `AVAILABLE`, `UNDER_MAINTENANCE`, `OUT_OF_ORDER`, `RETIRED`). Verify accurate active filter styling.
   - Invite a new faculty member. Verify that the `Faculty` and `Users` metric cards refresh immediately.

---

## 11. Concise Checklist for Next Module

Before proceeding to Module 12:
- [x] Dedicated `/api/v1/dashboard/stats` endpoint mounted and secured.
- [x] Student dashboard has 6 role-scoped metric cards with active filter buttons.
- [x] Faculty dashboard has 6 role-scoped metric cards with requests queue triage.
- [x] Admin dashboard has 8 system-wide metric cards with reservation and instrument filters.
- [x] Zero mock or fake data strings in production dashboards.
- [x] Zero raw `fetch()` calls; all client calls routed through `LabPulseAuth` (`A.api`).
- [x] Verification battery `npm run test:dashboards` passes 22/22 tests.
- [x] Frontend test suite `npm run test:auth` / `check-frontend.js` passes 65/65 checks.
