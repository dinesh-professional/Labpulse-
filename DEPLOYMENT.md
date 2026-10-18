# LabPulse Production Deployment & Operational Infrastructure Guide (Module 17)

## 1. System Production Architecture

LabPulse operates as a high-performance, stateless web and API service backed authoritatively by **Supabase PostgreSQL**, Row Level Security (RLS), and server-side RBAC repositories.

```text
                                 Internet / Client
                                         │
                                       HTTPS
                                         │
                       ┌─────────────────▼─────────────────┐
                       │       Reverse Proxy / CDN         │
                       │    (Render / Cloudflare / Nginx)  │
                       │    - TLS Termination              │
                       │    - HSTS & Security Headers      │
                       │    - DDoS Protection              │
                       └─────────────────┬─────────────────┘
                                         │
                                  HTTP (Internal)
                                         │
                       ┌─────────────────▼─────────────────┐
                       │     LabPulse Web Application      │
                       │     (Node.js 20+ / Express)       │
                       │   - Static Asset Serving          │
                       │   - Server-Authoritative RBAC     │
                       │   - Express Rate Limiter          │
                       │   - Dual-Auth & Session Engine    │
                       │   - Liveness / Readiness Probes   │
                       └─────────────────┬─────────────────┘
                                         │
                            HTTPS / TLS (Port 443 / 5432)
                            Strict Server-Side Key Access
                                         │
                       ┌─────────────────▼─────────────────┐
                       │     Supabase Managed Platform     │
                       │   - PostgreSQL Database           │
                       │   - 11 Versioned Relational Tables│
                       │   - GiST Exclusion Constraints    │
                       │   - Row Level Security (RLS)      │
                       │   - Atomic Stored Procedures      │
                       │   - Continuous Automated Backups  │
                       └───────────────────────────────────┘
```

---

## 2. MongoDB Deprecation & Removal in Production

As established in Module 06 and finalized in Module 17:
- **Production Runtime**: 100% of production domain models, repositories, routes, and services query **Supabase PostgreSQL** exclusively.
- **Zero Production Dependency**: Production does NOT require or connect to MongoDB.
- **DATA_BACKEND Flag**: Set to `DATA_BACKEND=supabase` in all production profiles. The Express server boots cleanly without any `MONGODB_URI` environment variable.
- **Legacy Tests**: Legacy smoke test scripts that validate MongoDB backwards compatibility are isolated in `tests/` and run using ephemeral in-memory MongoDB instances only during developer testing.

---

## 3. Production Environment Variables

All production environment variables must be injected securely via platform secrets management (e.g. Render Dashboard or Kubernetes Secrets). **Never commit production `.env` files to git.**

| Variable | Required | Default / Example | Purpose / Security Notes |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | **Yes** | `production` | Enforces production error masking, secure cookies, and strict JWT validation. |
| `PORT` | No | `3000` | Port for the HTTP listener. Managed automatically by Render. |
| `APP_URL` | **Yes** | `https://labpulse.onrender.com` | Canonical public URL used for email links and CORS validation. |
| `ALLOWED_ORIGINS` | No | `https://labpulse.onrender.com` | Comma-separated CORS allowlist. Never allows wildcard `*` with credentials. |
| `DATA_BACKEND` | **Yes** | `supabase` | Directs repositories to use the Supabase PostgreSQL client layer. |
| `SUPABASE_URL` | **Yes** | `https://xyz.supabase.co` | Supabase project API gateway endpoint. |
| `SUPABASE_ANON_KEY` | **Yes** | `eyJhbGci...` | Public anonymous key for client operations. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | `eyJhbGci...` | **CONFIDENTIAL**: Server-only key used exclusively by backend repositories. |
| `SUPABASE_JWT_SECRET` | No | `secret...` | Optional secret for decoding Supabase Auth Bearer JWT tokens. |
| `JWT_ACCESS_SECRET` | **Yes** | *>=32 random chars* | High-entropy secret for signing short-lived 15m access JWTs. |
| `JWT_REFRESH_SECRET` | **Yes** | *>=32 random chars* | High-entropy secret for signing 7d rotating refresh JWTs. |
| `JWT_ACCESS_TTL` | No | `15m` | Access token lifetime. |
| `JWT_REFRESH_TTL` | No | `7d` | Refresh token lifetime. |
| `EMAIL_PROVIDER` | **Yes** | `smtp` | Set to `smtp` in production (`dev` only buffers in memory). |
| `SMTP_HOST` | If smtp | `smtp.sendgrid.net` | Outgoing mail server host. |
| `SMTP_PORT` | If smtp | `587` | TLS port. |
| `SMTP_USER` | If smtp | `apikey` | SMTP credentials. |
| `SMTP_PASS` | If smtp | `SG.secret...` | SMTP password. Never logged. |
| `EMAIL_FROM` | If smtp | `LabPulse <noreply@labpulse.edu>` | Verified outgoing sender address. |
| `ADMIN_NAME` | Boot only | `Platform Administrator` | Used once during initial seeding, then unset. |
| `ADMIN_EMAIL` | Boot only | `admin@labpulse.edu` | Used once during initial seeding, then unset. |
| `ADMIN_PASSWORD` | Boot only | *High-entropy password* | Used once during initial seeding, then **immediately deleted**. |

---

## 4. Database Migrations Execution

Before launching the web service, execute all 11 versioned SQL migrations in strict sequence against the production PostgreSQL database:

```bash
# Option A: Using the Supabase CLI
supabase db push

# Option B: Applying individual migrations via psql or Supabase SQL Editor
# (Execute sequentially from supabase/migrations/):
# 1. 20261012000001_extensions_and_prerequisites.sql
# 2. 20261012000002_core_schema.sql
# 3. 20261012000003_constraints_and_indexes.sql
# 4. 20261012000004_row_level_security.sql
# 5. 20261012000005_atomic_functions_and_triggers.sql
# 6. 20261012000006_qr_access_pass_hardening.sql
# 7. 20261012000007_notifications_enhancement.sql
# 8. 20261012000008_user_qualifications_membership.sql
# 9. 20261012000009_audit_logs_compliance.sql
# 10. 20261012000010_search_filtering_export_indexes.sql
# 11. 20261012000011_analytics_operational_intelligence.sql
```

---

## 5. Deployment Options

### Option A: Render Cloud (`render.yaml`)

The repository includes a production-ready `render.yaml` specification:

1. Connect the GitHub repository to your Render team account.
2. Create a new **Blueprint Instance** pointing to `render.yaml`.
3. In the Render Dashboard, fill in the non-synced environment variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `APP_URL`).
4. Render will run `npm ci --omit=dev` and start `node server.js`.
5. Automatic zero-downtime healthcheck probes will query `/api/v1/health/liveness`.

### Option B: Docker Container (`Dockerfile`)

The container build uses standard multi-stage Alpine images running under an unprivileged user:

```bash
# Build the production container
docker build -t labpulse:latest .

# Run the container with environment variables
docker run -d \
  --name labpulse \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATA_BACKEND=supabase \
  -e SUPABASE_URL="https://your-project.supabase.co" \
  -e SUPABASE_SERVICE_ROLE_KEY="your-service-key" \
  -e JWT_ACCESS_SECRET="your-32-char-access-secret" \
  -e JWT_REFRESH_SECRET="your-32-char-refresh-secret" \
  labpulse:latest
```

---

## 6. Security Hardening & Runtime Policies

1. **HTTPS & Strict-Transport-Security (HSTS)**:
   - In production, HSTS is automatically injected: `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
   - TLS termination occurs at the proxy edge with modern cipher suites.
2. **Security Headers**:
   - `X-Content-Type-Options: nosniff` (MIME-sniffing prevention)
   - `X-Frame-Options: SAMEORIGIN` (Clickjacking defense)
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `X-XSS-Protection: 0` (Sanitizer-bypass defense)
3. **Secure Cookie Configuration**:
   - Refresh tokens are issued in an `httpOnly: true`, `secure: true`, `sameSite: 'lax'` cookie scoped strictly to `/api/v1/auth`.
   - Access tokens are stored in memory only.
4. **CORS Allowlist**:
   - Explicit matching against `ALLOWED_ORIGINS` and `APP_URL`. Wildcards (`*`) are disallowed for authenticated requests.
5. **Rate Limiting**:
   - Global API limiter: 300 requests per 15 minutes.
   - Authentication limiter: 20 login attempts per 15 minutes.
   - Password reset limiter: 10 attempts per 15 minutes.
6. **Graceful Shutdown**:
   - Listens for `SIGTERM` and `SIGINT`. Drains active HTTP requests over a 10-second window before exiting cleanly.

---

## 7. Operational Observability & Health Probes

| Endpoint | Probe Type | Purpose / Behavior |
| :--- | :--- | :--- |
| `GET /api/v1/health/liveness` | **Liveness Probe** | Returns HTTP 200 `{ status: 'alive' }` immediately without hitting the database. Prevents container restart storms during transient DB hiccups. |
| `GET /api/v1/health/readiness` | **Readiness Probe** | Verifies database connectivity. Returns HTTP 200 when ready, HTTP 503 when the database is unreachable or degraded. |
| `GET /api/v1/health` | **Status Dashboard** | Full operational diagnostic report detailing active backend, database status, and ISO timestamp. |

---

## 8. Backup, Disaster Recovery & Rollback Strategy

1. **PostgreSQL Automated Backups**:
   - Supabase automatically captures daily database backups.
   - For enterprise production, enable **Point-in-Time Recovery (PITR)** to allow rollbacks to any given second within the retention window.
2. **Manual Pre-Deployment Snapshots**:
   ```bash
   # Capture a pre-deployment database dump
   pg_dump "postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres" > pre_deploy_backup_$(date +%Y%m%d).sql
   ```
3. **Application Rollback**:
   - The application service is completely stateless. Reverting a deployment takes seconds by rolling back the Docker image tag or Git commit in Render.
   - All 11 SQL migrations are strictly additive or backward-compatible; rolling back application code does not require dropping columns.

---

## 9. First-Boot Seeding Checklist

1. Apply all 11 database migrations.
2. Set `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in production secrets.
3. Run admin bootstrap script:
   ```bash
   node scripts/seed-admin.js
   ```
4. Verify admin user created in `public.profiles`.
5. **Immediately unset `ADMIN_PASSWORD` from production environment variables.**
6. (Optional) Seed standard equipment catalog:
   ```bash
   node scripts/seed-catalog.js
   ```
7. Verify equipment in `public.instruments` and `public.laboratories`.

---

## 10. Post-Deployment Smoke Verification

1. `curl -f https://your-domain.com/api/v1/health/liveness` → expect `200 OK`.
2. `curl -f https://your-domain.com/api/v1/health/readiness` → expect `200 OK`.
3. Open `https://your-domain.com/login.html` → log in with admin credentials.
4. Verify Admin Dashboard loads Section 6 Operational Intelligence.
5. Verify SSL/TLS padlock and `HSTS` headers present.
6. Verify audit log recorded for the login event in `public.audit_logs`.
