# MODULE 17: DEPLOYMENT & PRODUCTION INFRASTRUCTURE — IMPLEMENTATION REPORT

## 1. Production Architecture Overview

LabPulse is deployed as a stateless, containerized Node.js/Express service backed authoritatively by **Supabase PostgreSQL**, Row Level Security (RLS), and server-side RBAC repositories.

```text
                            Client Browser / App
                                     │
                                   HTTPS
                                     │
                   ┌─────────────────▼─────────────────┐
                   │    Reverse Proxy / Cloud CDN      │
                   │    (Render / Cloudflare / Nginx)  │
                   │    - TLS Termination & HTTPS      │
                   │    - HSTS & Security Headers      │
                   │    - DDoS Protection              │
                   └─────────────────┬─────────────────┘
                                     │
                              HTTP (Internal)
                                     │
                   ┌─────────────────▼─────────────────┐
                   │     LabPulse Web Application      │
                   │      (Node.js 20+ / Alpine)       │
                   │   - Static Asset Serving          │
                   │   - Server-Side RBAC Enforcement  │
                   │   - Express Rate Limiter          │
                   │   - Dual-Auth & Session Engine    │
                   │   - Liveness / Readiness Probes   │
                   │   - Non-Root Container Execution  │
                   └─────────────────┬─────────────────┘
                                     │
                         HTTPS / TLS (Port 443 / 5432)
                         Server-Side Service Role Key
                                     │
                   ┌─────────────────▼─────────────────┐
                   │     Supabase Managed Platform     │
                   │   - PostgreSQL Database Engine    │
                   │   - 11 Relational Domain Tables   │
                   │   - GiST Exclusion Constraints    │
                   │   - Row Level Security (RLS)      │
                   │   - Atomic Stored Procedures      │
                   │   - Continuous Automated Backups  │
                   └───────────────────────────────────┘
```

---

## 2. MongoDB Deprecation & Removal in Production

- **Authoritative Database**: 100% of production domain models, repositories, routes, and services query **Supabase PostgreSQL** exclusively.
- **Zero Production Dependency**: The application boots and operates completely without any `MONGODB_URI` environment variable when `DATA_BACKEND=supabase`.
- **Runtime Transition**: The legacy MongoDB connection logic in `server.js` was isolated so that in production Supabase mode, it never attempts or requires MongoDB connectivity.
- **Developer Tests**: Legacy test scripts verifying backward compatibility run using ephemeral in-memory instances only during local development.

---

## 3. Production Environment Variables & Secrets Management

Documented in [`.env.example`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/.env.example):

| Variable | Environment | Required | Description |
| :--- | :---: | :---: | :--- |
| `NODE_ENV` | Production | **Yes** | Set to `production` to activate HSTS, production error masking, and secure cookies. |
| `PORT` | Production | No | Defaults to `3000` (automatically managed by cloud host). |
| `APP_URL` | Production | **Yes** | Canonical public URL (e.g. `https://labpulse.onrender.com`). |
| `ALLOWED_ORIGINS` | Production | No | Comma-separated CORS allowlist. Never allows wildcard `*` with credentials. |
| `DATA_BACKEND` | Production | **Yes** | Explicitly set to `supabase`. |
| `SUPABASE_URL` | Production | **Yes** | Supabase project API gateway URL. |
| `SUPABASE_ANON_KEY` | Production | **Yes** | Public anonymous client API key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Production | **Yes** | **Confidential**: Server-only privileged key used exclusively by backend repositories. |
| `SUPABASE_JWT_SECRET` | Production | No | Secret for verifying Supabase Auth Bearer tokens. |
| `JWT_ACCESS_SECRET` | Production | **Yes** | High-entropy secret (>=32 chars) for signing 15m access JWTs. |
| `JWT_REFRESH_SECRET` | Production | **Yes** | High-entropy secret (>=32 chars) for signing 7d rotating refresh JWTs. |
| `EMAIL_PROVIDER` | Production | **Yes** | Set to `smtp` in production (`dev` buffers in memory). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Production | If smtp | Production transactional mail transport credentials. |

---

## 4. Database Migrations Execution

All 11 versioned SQL migrations in `supabase/migrations/` apply cleanly:
1. `20261012000001_extensions_and_prerequisites.sql` (`uuid-ossp`, `btree_gist`, `pgcrypto`)
2. `20261012000002_core_schema.sql` (12 domain tables with UUID PKs and relational FKs)
3. `20261012000003_constraints_and_indexes.sql` (GiST exclusion `active_booking_no_overlap`)
4. `20261012000004_row_level_security.sql` (RLS policies, tenant isolation)
5. `20261012000005_atomic_functions_and_triggers.sql` (`redeem_qr_pass`, `cancel_booking_atomic`)
6. `20261012000006_qr_access_pass_hardening.sql` (Pass rotation, single-use security)
7. `20261012000007_notifications_enhancement.sql` (Outbox dispatch, priority tagging)
8. `20261012000008_user_qualifications_membership.sql` (Qualifications & laboratory memberships)
9. `20261012000009_audit_logs_compliance.sql` (Immutable audit logging)
10. `20261012000010_search_filtering_export_indexes.sql` (Search & filter composite indexes)
11. `20261012000011_analytics_operational_intelligence.sql` (Utilization & analytics composite indexes)

---

## 5. Containerization & Deployment Blueprints

- **[`Dockerfile`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/Dockerfile)**:
  - Multi-stage build on `node:20-alpine`.
  - Non-root container execution (`USER node`) adhering to the principle of least privilege.
  - Built-in container liveness `HEALTHCHECK` querying `/api/v1/health/liveness` every 30s.
- **[`render.yaml`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/render.yaml)**:
  - Production web service blueprint.
  - Configures `npm ci --omit=dev` build command.
  - Configures `/api/v1/health/liveness` health check probe path.
  - Declares all Supabase environment variables without hardcoded secrets.

---

## 6. Security Hardening Policies

1. **HTTPS & HSTS**:
   - In production (`NODE_ENV=production`), automatic `Strict-Transport-Security: max-age=31536000; includeSubDomains` header injection.
2. **Security Headers**:
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: SAMEORIGIN`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `X-XSS-Protection: 0`
3. **CORS Allowlist**:
   - Explicit matching against `ALLOWED_ORIGINS` and `APP_URL`. Rejects arbitrary origins and prevents wildcard credentials abuse.
4. **Secure Cookies**:
   - Refresh tokens issued in `httpOnly: true`, `secure: true`, `sameSite: 'lax'` cookies scoped strictly to `/api/v1/auth`.
5. **Rate Limiting**:
   - Global API limiter: 300 requests / 15 minutes.
   - Authentication limiter: 20 login attempts / 15 minutes.
   - Sensitive password reset limiter: 10 attempts / 15 minutes.
6. **Graceful Shutdown**:
   - `SIGTERM` and `SIGINT` signals initiate graceful HTTP server connection draining over a 10-second window.

---

## 7. Observability & Health Probes

| Endpoint | Probe Type | Purpose / Behavior |
| :--- | :--- | :--- |
| `GET /api/v1/health/liveness` | **Liveness Probe** | Immediate HTTP 200 `{ status: 'alive' }` without database dependency. Prevents container restart loops during temporary database network latency. |
| `GET /api/v1/health/readiness` | **Readiness Probe** | Evaluates active database connectivity. Returns HTTP 200 when ready, HTTP 503 when the database is unreachable or degraded. |
| `GET /api/v1/health` | **Status Dashboard** | Full diagnostic envelope reporting active backend, database status, and timestamp. |

---

## 8. Backup, Disaster Recovery & Rollback Strategy

1. **Automated Database Backups**:
   - Supabase automated daily backups with Point-In-Time-Recovery (PITR) support.
2. **Stateless Web Rollback**:
   - Deployments are completely stateless. Reverting a release takes seconds via Git commit or Docker container tag in Render.
3. **Schema Compatibility**:
   - All 11 migrations are backward-compatible and additive; rolling back application code does not require dropping database columns.

---

## 9. Targeted Verification Results

Executed exclusively targeted Module 17 tests via `npm run test:module-17`:

```text
> labpulse@0.1.0 test:module-17
> node scripts/verify-module-17.js

================================================================
  LABPULSE MODULE 17: DEPLOYMENT & PRODUCTION INFRASTRUCTURE TEST
================================================================

--- SUITE 1: Production Configuration & Blueprint ---
  ✅ PASS  .env.example clearly separates environments and documents Supabase production credentials without leaking secrets
  ✅ PASS  render.yaml sets DATA_BACKEND=supabase and configures liveness probe path

--- SUITE 2: Hardened Docker Container ---
  ✅ PASS  Dockerfile implements non-root execution (USER node) and container liveness healthcheck probe

--- SUITE 3: MongoDB Removal & Supabase Primacy ---
  ✅ PASS  DEPLOYMENT.md documents Supabase as authoritative production database with zero MongoDB runtime dependency
  ✅ PASS  server.js prioritizes Supabase PostgreSQL connection and health verification

--- SUITE 4: Operational Health Probes ---
  ✅ PASS  GET /api/v1/health/liveness responds 200 OK with alive status without DB latency
  ✅ PASS  GET /api/v1/health diagnostic provides full operational overview
  ✅ PASS  GET /api/v1/health/readiness reflects backend traffic service readiness

--- SUITE 5: Security Headers & CORS Allowlisting ---
  ✅ PASS  server.js configures HSTS in production, explicit CORS allowlisting, and mandatory frame guards

--- SUITE 6: Secure Cookie Attribute Policies ---
  ✅ PASS  Refresh cookies strictly enforce httpOnly, sameSite: lax, secure in production, and path scoping

--- SUITE 7: Process Lifecycle & Graceful Shutdown ---
  ✅ PASS  Process listeners trap SIGINT and SIGTERM for graceful connection draining and termination

================================================================
  VERIFICATION RESULT: 11 / 11 CHECKS PASSED
  🎉 ALL MODULE 17 ACCEPTANCE CHECKS PASSED DETERMINISTICALLY
================================================================
```

Frontend static hygiene check:
```text
CHECK OK — 122 admin.html inline IDs resolved, 0 raw fetch, 0 window.alert.
```
