# MODULE 14: SEARCH, FILTERING & DATA EXPORT IMPLEMENTATION REPORT

## 1. Initial Findings

- **Architecture:** LabPulse utilizes a dual-backend architecture with Supabase PostgreSQL as primary and MongoDB/Mongoose as fallback.
- **Previous State:**
  - Modules 01–13 implemented RBAC, booking lifecycle, instrument management, metrology calibration, maintenance work orders, breakage reporting, operator qualifications, and immutable audit logging.
  - List APIs had basic pagination and single-field equality filters, but lacked unified query parameter parsing, full multi-field server-side search (`q`), safe sort allowlists, and RFC 4180 CSV export endpoints.
  - No spreadsheet formula injection mitigation existed in the codebase.
  - Composite indexes were needed in Supabase PostgreSQL for high-traffic multi-column search and range queries.

## 2. Existing Functionality Reused

- **Audit Logging System (`utils/audit.js`):** Reused `logAudit` from Module 13 to record export events (`INSTRUMENTS_EXPORTED`, `BOOKINGS_EXPORTED`, `USERS_EXPORTED`, `QUALIFICATIONS_EXPORTED`, `MAINTENANCE_EXPORTED`, `CALIBRATIONS_EXPORTED`, `BREAKAGE_EXPORTED`).
- **RBAC Middleware (`middleware/rbac.js` & `middleware/requireAuth.js`):** Enforced role permissions before data querying and CSV serialization.
- **Frontend Client (`auth.js` / `dash.js`):** Utilized `LabPulseAuth.api` (`A.api`) for debounced queries and `LabPulseAuth.download` (`A.download`) for CSV file downloads.
- **Domain Repositories & Mappers (`repositories/`):** Extended existing repositories rather than introducing new routes or services.

## 3. Files Changed

### Created
- [`utils/csv.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/utils/csv.js): Secure RFC 4180 CSV generator with formula injection neutralization and sensitive key exclusion.
- [`utils/queryParser.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/utils/queryParser.js): Unified query parameter parser for safe pagination, allowlisted sorting, control character sanitization, and date range parsing.
- [`supabase/migrations/20261012000010_search_filtering_export_indexes.sql`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/supabase/migrations/20261012000010_search_filtering_export_indexes.sql): PostgreSQL migration defining 8 composite indexes for multi-column search and sorting.
- [`scripts/verify-module-14.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/scripts/verify-module-14.js): Targeted verification battery testing 10 suites (21 checks).

### Modified
- [`repositories/instrumentRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/instrumentRepository.js): Multi-field search (`q`), composable status/category/lifecycle filters, deterministic secondary sorting.
- [`routes/instruments.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/instruments.js): Added `GET /export` with student `breakageFee` stripping and `INSTRUMENTS_EXPORTED` audit.
- [`repositories/bookingRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/bookingRepository.js): Purpose search (`q`), date range filters (`startDate`, `endDate`), deterministic secondary sorting.
- [`routes/bookings.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/bookings.js): Enforced student-scoping on search and added `GET /export` with `BOOKINGS_EXPORTED` audit.
- [`repositories/userRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/userRepository.js): Multi-field search (`q` on name, email, department, IDs), `ALLOWED_USER_SORTS`, `_buildMongoFilter`.
- [`routes/users.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/users.js): Added admin-only `GET /export` with credential stripping and `USERS_EXPORTED` audit.
- [`repositories/qualificationRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/qualificationRepository.js): Multi-field sorting, level filter, and expiry range queries.
- [`routes/qualifications.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/qualifications.js): Enhanced `GET /` and added `GET /export` with `QUALIFICATIONS_EXPORTED` audit.
- [`repositories/maintenanceRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/maintenanceRepository.js): Multi-field search (`q`), status/type/date range filters, safe sorting.
- [`routes/maintenance.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/maintenance.js): Added `GET /export` with `MAINTENANCE_EXPORTED` audit.
- [`repositories/calibrationRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/calibrationRepository.js): Multi-field search (`q`), status/result/date filters, safe sorting.
- [`routes/calibrations.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/calibrations.js): Added `GET /export` with `CALIBRATIONS_EXPORTED` audit.
- [`repositories/breakageRepository.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/repositories/breakageRepository.js): Multi-field search (`q`), severity filter, safe sorting.
- [`routes/breakage.js`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/routes/breakage.js): Added `GET /export` with student report isolation, non-admin `breakageFee` exclusion, and `BREAKAGE_EXPORTED` audit.
- [`admin.html`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/admin.html): Added search inputs with 300ms debounce and CSV export buttons wired via `A.download()`.
- [`package.json`](file:///c:/Users/name/OneDrive/VS%20code/FSD%20pro/package.json): Registered `"test:module-14"`.

## 4. Search Implementation

- **Instruments:** Multi-field ILIKE / regex search across `name`, `model`, `assetTag`, `manufacturer`, and `category`.
- **Bookings:** Server-side search on `purpose` field.
- **Users (Admin Only):** Search across identity fields: `name`, `email`, `department`, `studentId`, `facultyId`. Credentials and security tokens are excluded from search.
- **Maintenance:** Search across `description`, `workPerformed`, `partsReplaced`, `resolutionNotes`.
- **Calibration:** Search across `calibrationType`, `standard`, `referenceStandard`, `certificateNumber`, `notes`.
- **Breakage Reports:** Search across `issueType`, `description`, `resolutionNotes`.
- **Sanitization:** All search terms are stripped of control characters (ASCII 0x00–0x1F, 0x7F) and truncated to safe length.

## 5. Filter Implementation

- **Instruments:** Composable filters for `category`, `status`, `laboratoryId`, `lifecycleState`, and `requiredQualificationLevel`.
- **Bookings:** Composable filters for `status`, `laboratoryId`, `instrumentId`, `userId`, `startDate`, and `endDate`.
- **Qualifications:** Composable filters for `status`, `level`, `userId`, and `instrumentId`.
- **Maintenance:** Composable filters for `status`, `type` (`preventive` | `corrective`), `instrumentId`, and date ranges.
- **Calibration:** Composable filters for `status`, `result` (`PASSED` | `FAILED` | `PENDING`), `instrumentId`, and date ranges.
- **Breakage:** Composable filters for `status`, `severity` (`LOW` | `MEDIUM` | `HIGH` | `CRITICAL`), and `instrumentId`.

## 6. Pagination & Sorting Implementation

- **Pagination:** Handled by `parsePagination(query, defaultLimit, maxLimit)`:
  - Default: 20 records per page.
  - Safe upper bound: 100 records max per request (prevents DoS via `?limit=1000000`).
  - Strict minimum: `page >= 1`.
  - Returns `page`, `limit`, `total`, and `totalPages`.
- **Sorting:** Handled by `parseSort(query, allowedSortMap, defaultField, defaultOrder)`:
  - Validates sort keys against strict per-resource allowlists; arbitrary SQL/NoSQL fragments fallback safely to the default field.
  - Deterministic secondary sorting (`_id: -1` in Mongo, `id DESC` in Postgres) prevents inconsistent pagination across requests.

## 7. Export Implementation

- **Format:** CSV with UTF-8 encoding and `Content-Disposition: attachment; filename="<resource>-YYYY-MM-DD.csv"`.
- **Bounded Rows:** Max 1000 rows per export to prevent server memory saturation.
- **Formula Injection Defense:** Any cell beginning with `=`, `+`, `-`, `@`, `\t`, or `\r` (raw or after leading whitespace) is prepended with `'` per OWASP guidelines.
- **RFC 4180 Escaping:** Cells containing commas, quotes, newlines, or leading quotes are enclosed in quotes, with internal quotes doubled (`""`).
- **Sensitive Field Blacklist:** Automatic exclusion of `password`, `hash`, `token`, `jwt`, `secret`, `apiKey`, `cookie`, `creditCard`, `cvv`, `ssn`.
- **Privilege-Aware Column Scoping:**
  - `breakageFee` is stripped from instruments and breakage reports for students and non-admin users.
  - Students cannot export other users' bookings or breakage reports.

## 8. Security & RLS Checks

1. **Role Scoping:**
   - Students querying `/api/v1/bookings` or `/api/v1/bookings/export` have `filter.userId` forced to `req.user.id`.
   - Students querying `/api/v1/breakage-reports/export` have `filter.reportedBy` forced to `req.user.id`.
2. **Admin-Only Boundary:** User directory export (`/api/v1/admin/users/export`) strictly requires `admin` role.
3. **Audit Trail:** Privileged exports log audit events with actor ID, role, record count, and filter parameters.
4. **Injection Immunity:** Client-provided `sort` or `sortBy` values cannot introduce arbitrary SQL; allowlist rejection guarantees parameter safety.

## 9. Targeted Tests Executed

Commands executed:
- `node scripts/verify-module-14.js`
- `npm run test:module-14`
- `node scripts/check-frontend.js`

## 10. Actual Test Results

```text
> labpulse@0.1.0 test:module-14
> node scripts/verify-module-14.js

===============================================================
  LABPULSE MODULE 14: SEARCH, FILTERING & DATA EXPORT TEST BATTERY
===============================================================

--- SUITE 1: CSV Security & Sanitization ---
  ✅ PASS  Formula injection characters (=, +, -, @, \t, \r) are neutralised with single-quote prefix
  ✅ PASS  RFC 4180 quotes and commas escaped cleanly
  ✅ PASS  Sensitive security fields (passwords, JWTs, API keys, CCs) stripped from exports

--- SUITE 2: Unified Query Parser ---
  ✅ PASS  Pagination parser enforces bounds (page >= 1, limit <= maxLimit)
  ✅ PASS  Sort parser uses strict allowlists and rejects SQL injection / unlisted columns
  ✅ PASS  Search term sanitizer trims, limits length, and strips control characters
  ✅ PASS  Date range parser validates ISO dates and rejects inverted ranges

--- SUITE 3: Database Composite Indexes (Migration 10) ---
  ✅ PASS  Migration 10 defines composite indexes for search, status, and date sorting

--- SUITE 4: Instrument Search, Filtering & Export ---
  ✅ PASS  Instrument repository supports multi-field search, composable filters, and safe sorting
  ✅ PASS  Instruments route provides /export endpoint, audits exports, and hides breakageFee from students

--- SUITE 5: Booking Search, Role-Aware Filtering & Export ---
  ✅ PASS  Booking repository supports purpose search, date range filtering, and deterministic sorting
  ✅ PASS  Bookings route enforces student-scoping on search and export with BOOKINGS_EXPORTED audit

--- SUITE 6: User Administration Search & Security ---
  ✅ PASS  User repository supports multi-field search and allowlisted sorting
  ✅ PASS  Users route restricts export to admin, strips credentials, and logs USERS_EXPORTED

--- SUITE 7: Operator Qualification Filtering & Export ---
  ✅ PASS  Qualification repository supports sorting, level, and expiry window filters
  ✅ PASS  Qualifications route provides /export and audits QUALIFICATIONS_EXPORTED

--- SUITE 8: Maintenance & Calibration Search & Export ---
  ✅ PASS  Maintenance route supports search, date ranges, and audited CSV export
  ✅ PASS  Calibration route supports search, status, and audited CSV export

--- SUITE 9: Breakage Reports Search & Scoping ---
  ✅ PASS  Breakage route scopes student exports and hides breakageFee from non-admins

--- SUITE 10: Frontend UI Integration & Hygiene ---
  ✅ PASS  admin.html integrates search inputs, 300ms debouncing, and CSV export buttons
  ✅ PASS  admin.html maintains strict API hygiene (0 raw fetch() calls; all routed via LabPulseAuth)

===============================================================
  MODULE 14 VERIFICATION SUMMARY: 21/21 PASS
===============================================================

🎉 All Module 14 search, filtering, and export requirements verified successfully.
```

```text
node scripts/check-frontend.js
  PASS JS-referenced IDs exist (25 checked)
  PASS inline handlers defined (6 checked)
  PASS no window.alert (0 found)
  PASS booking flow money-free (0 offending lines)
  PASS local assets served (9 refs)
  ...
  PASS admin.html: inline IDs resolve (104 checked)
  PASS admin.html: no competing API client
  PASS dash.js: no direct fetch

CHECK OK
```

## 11. Known Limitations

- CSV export is bounded to 1,000 records per request. For multi-million row historical datasets, asynchronous chunked worker queues would be needed.
- Full-text search leverages PostgreSQL native `ILIKE` pattern matching with composite indexes. Full Postgres `tsvector` / GIN indexing could be introduced if search corpus grows beyond 100,000 active assets.

## 12. Manual Verification Steps

1. **Instrument Search & Export:**
   - Log into Admin console (`admin.html`).
   - Type "Microscope" into the instrument search box; verify results debounce and update without page reload.
   - Click "EXPORT CSV"; verify `instruments-YYYY-MM-DD.csv` downloads, opens cleanly in Excel, and formula characters are escaped.
2. **Booking Search & Scoping:**
   - Filter bookings by status "PENDING" and date range; verify rows reflect the composable conditions.
   - Click "EXPORT CSV"; verify exported CSV contains only matching reservations.
3. **Formula Injection Test:**
   - Inspect exported CSV cells starting with `=`, `+`, `-`, `@`; verify they are prepended with `'` and do not execute code.

## 13. Short Checklist for Module 15

- [ ] Ensure any newly added search/export endpoints are documented in API references.
- [ ] Maintain the single-quote formula injection mitigation across any future export formats.
- [ ] Verify that new entity additions in Module 15 adhere to the unified `parsePagination` and `parseSort` allowlists.
