# MODULE 09: QR Access Passes & Secure Check-in

**Status**: ✅ COMPLETE  
**Date**: 2026-10-12  
**Verification**: 21/21 checks passed (`npm run test:qr`)

---

## 1. Architecture Summary

Module 09 implements a production-oriented QR access pass system integrated with the existing authentication (Module 04), RBAC, PostgreSQL/Supabase database (Module 05), booking engine (Module 07), and instrument lifecycle (Module 08).

### Security Model

| Layer | Mechanism |
|-------|-----------|
| **Token generation** | `crypto.randomBytes(32)` → 64-char hex string |
| **Storage** | Only `sha256(token)` stored in database; raw token never persisted |
| **Transport** | Raw token returned to client once on issuance; presented at check-in |
| **Redemption** | PostgreSQL `redeem_qr_pass()` with `SELECT ... FOR UPDATE` row locking |
| **Authorization** | Booking owner or admin; faculty for validation endpoint |
| **RLS** | SELECT, INSERT, UPDATE policies tied to booking ownership |

### Data Flow

```
[Booking Created/Approved] → issueOpaqueToken() → {token, hash}
        ↓                                            ↓
  Return token to client                    Store hash in qr_access_passes
        ↓
[User presents token at check-in]
        ↓
  hashOpaqueToken(token) → lookup by hash
        ↓
  Validate: status, expiry, booking state, owner, window
        ↓
  redeemPassAtomic(hash, operatorId) → atomic transaction
        ↓
  Pass → USED, Booking → CHECKED_IN, Audit log written
```

---

## 2. API Endpoints

All endpoints require authentication (`requireAuth`). Mounted at `/api/v1/qr`.

### POST /api/v1/qr/check-in

Atomic single-use token redemption. Consumes the pass and transitions the booking to `CHECKED_IN`.

**Request**: `{ "token": "<64-char hex>" }`

**Validations**:
- Token must exist and be ACTIVE
- Pass must not be expired, revoked, or already used
- Booking must be CONFIRMED (not cancelled, completed, or already checked in)
- Current user must be booking owner or admin
- Current time must be within the booking window (15-min early grace)

**Atomicity**: Uses `qrRepository.redeemPassAtomic()` which invokes the PostgreSQL `redeem_qr_pass()` stored procedure with `FOR UPDATE` row-level locking. This prevents race conditions under concurrent scans.

**Error codes**: `QR_NOT_FOUND`, `QR_REVOKED`, `QR_ALREADY_USED`, `QR_EXPIRED`, `BOOKING_GONE`, `BOOKING_CANCELLED`, `ALREADY_CHECKED_IN`, `FORBIDDEN`, `TOO_EARLY`, `WINDOW_PAST`

### GET /api/v1/qr/booking/:id

Retrieve the active QR pass status for a booking. Students can only query their own bookings.

**Response**: `{ pass: { id, bookingId, status, expiresAt, checkedInAt, createdAt } | null }`

### POST /api/v1/qr/revoke/:id

Explicitly revoke an active pass. Students can only revoke their own passes; faculty/admin can revoke any.

### POST /api/v1/qr/validate

Dry-run validation (does NOT consume the pass). Staff-only endpoint for kiosk/terminal operators.

**Request**: `{ "token": "<64-char hex>" }`  
**Response**: `{ valid: true/false, withinWindow: boolean, pass: {...}, booking: {...} }`

---

## 3. Database Changes

### Migration: `20261012000006_qr_access_pass_hardening.sql`

| Change | Purpose |
|--------|---------|
| `qr_passes_insert_policy` | RLS INSERT: only for bookings owned by the authenticated user |
| `qr_passes_update_policy` | RLS UPDATE: booking owner or admin/faculty |
| `idx_qr_one_active_per_booking` | Partial unique index: prevents duplicate ACTIVE passes per booking |
| `expire_stale_qr_passes()` | Batch cleanup function for scheduled expiration |

### Existing Schema (unchanged)

- `public.qr_access_passes` table (Migration 02)
- `redeem_qr_pass()` stored procedure with FOR UPDATE locking (Migration 05)
- `cancel_booking_atomic()` revokes active passes on cancellation (Migration 05)
- QR performance indexes (Migration 03)
- RLS SELECT policy tied to booking ownership (Migration 04)

---

## 4. Repository Layer

### QrRepository Methods

| Method | Description |
|--------|-------------|
| `findById(id)` | Lookup pass by primary key |
| `findByTokenHash(hash)` | Lookup pass by sha256 hash |
| `findByBookingId(bookingId)` | Find any pass for a booking |
| `findActiveByBookingId(bookingId)` | Find the current ACTIVE pass for a booking *(new)* |
| `create(data)` | Create a new pass record |
| `updateById(id, data)` | Update a specific pass |
| `updateByBookingId(bookingId, data)` | Update all ACTIVE passes for a booking *(new)* |
| `redeemPassAtomic(hash, operatorId)` | Atomic check-in via stored procedure |
| `revokeForBooking(bookingId)` | Revoke all ACTIVE passes for a booking |
| `count(filter)` | Count passes matching filter |
| `list(filter, opts)` | Paginated pass listing |

---

## 5. Pass Lifecycle

```
                ┌─────────┐
    issuance →  │ ACTIVE  │
                └────┬────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
    ┌────────┐  ┌─────────┐  ┌─────────┐
    │  USED  │  │ EXPIRED │  │ REVOKED │
    └────────┘  └─────────┘  └─────────┘
    (check-in)  (time-based)  (explicit or
                              booking cancel)
```

- **ACTIVE → USED**: Successful check-in (atomic, single-use)
- **ACTIVE → EXPIRED**: Pass expires (time-based, auto-detected or batch cleanup)
- **ACTIVE → REVOKED**: Explicit revocation, booking cancellation, or pass rotation (reissue)
- All terminal states are final — no transition back to ACTIVE

---

## 6. Integration Points

| Module | Integration |
|--------|-------------|
| **Module 04 (Auth)** | `requireAuth` middleware on all QR endpoints |
| **Module 05 (Database)** | `redeem_qr_pass()` stored procedure, RLS policies, indexes |
| **Module 06 (Backend)** | Dual-backend repository (Supabase + MongoDB fallback) |
| **Module 07 (Booking)** | Pass issuance on create/approve, revocation on cancel/reject/no-show |
| **Module 08 (Lifecycle)** | Instrument availability gates checked before booking (and thus before pass issuance) |

---

## 7. Files Modified/Created

### Created
| File | Purpose |
|------|---------|
| `supabase/migrations/20261012000006_qr_access_pass_hardening.sql` | RLS write policies, partial unique index, expiry cleanup |
| `scripts/verify-module-09.js` | 21-check verification battery |

### Modified
| File | Change |
|------|--------|
| `routes/qr.js` | Complete rewrite: atomic check-in, pass lookup, revoke, validate endpoints |
| `repositories/qrRepository.js` | Added `updateByBookingId()` and `findActiveByBookingId()` |
| `package.json` | Added `test:qr` script, Module 09 verification in main test suite |

### Unchanged (verified working)
| File | Status |
|------|--------|
| `models/QrAccessPass.js` | Mongoose model (4 states, hash-only) |
| `repositories/mappers.js` | QR mappers already complete |
| `utils/tokens.js` | `issueOpaqueToken()` + `hashOpaqueToken()` |
| `routes/bookings.js` | Pass issuance on create/approve/reissue |
| `supabase/migrations/20261012000002_core_schema.sql` | QR table definition |
| `supabase/migrations/20261012000005_atomic_functions_and_triggers.sql` | `redeem_qr_pass()` |

---

## 8. Remaining Issues

| Issue | Severity | Notes |
|-------|----------|-------|
| Smoke test (`smoke-qr.js`) targets MongoDB only | Low | Verification script validates architecture; live Supabase testing requires deployed instance |
| QR code image generation not implemented | Low | Module 09 scope is backend security; QR code rendering is a frontend/display concern for a later module |
| `expire_stale_qr_passes()` not scheduled | Info | Function exists; requires `pg_cron` extension or application-level scheduler in production |
| Frontend QR pass display | Deferred | Student/faculty/admin dashboards do not yet render QR passes; backend API is ready |

---

## 9. Verification Results

```
╔══════════════════════════════════════════════════════════════╗
║   MODULE 09: QR ACCESS PASSES & SECURE CHECK-IN           ║
╚══════════════════════════════════════════════════════════════╝

  ✅ PASS  QR route file has all required endpoints
  ✅ PASS  Check-in route uses atomic redeemPassAtomic()
  ✅ PASS  QR repository has all required methods
  ✅ PASS  redeem_qr_pass stored procedure with FOR UPDATE row locking
  ✅ PASS  Opaque token system: randomBytes → sha256 hash → only hash stored
  ✅ PASS  No token hash leakage — sanitizePassResponse strips sensitive fields
  ✅ PASS  Owner/admin authorization enforced
  ✅ PASS  Replay/double-scan rejection returns QR_ALREADY_USED (409)
  ✅ PASS  Check-in enforces booking window with 15-min early grace
  ✅ PASS  All four pass states enforced: ACTIVE, USED, EXPIRED, REVOKED
  ✅ PASS  RLS policies cover SELECT, INSERT, and UPDATE
  ✅ PASS  Partial unique index ensures only one ACTIVE pass per booking
  ✅ PASS  Audit trail records QR_CHECKED_IN and QR_REVOKED events
  ✅ PASS  Validate endpoint: dry-run inspection, staff-only
  ✅ PASS  QR pass issued on booking creation, approval, and reissue
  ✅ PASS  QR routes mounted at /api/v1/qr
  ✅ PASS  expire_stale_qr_passes() function for batch expiration
  ✅ PASS  Bidirectional QR mappers
  ✅ PASS  QR table schema includes all required columns
  ✅ PASS  QR smoke test covers check-in, replay, and revocation
  ✅ PASS  Only sha256 hash stored; raw token never persisted

  Module 09 Verification: 21 PASS / 0 FAIL / 0 SKIP
```
