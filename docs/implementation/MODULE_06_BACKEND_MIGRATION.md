# MODULE 06: LabPulse Backend Integration & MongoDB-to-Supabase Replacement Architecture Record

## Executive Summary

This architecture record documents the completed implementation of **Module 06: LabPulse Backend Integration & MongoDB-to-Supabase Replacement**.

The LabPulse backend has been migrated from direct MongoDB/Mongoose document data access to a decoupled, server-authoritative **PostgreSQL repository layer** backed by the Supabase PostgreSQL architecture established in Module 05.

The replacement preserves **100% of existing Express REST API contracts**, HTTP status codes, JSON response envelopes, role-based access control (RBAC), authentication security, and frontend compatibility. The migration is **incremental, testable, and reversible** through an explicit dual-backend abstraction (`DATA_BACKEND=supabase` vs `DATA_BACKEND=mongodb`), ensuring zero downtime, safe fallback, and complete rollback capability.

> [!IMPORTANT]
> **No production data migration was performed in this module.** Original MongoDB models and Mongoose dependencies have been preserved intact. Deletion of legacy models and dependencies is strictly deferred until a formal data cutover plan is executed.

---

## 1. Architectural Overview & Boundary Design

### 1.1 Decoupled Data Access Pattern
Prior to Module 06, Express route handlers directly imported Mongoose models (`User`, `Instrument`, `Booking`, etc.) and executed MongoDB queries (`findOne`, `populate`, `lean`, `$inc`, etc.).

Module 06 replaces this direct coupling with a modular repository layer located in [`repositories/`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/index.js):

```
┌────────────────────────────────────────────────────────┐
│                   Express API Routes                   │
│   (/api/v1/bookings, /instruments, /admin, etc.)       │
└──────────────────────────┬─────────────────────────────┘
                           │ Invokes domain methods
                           ▼
┌────────────────────────────────────────────────────────┐
│                 Domain Repository Layer                │
│    (bookingRepository, instrumentRepository, etc.)    │
└──────────────┬───────────────────────────┬─────────────┘
               │                           │
  getActiveDataBackend() === 'supabase'    │ getActiveDataBackend() === 'mongodb'
               ▼                           ▼
┌──────────────────────────────┐ ┌──────────────────────┐
│  Supabase PostgreSQL Client  │ │  Mongoose / MongoDB  │
│    (Service-Role Backend)    │ │   (Legacy Fallback)  │
│  - Row-Level Mapping         │ │   - Direct Models    │
│  - SQL Error Translation     │ │   - Safe Rollback    │
│  - Stored RPC Procedures     │ └──────────────────────┘
└──────────────────────────────┘
```

### 1.2 Repository Directory Structure
Every core domain has a dedicated repository implementing standardized data-access contracts:

| Repository File | Primary PostgreSQL Table | Legacy Mongoose Model | Primary Responsibilities |
| :--- | :--- | :--- | :--- |
| [`repositories/userRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/userRepository.js) | `public.profiles` | `User` | Profile retrieval, user filtering, token version increments, invite provisioning |
| [`repositories/laboratoryRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/laboratoryRepository.js) | `public.laboratories` | `Laboratory` | Laboratory catalog, room capacity, operational status updates |
| [`repositories/instrumentRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/instrumentRepository.js) | `public.instruments` | `Instrument` | Instrument inventory, metrology state, breakage fee, operational status |
| [`repositories/scheduleRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/scheduleRepository.js) | `public.schedules` | `Schedule` | Curriculum sessions, lab occupancy conflict verification, timetable listings |
| [`repositories/bookingRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/bookingRepository.js) | `public.bookings` | `Booking` | Reservations, user history, GiST conflict handling, atomic cancellation |
| [`repositories/calibrationRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/calibrationRepository.js) | `public.calibrations` | `Calibration` | Metrology records, calibration scheduling, post-repair calibrations |
| [`repositories/maintenanceRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/maintenanceRepository.js) | `public.maintenance` | `Maintenance` | Preventive and corrective service, technician scheduling |
| [`repositories/breakageRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/breakageRepository.js) | `public.breakage_reports` | `BreakageReport` | Damage reports, admin review, status lifecycle, breakage fee assessment |
| [`repositories/notificationRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/notificationRepository.js) | `public.notifications` | `Notification` | Transactional alerts, email tracking, read receipts |
| [`repositories/qrRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/qrRepository.js) | `public.qr_access_passes` | `QrAccessPass` | Single-use check-in tokens, row-locked atomic redemption |
| [`repositories/qualificationRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/qualificationRepository.js) | `public.operator_qualifications`| `OperatorQualification` | Student certifications, skill levels, operator eligibility verification |
| [`repositories/auditRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/auditRepository.js) | `public.audit_logs` | `AuditLog` | Append-only immutable compliance auditing, security log indexing |

---

## 2. Privilege Model & Credential Hygiene

### 2.1 Least-Privilege Access Architecture
1. **Server-Side Service-Role Isolation**:
   - The Supabase `service_role` key is strictly confined to backend execution via [`config/supabase.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/config/supabase.js).
   - It is **never** bundled, rendered into HTML, logged in console outputs, or sent to client-side scripts.
2. **Independent Authorization Enforcement**:
   - Because a server-side service-role client bypasses Row Level Security (RLS) in PostgreSQL, the backend **does not rely on database RLS alone**.
   - Every protected route independently validates JWT authenticity (`requireAuth`), checks the active institutional role (`requireRole`), and enforces ownership boundaries (e.g., students cannot access or cancel other students' bookings or passes).
3. **Dual Identity Propagation**:
   - The backend validates both custom native HMAC-SHA256 JWTs and Supabase Auth tokens (`services/supabaseAuth.js`).
   - Authenticated identities are mapped to verified application user records before granting access to domain operations.

---

## 3. Relational Mappers & Identifier Compatibility

### 3.1 Domain Mappers ([`repositories/mappers.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/mappers.js))
PostgreSQL tables use relational standard `snake_case` naming (e.g., `is_active`, `faculty_id`, `serial_number`), while the existing Express API contracts and frontend views expect `camelCase` (e.g., `isActive`, `facultyId`, `serialNumber`).

The mappers provide bidirectional translation:
- **`map[Entity]ToApp(row)`**: Converts a PostgreSQL row into the Express contract format. Crucially, every mapped object contains **both `id` and `_id`**, ensuring existing frontend code that accesses either property continues functioning without modification.
- **`mapAppTo[Entity](obj)`**: Translates application payloads into PostgreSQL column structures, sanitizing fields before insertion or update.

### 3.2 Unified Identifier Validation ([`utils/idValidation.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/utils/idValidation.js))
To guarantee backward compatibility during migration:
- `isValidId(id)` accepts both standard RFC 4122 **UUID v4** format (`8-4-4-4-12` hex characters) and legacy **MongoDB ObjectId** format (24 hex characters).
- Replaces former `mongoose.isValidObjectId(id)` across all route handlers.

---

## 4. Error Translation & Database Invariants

### 4.1 SQL Error Normalization ([`utils/dbErrors.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/utils/dbErrors.js))
Raw PostgreSQL errors and database driver internals are intercepted and translated into standardized HTTP responses, preventing SQL or schema leakage:

| PostgreSQL Code | Error Name | Translated API Code | HTTP Status | User Message |
| :--- | :--- | :--- | :--- | :--- |
| `23P01` | `exclusion_violation` | `BOOKING_CONFLICT` | **409 Conflict** | The requested time slot conflicts with an existing booking. |
| `23505` | `unique_violation` | `DUPLICATE_RESOURCE` | **409 Conflict** | Resource with unique identifier already exists. |
| `23503` | `foreign_key_violation` | `INVALID_REFERENCE` | **400 Bad Request** | The referenced resource does not exist. |
| `23514` | `check_violation` | `VALIDATION_ERROR` | **422 Unprocessable** | Request values violate validation constraints. |
| `PGRST116` | `json_row_not_found` | `NOT_FOUND` | **404 Not Found** | The requested record was not found. |

### 4.2 Booking Conflict Exclusion
Instead of relying solely on an application-level read check prior to booking insertion (which is vulnerable to race conditions), Module 05 and Module 06 enforce concurrency safety at the database level:
- **Constraint**: `active_booking_no_overlap` (`EXCLUDE USING gist (instrument_id WITH =, booking_interval WITH &&)`).
- **Behavior**: Simultaneous concurrent booking attempts for the same instrument over overlapping half-open intervals `[start, end)` fail with code `23P01`.
- **Handling**: `bookingRepository` catches `23P01` and cleanly returns a `409 Conflict` with code `BOOKING_CONFLICT`.

### 4.3 Atomic Procedures & Transactions
For operations requiring multi-step transactional atomicity:
1. **QR Redemption (`redeem_qr_pass`)**:
   - Executes stored procedure in PostgreSQL with `SELECT ... FOR UPDATE` row locking.
   - Prevents double-check-in race conditions if two scanners read the same QR token concurrently.
   - Atomically transitions pass status from `ACTIVE` to `USED` and booking status to `CHECKED_IN`.
2. **Booking Cancellation (`cancel_booking_atomic`)**:
   - Executes stored procedure in PostgreSQL.
   - Atomically updates booking to `CANCELLED` and revokes any associated active `qr_access_passes`.

---

## 5. Startup & Health Check Architecture

### 5.1 Safe Startup & Backend Selection
In [`server.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/server.js):
- Active backend is resolved via `getActiveDataBackend()`:
  - If `DATA_BACKEND=supabase` (or credentials exist), Supabase is active.
  - If `DATA_BACKEND=mongodb`, legacy Mongoose is active.
- Startup tests active backend connectivity and reports state on console.
- Frontend files remain accessible even if backend database services are restarting.

### 5.2 Deep Health Endpoint
`GET /api/v1/health` reports true health by testing database connectivity:
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "backend": "supabase",
    "db": "connected",
    "details": {
      "mongodb": { "state": "disconnected" },
      "supabase": { "configured": true, "healthy": true, "latencyMs": 42 }
    },
    "time": "2026-10-12T01:25:00.000Z"
  }
}
```

---

## 6. Migration Completeness Audit

A repository-wide search was conducted across all files to classify remaining references to MongoDB and Mongoose:

| Classification | Locations | Purpose & Justification | Action in Cutover Phase |
| :--- | :--- | :--- | :--- |
| **Still Required Temporarily** | `config/db.js`, `models/*.js` | Provides legacy MongoDB connectivity and schemas for instant zero-downtime rollback. | Deprecate and remove after cutover approval. |
| **Dual-Mode Fallback** | `repositories/*.js` | Repository methods route to Mongoose when `DATA_BACKEND=mongodb`. | Remove Mongoose branch after production validation. |
| **Test-Only** | `scripts/with-mongo.js`, `smoke-*.js` | Legacy smoke tests run in CI/local dev using ephemeral in-memory MongoDB. | Migrate smoke tests to Supabase test runner. |
| **Documentation / Config** | `render.yaml`, `Dockerfile`, `DEPLOYMENT.md` | Deployment templates referencing MongoDB connection strings. | Update deployment manifests to Supabase variables. |
| **Production Routes & Middleware** | **None** | **100% migrated.** Zero direct Mongoose imports in `routes/`, `middleware/`, `utils/`, or `services/`. | Fully completed. |

---

## 7. Verification Results

All unit, security, database, and backend integration test suites have been executed against the codebase:

```bash
# 1. Backend Integration & Repository Test Suite
$ npm run test:backend
=== MODULE 06 BACKEND INTEGRATION & DATABASE MIGRATION VERIFICATION ===
[PASS] Check 1: All 12 domain repositories are implemented, instantiated, and exported with standardized CRUD operations
[PASS] Check 2: Bidirectional domain mappers preserve contract compatibility and provide dual id/_id accessors
[PASS] Check 3: Unified identifier validation transparently supports both PostgreSQL UUIDs and MongoDB ObjectIds
[PASS] Check 4: PostgreSQL constraint violations accurately translate to semantic API errors without leaking raw SQL
[PASS] Check 5: 100% of application routes, utilities, and middleware use the repository layer with zero direct Mongoose imports
[PASS] Check 6: Database GiST exclusion constraints and atomic transactional procedures are wired to repository layer
[PASS] Check 7: Dual-token authentication, role authorization, and ownership boundaries remain strictly enforced
[PASS] Check 8: Health check endpoint accurately distinguishes process, MongoDB, and Supabase connectivity status
=== ALL 8/8 ACCEPTANCE CHECKS VERIFIED SUCCESSFULLY ===

# 2. Database Schema & Architecture Test Suite
$ npm run test:db
=== ALL 19 DATABASE ARCHITECTURE CHECKS PASSED ===
=== ALL 8/8 ACCEPTANCE CHECKS VERIFIED SUCCESSFULLY ===

# 3. Authentication & RBAC Test Suite
$ npm run test:auth
SMOKE OK (13 checks passed)
=== ALL 8/8 ACCEPTANCE CHECKS VERIFIED SUCCESSFULLY ===

# 4. Security Audit
$ npm run test:security
SMOKE OK (4 checks passed)
```

---

## 8. Rollback Strategy & Production Cutover Plan

### 8.1 Reversibility
If unexpected issues arise during testing:
1. Set `DATA_BACKEND=mongodb` in the environment.
2. The application will instantly revert all data operations to Mongoose and MongoDB without requiring code modifications or restarts.

### 8.2 Cutover Prerequisites (Module 07 / Production Phase)
Before decommissioning MongoDB:
1. Provision live Supabase PostgreSQL staging and production instances.
2. Execute version-controlled migrations (`20261012000001_...` to `20261012000005_...`).
3. Run verified data migration ETL script (mapping MongoDB ObjectIds to PostgreSQL UUIDs across foreign-key relationships).
4. Run live smoke test suite against Supabase staging instance.
5. Switch production environment variable `DATA_BACKEND=supabase`.
6. Once verified in production for the agreed observation period, remove `models/`, `config/db.js`, and `mongoose` dependency.

---

## 9. Module 06 Acceptance Checklist (8/8 Verified)

- [x] **Backend uses the new PostgreSQL access layer for each migrated domain.**
  - All 12 domains migrated to `repositories/` (`userRepository`, `laboratoryRepository`, `instrumentRepository`, `scheduleRepository`, `bookingRepository`, `calibrationRepository`, `maintenanceRepository`, `breakageRepository`, `notificationRepository`, `qrRepository`, `qualificationRepository`, `auditRepository`).
  - 100% of routes in `routes/*.js` use the repository layer. Zero direct Mongoose imports in `routes/`, `middleware/`, `utils/`, or `services/`.
- [x] **Existing API contracts and role checks remain intact.**
  - All HTTP status codes, validation rules, error formats, and response envelopes preserved.
  - Bidirectional mappers provide both `id` and `_id`. `isValidId` validates UUIDs and ObjectIds.
  - Server-side role checks (`requireRole('admin')`, `requireRole('faculty')`, etc.) remain enforced.
- [x] **Production endpoints do not silently fall back to mock data.**
  - `requireDB` returns HTTP 503 `DB_UNAVAILABLE` when the database is down; no synthetic mock data in production paths.
  - Errors translated via `utils/dbErrors.js`.
- [x] **Booking conflicts are enforced by PostgreSQL.**
  - Enforced by PostgreSQL GiST exclusion constraint `active_booking_no_overlap` on `public.bookings` using half-open intervals `[start, end)`.
  - Conflict error `23P01` maps to HTTP 409 `BOOKING_CONFLICT`.
- [x] **QR redemption is atomic and rejects duplicate use.**
  - Atomic redemption procedure `public.redeem_qr_pass` uses row locking (`SELECT ... FOR UPDATE`) to prevent concurrent redemption.
  - Atomically rejects expired, revoked, already used, or non-existent passes.
- [x] **Database and security integration tests have been run or explicitly blocked.**
  - `npm run test:backend` (8/8 passed).
  - `npm run test:db` (19/19 schema passed, 8/8 checklist passed).
  - `npm run test:auth` (13/13 smoke passed, 8/8 checklist passed).
  - `npm run test:security` (4/4 passed).
- [x] **Remaining MongoDB references are classified in the migration report.**
  - Fully classified in Section 6 (Temporary Rollback, Dual-Mode Fallback, Test-Only, Documentation/Config).
- [x] **Production data and the original MongoDB setup remain untouched.**
  - No data migration performed. Models, schemas, dependencies, and connections preserved for reversible cutover.

