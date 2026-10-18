# MODULE 12: USER MANAGEMENT & OPERATOR QUALIFICATIONS — IMPLEMENTATION REPORT

**Implementation Date:** October 14, 2026  
**Status:** Complete & Verified  
**Author:** Antigravity Engineering Agent  
**Active Backend Support:** PostgreSQL / Supabase & MongoDB / Memory (Dual-Backend Resilient)

---

## 1. Initial Implementation Findings

An exhaustive audit of the pre-Module 12 repository revealed the following architectural foundation and feature gaps:

1. **Authentication & Identity Providers:**
   - Identity provisioning was split between self-registration (`POST /api/v1/auth/signup` for students) and admin faculty provisioning (`POST /api/v1/admin/faculty`).
   - A unified administrative interface and API to search, filter, and inspect users across all roles (`admin`, `faculty`, `student`) with bounded pagination did not exist.
   - Profile updating and account activation / deactivation lacked server-side protection against self-lockout and removal of the last active administrator.
2. **Laboratory Membership Model:**
   - Laboratories were modeled as facility records (`models/Laboratory.js` and `public.laboratories`), but user associations to specific laboratories were implicit or unmodeled.
   - No relational or document join existed to assign users to authorized laboratory spaces or restrict instrument usage based on facility membership.
3. **Operator Qualifications Schema & Lifecycle:**
   - The preexisting `models/OperatorQualification.js` and `public.operator_qualifications` only supported simple admin CRUD with basic statuses (`ACTIVE`, `EXPIRED`, `SUSPENDED`, `PENDING`).
   - There was no structured candidate request workflow (`POST /request`), evidence submission, verification queue for authorized personnel, or formalized renewal, rejection, and revocation lifecycle states.
   - Crucially, self-approval prevention (`SELF_APPROVAL_BLOCKED`) was not enforced on the server.
4. **Point-of-Use Eligibility Revalidation:**
   - The booking engine (`checkBookingGates`) checked basic qualification levels, but did not guard against deactivated accounts at time of booking.
   - The QR check-in engine (`routes/qr.js`) validated time windows and token hashes, but did not revalidate whether the candidate's qualification or account had been revoked or suspended between booking creation and physical arrival.

---

## 2. Files Created or Modified

### Created Files
- [`supabase/migrations/20261012000008_user_qualifications_membership.sql`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/supabase/migrations/20261012000008_user_qualifications_membership.sql): Relational migration defining `public.laboratory_memberships`, RLS policies, index coverage, and extending `public.operator_qualifications` with evidence fields and lifecycle constraints.
- [`models/LaboratoryMembership.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/models/LaboratoryMembership.js): Mongoose model with compound unique index on `{ userId: 1, laboratoryId: 1 }` and role enum (`MEMBER`, `MANAGER`, `PI`, `SUPERVISOR`).
- [`repositories/laboratoryMembershipRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/laboratoryMembershipRepository.js): Dual-backend repository implementing membership lookups, assignments, revocations, and user-lab membership assertions.
- [`routes/users.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/users.js): User administration router mounted at `/api/v1/admin/users`.
- [`scripts/verify-module-12.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/scripts/verify-module-12.js): Comprehensive 22-step automated verification battery.

### Modified Files
- [`server.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/server.js): Mounted `/api/v1/admin/users` and `/api/v1/qualifications` (along with legacy `/api/v1/admin/qualifications`).
- [`models/OperatorQualification.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/models/OperatorQualification.js): Expanded status enum to `ACTIVE`, `EXPIRED`, `SUSPENDED`, `PENDING`, `REJECTED`, `REVOKED`, adding `evidenceUrl`, `evidenceNotes`, `rejectionReason`, and `revocationReason`.
- [`repositories/mappers.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/mappers.js): Added bidirectional mappers for laboratory memberships and enhanced operator qualification mappers.
- [`repositories/qualificationRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/qualificationRepository.js): Added lifecycle methods (`getPendingQueue`, `approve`, `reject`, `renew`, `suspend`, `revoke`).
- [`repositories/userRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/userRepository.js): Added search query regex handling across name/email, department filtering, and `bumpTokenVersion`.
- [`routes/qualifications.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/qualifications.js): Replaced admin-only stub with complete candidate submission, faculty/admin queue, review lifecycle, evidence display, and self-approval prevention.
- [`utils/bookingGates.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/utils/bookingGates.js): Added active account validation gate (`ACCOUNT_DEACTIVATED`).
- [`routes/qr.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/qr.js): Implemented point-of-use revalidation in `POST /check-in` and `POST /validate` checking active account status and current qualification validity.
- [`admin.html`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/admin.html): Implemented User Administration & Lab Memberships section, Operator Qualification Verification Queue section, and accessible modals.
- [`package.json`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/package.json): Added `"test:users": "node scripts/verify-module-12.js"` and `"test:module-12"`.

---

## 3. User Administration and Role-Management Behavior

The user administration workflow is governed by strict server-side rules in `routes/users.js`:

1. **Paginated User Directory (`GET /api/v1/admin/users`):**
   - Bounded queries using `page` and `limit` (max 100).
   - Multi-field search (`q`) matching candidate names, emails, and departments case-insensitively.
   - Filterable by `role` (`student`, `faculty`, `admin`), `isActive` (`true`, `false`), and `laboratoryId`.
   - Returns sanitized user records with sensitive password hashes, recovery tokens, and internal salt fields omitted.
2. **Profile & History Retrieval (`GET /api/v1/admin/users/:id`):**
   - Returns the target user's profile embedded with their active `qualifications` and `laboratoryMemberships`.
3. **Privilege & State Transition Security (`PATCH /api/v1/admin/users/:id`):**
   - **Protection against Removing the Last Administrator (`LAST_ADMIN_PROTECTED`):** Before deactivating an administrator or demoting their role, the server queries active admin count (`await userRepository.count({ role: 'admin', isActive: true })`). If the count is $\le 1$, the operation is rejected with HTTP 400 and error code `LAST_ADMIN_PROTECTED`.
   - **Self-Lockout Prevention (`SELF_LOCKOUT_BLOCKED`):** An administrator cannot deactivate their own account or change their own role. Attempting self-demotion or self-deactivation triggers HTTP 400 with error code `SELF_LOCKOUT_BLOCKED`.
   - **Session Token Invalidation:** When an account is deactivated (`isActive: false`), the server increments `tokenVersion` (`userRepository.bumpTokenVersion`), immediately rendering all existing JWT access tokens invalid upon the next request.
4. **User Provisioning (`POST /api/v1/admin/users/invite`):**
   - Allows administrators to invite Faculty, Students, or additional Administrators with 72-hour cryptographic invitation tokens.
   - Rejects duplicate email registrations with HTTP 409 `EMAIL_TAKEN`.

---

## 4. Laboratory Membership Rules

Laboratory memberships link users to physical lab facilities (`public.laboratory_memberships`):

1. **Assignment (`POST /api/v1/admin/users/:id/laboratories`):**
   - Validates that the target laboratory exists and is active.
   - Rejects duplicate memberships with HTTP 409 `DUPLICATE_MEMBERSHIP`.
   - Supports laboratory roles: `MEMBER`, `MANAGER`, `PI`, `SUPERVISOR`.
   - Emits an auditable event `LABORATORY_ASSIGNED` and dispatches in-app notification `lab-membership-assigned`.
2. **Revocation (`DELETE /api/v1/admin/users/:id/laboratories/:labId`):**
   - Safely removes the membership record without deleting historical booking or usage logs.
   - Emits `LABORATORY_REMOVED` and dispatches notification `lab-membership-removed`.
3. **Preservation of History:**
   - Historical bookings, breakage incident reports, and qualification records retain immutable references to the user and facility.

---

## 5. Qualification Lifecycle and Verification Permissions

### Lifecycle States
```
       ┌──────────────┐
       │   REQUEST    │
       │ (User Submit)│
       └──────┬───────┘
              │ (status: PENDING)
              ▼
       ┌──────────────┐      Reject (reason)      ┌──────────────┐
       │  VERIFY QUEUE├──────────────────────────►│   REJECTED   │
       └──────┬───────┘                           └──────────────┘
              │ Approve
              ▼
       ┌──────────────┐      Suspend (reason)     ┌──────────────┐
       │    ACTIVE    ├──────────────────────────►│  SUSPENDED   │
       └──────┬───────┘                           └──────┬───────┘
              │ Expiry / Revoke                          │ Reinstate
              ▼                                          │
       ┌──────────────┐                                  ▼
       │REVOKED/EXPIRE│◄─────────────────────────────────┘
       └──────────────┘
```

1. **Request / Application (`POST /api/v1/qualifications/request`):**
   - Any authenticated student or faculty member can apply for an operator qualification.
   - Accepts `instrumentId` or general `scope`, requested `level` (1–4), `evidenceUrl` (document or portfolio reference), and `evidenceNotes`.
   - Stored in status `PENDING`. Emits `QUALIFICATION_REQUESTED` and notifies applicant.
2. **Verification Queue (`GET /api/v1/qualifications/queue`):**
   - Accessible strictly to authorized personnel (`admin` and `faculty`).
   - Retrieves all pending candidate applications for evidence inspection.
3. **Self-Approval Prevention (`SELF_APPROVAL_BLOCKED`):**
   - When reviewing (`approve`, `reject`, `renew`), the server asserts:  
     `if (String(qualification.userId) === String(currentUserId))`
   - Self-approval or self-review returns HTTP 403 `SELF_APPROVAL_BLOCKED`: *"Authorized personnel cannot approve their own operator qualifications."*
4. **Approval & Reinstatement (`POST /api/v1/qualifications/:id/approve`):**
   - Transitions qualification to `ACTIVE`, records `certifiedBy` (reviewer's UUID) and `certifiedAt` (timestamp).
   - Allows setting custom `expiresAt` or leaving null (permanent certification).
   - Emits `QUALIFICATION_APPROVED` and notifies user.
5. **Rejection (`POST /api/v1/qualifications/:id/reject`):**
   - Requires review reason. Transitions state to `REJECTED`, records `rejectionReason`.
   - Emits `QUALIFICATION_REJECTED` and notifies user.
6. **Renewal (`POST /api/v1/qualifications/:id/renew`):**
   - Extends certification validity to a specified future `expiresAt` date.
   - Emits `QUALIFICATION_RENEWED` and notifies user.
7. **Suspension & Revocation (`POST /api/v1/qualifications/:id/suspend` and `POST /:id/revoke`):**
   - Records administrative justification (`revocationReason`). Transitions state to `SUSPENDED` or `REVOKED`.
   - Emits audit log and notifies user.

---

## 6. Booking and QR Eligibility Integration

1. **Pre-Booking Availability Gates (`utils/bookingGates.js`):**
   - Validates that the booking applicant account is active (`user.isActive !== false`). Deactivated accounts are rejected with HTTP 403 `ACCOUNT_DEACTIVATED`.
   - If the instrument specifies a `requiredQualificationLevel > 0`, verifies that the candidate holds an `ACTIVE` qualification record where `level >= requiredLevel` and `expiresAt` is null or in the future.
2. **Point-of-Use Revalidation at Check-In (`routes/qr.js`):**
   - During physical QR token redemption (`POST /api/v1/qr/check-in`) and dry-run validation (`POST /api/v1/qr/validate`):
     - **Account Status Gate:** Re-queries the booking owner from the database. If `isActive === false`, check-in is rejected with HTTP 403 `ACCOUNT_DEACTIVATED`.
     - **Qualification Gate:** If the reserved instrument requires operator qualification, the server re-validates `qualificationRepository.checkUserQualification(ownerId, instId, requiredLevel)`.
     - If the user's qualification was revoked, suspended, or expired after the reservation was made, check-in is blocked with HTTP 403 `QUALIFICATION_INVALID`:  
       *"Operator qualification is no longer valid, expired, or has been revoked/suspended. Access denied."*

---

## 7. API Endpoints and Database Changes

### API Endpoints Added or Enhanced

| HTTP Method | Route | Access | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/users` | Admin | Paginated user search with role, status, and lab filters |
| `POST` | `/api/v1/admin/users/invite` | Admin | Provision user account and issue 72h activation token |
| `GET` | `/api/v1/admin/users/:id` | Admin | Inspect profile with qualifications and lab memberships |
| `PATCH` | `/api/v1/admin/users/:id` | Admin | Update profile fields (`LAST_ADMIN_PROTECTED`, `SELF_LOCKOUT_BLOCKED`) |
| `DELETE` | `/api/v1/admin/users/:id` | Admin | Soft delete/deactivate user and invalidate session tokens |
| `POST` | `/api/v1/admin/users/:id/resend-invite` | Admin | Re-issue pending activation token |
| `GET` | `/api/v1/admin/users/:id/laboratories` | Admin | List user's active laboratory memberships |
| `POST` | `/api/v1/admin/users/:id/laboratories` | Admin | Assign user to a laboratory facility |
| `DELETE` | `/api/v1/admin/users/:id/laboratories/:labId` | Admin | Revoke laboratory membership |
| `GET` | `/api/v1/qualifications/mine` | Auth | List caller's operator qualifications |
| `GET` | `/api/v1/qualifications/queue` | Admin, Faculty | Pending verification queue |
| `POST` | `/api/v1/qualifications/request` | Auth | Apply for qualification with evidence references |
| `GET` | `/api/v1/qualifications` | Admin, Faculty | Filter qualifications by user, instrument, or status |
| `GET` | `/api/v1/qualifications/:id` | Owner, Admin, Faculty | View qualification details and evidence |
| `POST` | `/api/v1/qualifications/:id/approve` | Admin, Faculty | Approve or reinstate (`SELF_APPROVAL_BLOCKED`) |
| `POST` | `/api/v1/qualifications/:id/reject` | Admin, Faculty | Reject application with reason |
| `POST` | `/api/v1/qualifications/:id/renew` | Admin, Faculty | Renew qualification with updated expiry date |
| `POST` | `/api/v1/qualifications/:id/suspend` | Admin, Faculty | Suspend qualification pending review |
| `POST` | `/api/v1/qualifications/:id/revoke` | Admin, Faculty | Permanently revoke qualification |

### Database Changes (`20261012000008_user_qualifications_membership.sql`)
1. **New Table `public.laboratory_memberships`:**
   - Columns: `id`, `user_id` (FK `public.profiles`), `laboratory_id` (FK `public.laboratories`), `role`, `assigned_by`, `assigned_at`, `created_at`, `updated_at`.
   - Unique Constraint: `uq_user_laboratory_membership` on `(user_id, laboratory_id)`.
   - Indexes on `user_id` and `laboratory_id`.
2. **Altered Table `public.operator_qualifications`:**
   - Added columns: `evidence_url` (VARCHAR 500), `evidence_notes` (TEXT), `rejection_reason` (TEXT), `revocation_reason` (TEXT).
   - Check constraint on `status` expanded to include `ACTIVE`, `EXPIRED`, `SUSPENDED`, `PENDING`, `REJECTED`, `REVOKED`.

---

## 8. RLS and Security Validation

1. **Row Level Security for `public.laboratory_memberships`:**
   - `SELECT`: Permitted for the record owner (`user_id = auth.uid()`) or privileged users (`role IN ('admin', 'faculty')`).
   - `ALL` (Insert/Update/Delete): Restricted strictly to administrators (`EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')`).
2. **Row Level Security for `public.operator_qualifications`:**
   - Read permissions scoped to candidate owner or faculty/admin reviewers.
   - Verification mutations (`approve`, `reject`, `renew`, `suspend`, `revoke`) restricted to faculty/admin roles with server-side validation against self-approval.
3. **Privilege Escalation Prevention:**
   - Role updates are exclusively processed on the server via `/api/v1/admin/users/:id`.
   - Client headers, browser local storage, and client metadata cannot alter server-evaluated claims.

---

## 9. Tests Executed and Actual Results

The verification battery was executed via `npm run test:users` (`node scripts/verify-module-12.js`):

```
> labpulse@0.1.0 test:users
> node scripts/verify-module-12.js

╔═════════════════════════════════════════════════════════════════════════╗
║   MODULE 12: USER MANAGEMENT & OPERATOR QUALIFICATIONS BATTERY          ║
╚═════════════════════════════════════════════════════════════════════════╝

  ✅ PASS  Relational migration 08 defines laboratory_memberships, RLS, and qualification lifecycle schema
  ✅ PASS  Mongoose LaboratoryMembership model defined with compound unique index
  ✅ PASS  Mongoose OperatorQualification model enhanced with full lifecycle enum and evidence fields
  ✅ PASS  Domain mappers support bidirectional conversion for laboratory memberships and qualifications
  ✅ PASS  Laboratory membership repository provides find, list, create, delete, and check operations
  ✅ PASS  Qualification repository provides queue retrieval, approve, reject, renew, suspend, and revoke operations
  ✅ PASS  User repository provides paginated queries with search query regex and department filtering
  ✅ PASS  User management routes mounted at /api/v1/admin/users in server.js
  ✅ PASS  Qualification routes mounted at /api/v1/qualifications and /api/v1/admin/qualifications in server.js
  ✅ PASS  User administration GET /api/v1/admin/users supports pagination, search, role, and lab filtering
  ✅ PASS  User profile GET /api/v1/admin/users/:id embeds qualifications and laboratory memberships
  ✅ PASS  Protection against removing or deactivating the last active administrator (LAST_ADMIN_PROTECTED)
  ✅ PASS  Self-demotion and self-deactivation lockout blocked on admin accounts (SELF_LOCKOUT_BLOCKED)
  ✅ PASS  Session invalidation on deactivation increments tokenVersion to reject active JWTs
  ✅ PASS  Laboratory membership assignment, listing, and revocation with audit and notifications
  ✅ PASS  Candidate qualification submission POST /request sets PENDING status and records evidence
  ✅ PASS  Pending verification queue GET /queue retrieves applications for authorized personnel review
  ✅ PASS  Self-approval strictly blocked on qualification approve, reject, and renew (SELF_APPROVAL_BLOCKED)
  ✅ PASS  Qualification approval, rejection, renewal, suspension, and revocation lifecycle transitions
  ✅ PASS  Booking engine gates revalidate active account and operator qualification
  ✅ PASS  QR check-in and validation revalidate account status and active operator qualification at point of use
  ✅ PASS  Frontend UI integration in admin.html with accessible modals, zero raw fetch, and 100% resolved DOM IDs

──────────────────────────────────────────────────────────────────────────
TOTAL CHECKS: 22
PASSED:       22
FAILED:       0
──────────────────────────────────────────────────────────────────────────

🎉 ALL 22/22 MODULE 12 ACCEPTANCE CHECKS VERIFIED SUCCESSFULLY!
```

Frontend accessibility, DOM wiring, and anti-leakage checks were verified via `node scripts/check-frontend.js`:
- `PASS JS-referenced IDs exist (25 checked)`
- `PASS admin.html: inline IDs resolve (80 checked)`
- `PASS no window.alert (0 found)`
- `PASS dash.js & admin.html: no direct fetch (all routed through LabPulseAuth)`

---

## 10. Remaining Gaps and Dependencies

1. **Storage Integration for Large Evidence Documents:**
   - Candidate evidence currently accepts external storage URLs and text notes (`evidenceUrl`, `evidenceNotes`). Integration with a self-hosted S3/Supabase Storage bucket with presigned download links can be extended when file upload endpoints are introduced.
2. **Automatic Expiry Cron Worker:**
   - The query-level checks dynamically treat any qualification where `expiresAt < now()` as expired. An asynchronous scheduled worker to update `status: 'EXPIRED'` in batch can be configured in standing deployment environments.

---

## 11. Manual Verification Instructions for Each Role

### Administrator Role
1. Sign in as Admin (`admin@institution.edu`).
2. Navigate to `admin.html`.
3. Locate **User Administration & Lab Memberships**:
   - Search for a student by name or email.
   - Click **ROLE** on a faculty account and change to `student` or `admin`.
   - Attempt to deactivate your own admin account. Verify that the server refuses with `SELF_LOCKOUT_BLOCKED`.
   - On another user row, click **LABS** to open the laboratory membership modal; select a lab and click **ASSIGN**. Verify the assignment appears in the modal list.
4. Locate **Operator Qualification Verification**:
   - Filter by `PENDING QUEUE`.
   - Click **EVIDENCE** to inspect submitted application notes.
   - Click **APPROVE** to activate the candidate's qualification.
   - On an active qualification, click **SUSPEND** or **REVOKE** and input a reason.

### Faculty Role
1. Sign in as Faculty (`faculty@institution.edu`).
2. Navigate to `faculty.html`.
3. In the Qualifications review queue, approve student qualifications for instruments under faculty oversight. Verify self-approval is rejected if attempting to certify own candidate request.

### Student Role
1. Sign in as Student (`student@institution.edu`).
2. Submit a qualification application with evidence link via `POST /api/v1/qualifications/request`.
3. Once approved by faculty/admin, book a restricted instrument.
4. Observe that if the qualification is later suspended or revoked, QR check-in attempts at `/api/v1/qr/check-in` return HTTP 403 `QUALIFICATION_INVALID`.

---

## 12. Checklist for the Next Module

- [x] All 22 Module 12 criteria implemented and passing with 0 failures.
- [x] Dual-backend compatibility maintained across Supabase and MongoDB/in-memory data layers.
- [x] User management, lab assignments, and qualifications fully integrated into `admin.html`.
- [x] Zero raw fetch and 100% resolved DOM IDs verified.
- [x] Scope boundary respected: execution completed and stopped at Module 12.
