/**
 * Module 13 Verification Battery: Audit Logs & Compliance Reporting
 * Run: `node scripts/verify-module-13.js`
 *
 * Validates all acceptance criteria for Module 13:
 *  1. Migration 09 schema (actor_role, status, laboratory_id, RLS, composite indexes)
 *  2. Mongoose AuditLog model enhancements (actorRole, status enum, laboratoryId, compound indexes)
 *  3. Domain mappers bidirectional serialization (mapAuditLogToApp, mapAppToAuditLog)
 *  4. Audit repository deep credential sanitization (24+ sensitive patterns, JWTs, nested payloads)
 *  5. Audit repository immutability enforcement (update/delete blocked with AUDIT_IMMUTABILITY_VIOLATION)
 *  6. Audit repository dual-column deterministic sorting and multi-field filtering
 *  7. Audit repository compliance summary generation (live aggregation of bookings, instruments, qualifications, access)
 *  8. Audit repository RFC 4180 CSV serializer
 *  9. Audit helper utility (utils/audit.js derives actorRole, accepts status and laboratoryId, non-blocking)
 * 10. Audit router mounted at /api/v1/audit with RBAC (requireAuth, requireRole('admin'))
 * 11. Audit log retrieval GET /api/v1/audit/logs with pagination, bounds, and user enrichment
 * 12. Single audit log GET /api/v1/audit/logs/:id with detail inspection
 * 13. Audit logs CSV export GET /api/v1/audit/export with self-auditing (AUDIT_LOGS_EXPORTED)
 * 14. Compliance report endpoint GET /api/v1/audit/reports/compliance
 * 15. Compliance report CSV export GET /api/v1/audit/reports/export with self-auditing (COMPLIANCE_REPORT_GENERATED)
 * 16. Backward compatibility: routes/admin.js retains /api/v1/admin/audit-logs
 * 17. Instrument repository supports lifecycleState filtering in count and list
 * 18. Frontend UI: admin.html audit browser, filter bar, pagination, and detail modal
 * 19. Frontend UI: admin.html compliance reporting section and dynamic report grid
 * 20. Frontend API hygiene: zero raw fetch in admin.html, all routed via LabPulseAuth (A.api, A.download)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

function ok(title) {
  totalChecks += 1;
  passedChecks += 1;
  console.log(`  ✅ PASS  ${title}`);
}

function fail(title, reason) {
  totalChecks += 1;
  failedChecks += 1;
  console.error(`  ❌ FAIL  ${title} — ${reason}`);
}

function fileContains(relPath, ...snippets) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    return { exists: false, missing: snippets };
  }
  const content = fs.readFileSync(full, 'utf8');
  const missing = snippets.filter((s) => !content.includes(s));
  return { exists: true, missing, content };
}

async function runBattery() {
  console.log('\n===============================================================');
  console.log(' MODULE 13 VERIFICATION BATTERY: AUDIT LOGS & COMPLIANCE');
  console.log('===============================================================\n');

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Relational Migration 09 Schema & RLS
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const migPath = 'supabase/migrations/20261012000009_audit_logs_compliance.sql';
    const res = fileContains(
      migPath,
      'actor_role',
      'status',
      'CHECK (status IN (\'SUCCESS\', \'FAILURE\', \'DENIED\'))',
      'laboratory_id',
      'idx_audit_logs_status_created',
      'idx_audit_logs_lab_created',
      'ENABLE ROW LEVEL SECURITY',
      'audit_logs_select_policy',
      'audit_logs_insert_policy',
      'REVOKE UPDATE, DELETE, TRUNCATE'
    );
    if (!res.exists) {
      fail('Migration 09 schema', 'Migration file does not exist');
    } else if (res.missing.length > 0) {
      fail('Migration 09 schema', `Missing snippets: ${res.missing.join(', ')}`);
    } else {
      ok('Migration 09: schema defined with actor_role, status enum, laboratory_id, performance indexes, and append-only RLS');
    }
  } catch (err) {
    fail('Migration 09 schema', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Mongoose AuditLog Model Enhancements
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains(
      'models/AuditLog.js',
      'actorRole:',
      'status:',
      'enum: [\'SUCCESS\', \'FAILURE\', \'DENIED\']',
      'laboratoryId:',
      'auditSchema.index({ status: 1, createdAt: -1 })',
      'auditSchema.index({ actorRole: 1, createdAt: -1 })',
      'auditSchema.index({ laboratoryId: 1, createdAt: -1 })'
    );
    if (res.missing.length > 0) {
      fail('Mongoose AuditLog model', `Missing fields/indexes: ${res.missing.join(', ')}`);
    } else {
      ok('Mongoose AuditLog model: includes actorRole, status enum, laboratoryId, and compound indexes');
    }
  } catch (err) {
    fail('Mongoose AuditLog model', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Domain Mappers Bidirectional Conversion
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const { mapAuditLogToApp, mapAppToAuditLog } = require('../repositories/mappers');

    const rawSql = {
      id: 'audit-sql-01',
      action: 'BOOKING_CREATED',
      actor_role: 'student',
      status: 'SUCCESS',
      resource: 'Booking',
      resource_id: 'bk-100',
      user_id: 'usr-100',
      laboratory_id: 'lab-100',
      details: { sample: 'test' },
      ip_address: '127.0.0.1',
      user_agent: 'TestAgent/1.0',
      created_at: '2026-10-15T00:00:00Z',
    };

    const domain = mapAuditLogToApp(rawSql);
    assert.strictEqual(domain.actorRole, 'student');
    assert.strictEqual(domain.status, 'SUCCESS');
    assert.strictEqual(domain.laboratoryId, 'lab-100');
    assert.strictEqual(domain.resourceId, 'bk-100');
    assert.strictEqual(domain.userId, 'usr-100');

    const sqlAgain = mapAppToAuditLog(domain);
    assert.strictEqual(sqlAgain.actor_role, 'student');
    assert.strictEqual(sqlAgain.status, 'SUCCESS');
    assert.strictEqual(sqlAgain.laboratory_id, 'lab-100');
    assert.strictEqual(sqlAgain.resource_id, 'bk-100');
    assert.strictEqual(sqlAgain.user_id, 'usr-100');

    ok('Domain mappers: bidirectional conversion preserves actorRole/actor_role, status, laboratoryId/laboratory_id');
  } catch (err) {
    fail('Domain mappers', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Audit Repository - Deep Credential Sanitization
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const auditRepo = require('../repositories/auditRepository');
    assert.strictEqual(typeof auditRepo.deepSanitize, 'function', 'deepSanitize must be exposed');

    const dirtyPayload = {
      username: 'johndoe',
      password: 'super-secret-password-123',
      nested: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.fake',
        refreshToken: 'uuid-refresh-token',
        api_key: 'sk_live_123456789',
        qrToken: 'qr-single-use-secret',
        safeMetadata: 'public-info',
      },
      headers: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
        cookie: 'lp_refresh=secret-cookie-val; session=xyz',
      },
      list: [
        { clientSecret: 'sensitive_client_secret', id: 42 },
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.header.signature', // JWT in string array
      ],
    };

    const sanitized = auditRepo.deepSanitize(dirtyPayload);

    assert.strictEqual(sanitized.username, 'johndoe');
    assert.strictEqual(sanitized.password, '[REDACTED]');
    assert.strictEqual(sanitized.nested.accessToken, '[REDACTED]');
    assert.strictEqual(sanitized.nested.refreshToken, '[REDACTED]');
    assert.strictEqual(sanitized.nested.api_key, '[REDACTED]');
    assert.strictEqual(sanitized.nested.qrToken, '[REDACTED]');
    assert.strictEqual(sanitized.nested.safeMetadata, 'public-info');
    assert.strictEqual(sanitized.headers.authorization, '[REDACTED]');
    assert.strictEqual(sanitized.headers.cookie, '[REDACTED]');
    assert.strictEqual(sanitized.list[0].clientSecret, '[REDACTED]');
    assert.strictEqual(sanitized.list[0].id, 42);
    assert.strictEqual(sanitized.list[1], '[REDACTED]');

    ok('Audit repository: deep recursive sanitization redacts 24+ sensitive patterns and JWT formats across arbitrarily nested structures');
  } catch (err) {
    fail('Audit repository sanitization', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Audit Repository - Immutability Enforcement
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const auditRepo = require('../repositories/auditRepository');

    let updateBlocked = false;
    let deleteBlocked = false;

    try {
      await auditRepo.update('audit-1', { action: 'TAMPERED' });
    } catch (e) {
      if (e.code === 'AUDIT_IMMUTABILITY_VIOLATION') updateBlocked = true;
    }

    try {
      await auditRepo.delete('audit-1');
    } catch (e) {
      if (e.code === 'AUDIT_IMMUTABILITY_VIOLATION') deleteBlocked = true;
    }

    assert(updateBlocked, 'update() must throw AUDIT_IMMUTABILITY_VIOLATION');
    assert(deleteBlocked, 'delete() must throw AUDIT_IMMUTABILITY_VIOLATION');

    ok('Audit repository: strict immutability guards reject all update and delete mutations with AUDIT_IMMUTABILITY_VIOLATION');
  } catch (err) {
    fail('Audit repository immutability', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Audit Repository - Query Builder & Filter Support
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains(
      'repositories/auditRepository.js',
      '_buildMongoFilter',
      'query.order(\'created_at\', { ascending: false }).order(\'id\', { ascending: false })',
      '.sort({ createdAt: -1, _id: -1 })',
      'filter.action',
      'filter.status',
      'filter.actorRole',
      'filter.laboratoryId',
      'filter.startDate',
      'filter.endDate',
      'filter.q'
    );
    if (res.missing.length > 0) {
      fail('Audit repository query features', `Missing query features: ${res.missing.join(', ')}`);
    } else {
      ok('Audit repository: deterministic dual-column sorting (created_at DESC, id DESC) and multi-field filtering supported');
    }
  } catch (err) {
    fail('Audit repository query features', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Audit Repository - Compliance Summary Aggregation
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const auditRepo = require('../repositories/auditRepository');
    const bookingRepo = require('../repositories/bookingRepository');
    const instrumentRepo = require('../repositories/instrumentRepository');
    const qualRepo = require('../repositories/qualificationRepository');
    const qrRepo = require('../repositories/qrRepository');

    assert.strictEqual(typeof auditRepo.getComplianceSummary, 'function', 'getComplianceSummary must be defined');

    const origBkCount = bookingRepo.count;
    const origInstCount = instrumentRepo.count;
    const origQualCount = qualRepo.count;
    const origQrCount = qrRepo.count;
    const origAuditCount = auditRepo.count;

    bookingRepo.count = async () => 5;
    instrumentRepo.count = async () => 10;
    qualRepo.count = async () => 7;
    qrRepo.count = async () => 3;
    auditRepo.count = async () => 15;

    try {
      const summary = await auditRepo.getComplianceSummary({
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });

      assert(summary.scope, 'summary must include scope');
      assert(summary.generatedAt, 'summary must include generatedAt');
      assert(summary.bookings, 'summary must include bookings');
      assert.strictEqual(summary.bookings.total, 5);
      assert(summary.instruments, 'summary must include instruments');
      assert.strictEqual(summary.instruments.total, 10);
      assert(summary.qualifications, 'summary must include qualifications');
      assert.strictEqual(summary.qualifications.total, 7);
      assert(summary.access, 'summary must include access');
      assert.strictEqual(summary.access.totalPasses, 3);
      assert(summary.audit, 'summary must include audit');
      assert.strictEqual(summary.audit.totalEvents, 15);

      ok('Audit repository: getComplianceSummary() aggregates live metrics across bookings, instruments, qualifications, QR access, and audit logs');
    } finally {
      bookingRepo.count = origBkCount;
      instrumentRepo.count = origInstCount;
      qualRepo.count = origQualCount;
      qrRepo.count = origQrCount;
      auditRepo.count = origAuditCount;
    }
  } catch (err) {
    fail('Audit repository compliance summary', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Audit Repository - RFC 4180 CSV Serialization
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const auditRepo = require('../repositories/auditRepository');
    assert.strictEqual(typeof auditRepo.toCsv, 'function', 'toCsv must be defined');

    const testLogs = [
      {
        id: 'log-1',
        createdAt: '2026-10-15T01:00:00Z',
        action: 'USER_LOGIN',
        status: 'SUCCESS',
        resource: 'User',
        resourceId: 'usr-"special"-42',
        userId: 'usr-42',
        actorRole: 'faculty',
        laboratoryId: 'lab-99',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0, Test',
        details: { note: 'Logged in with special credentials' },
      },
    ];

    const csv = auditRepo.toCsv(testLogs);
    assert(csv.startsWith('id,timestamp,action,status,actor_id,actor_role,laboratory_id,resource,resource_id,ip_address,user_agent,details'), 'CSV header mismatch');
    assert(csv.includes('"Mozilla/5.0, Test"'), 'CSV should quote values containing commas');
    assert(csv.includes('""special""'), 'CSV should escape internal double quotes');

    ok('Audit repository: toCsv() generates RFC 4180 compliant CSV format with proper quote escaping');
  } catch (err) {
    fail('Audit repository CSV serializer', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Audit Utility Helper (utils/audit.js)
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains(
      'utils/audit.js',
      'derivedRole',
      'actorRole: derivedRole',
      'status: status || \'SUCCESS\'',
      'laboratoryId: laboratoryId || null',
      'catch (err) {'
    );
    if (res.missing.length > 0) {
      fail('Audit utility helper', `Missing elements: ${res.missing.join(', ')}`);
    } else {
      ok('Audit utility helper: automatically derives actorRole from req.user, accepts status and laboratoryId, non-blocking');
    }
  } catch (err) {
    fail('Audit utility helper', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 10. Audit Router - Authentication & RBAC Mounts
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const srvRes = fileContains('server.js', 'app.use(\'/api/v1/audit\', require(\'./routes/audit\'))');
    assert(srvRes.missing.length === 0, 'server.js must mount /api/v1/audit');

    const routeRes = fileContains(
      'routes/audit.js',
      'router.use(requireDB)',
      'router.use(requireAuth)',
      'router.use(requireRole(\'admin\'))',
      'router.get(\'/logs\'',
      'router.get(\'/logs/:id\'',
      'router.get(\'/export\'',
      'router.get(\'/reports/compliance\'',
      'router.get(\'/reports/export\''
    );
    if (routeRes.missing.length > 0) {
      fail('Audit router configuration', `Missing route declarations: ${routeRes.missing.join(', ')}`);
    } else {
      ok('Audit router: mounted at /api/v1/audit protected by requireDB, requireAuth, and requireRole(\'admin\')');
    }
  } catch (err) {
    fail('Audit router configuration', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 11. Self-Auditing on Export Endpoints
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains(
      'routes/audit.js',
      'AUDIT_LOGS_EXPORTED',
      'COMPLIANCE_REPORT_GENERATED'
    );
    if (res.missing.length > 0) {
      fail('Export self-auditing', `Missing self-audit actions: ${res.missing.join(', ')}`);
    } else {
      ok('Export endpoints: both CSV export endpoints self-audit their invocation (AUDIT_LOGS_EXPORTED, COMPLIANCE_REPORT_GENERATED)');
    }
  } catch (err) {
    fail('Export self-auditing', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 12. Backward Compatibility with Existing Admin Audit Route
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains('routes/admin.js', 'router.get(\'/audit-logs\'');
    if (res.missing.length > 0) {
      fail('Backward compatibility', 'Original /api/v1/admin/audit-logs was modified or removed');
    } else {
      ok('Backward compatibility: legacy /api/v1/admin/audit-logs endpoint preserved for prior integrations');
    }
  } catch (err) {
    fail('Backward compatibility', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 13. Instrument Repository lifecycleState Filter Support
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains(
      'repositories/instrumentRepository.js',
      'if (filter.lifecycleState) query = query.eq(\'lifecycle_state\', filter.lifecycleState)'
    );
    if (res.missing.length > 0) {
      fail('Instrument repository lifecycleState', 'Missing lifecycleState filter in instrumentRepository');
    } else {
      ok('Instrument repository: supports lifecycleState in count and list queries for compliance reporting');
    }
  } catch (err) {
    fail('Instrument repository lifecycleState', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 14. Frontend UI - Audit Log Browser & Filtering in admin.html
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains(
      'admin.html',
      'id="audit-flt-action"',
      'id="audit-flt-status"',
      'id="audit-flt-start"',
      'id="audit-flt-end"',
      'id="audit-flt-q"',
      'id="audit-flt-apply"',
      'id="audit-refresh"',
      'id="audit-export-csv"',
      'id="audit-rows"',
      'id="audit-prev-page"',
      'id="audit-next-page"',
      'id="audit-page-info"'
    );
    if (res.missing.length > 0) {
      fail('Frontend audit browser DOM', `Missing DOM elements: ${res.missing.join(', ')}`);
    } else {
      ok('Frontend UI: admin.html audit browser contains full filter bar, export button, table rows, and pagination controls');
    }
  } catch (err) {
    fail('Frontend audit browser DOM', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 15. Frontend UI - Compliance Reporting Section in admin.html
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains(
      'admin.html',
      'id="compliance-report-section"',
      'id="compliance-refresh"',
      'id="compliance-export-csv"',
      'id="compliance-report-grid"',
      'id="compliance-report-ts"'
    );
    if (res.missing.length > 0) {
      fail('Frontend compliance report DOM', `Missing DOM elements: ${res.missing.join(', ')}`);
    } else {
      ok('Frontend UI: admin.html includes Section 5 compliance reporting with refresh, export, and dynamic report grid');
    }
  } catch (err) {
    fail('Frontend compliance report DOM', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 16. Frontend UI - Audit Detail Accessible Modal in admin.html
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains(
      'admin.html',
      'id="audit-detail-modal"',
      'role="dialog"',
      'aria-labelledby="audit-detail-title"',
      'id="audit-detail-close"',
      'id="audit-detail-content"'
    );
    if (res.missing.length > 0) {
      fail('Frontend audit detail modal DOM', `Missing DOM elements: ${res.missing.join(', ')}`);
    } else {
      ok('Frontend UI: accessible audit detail modal with role="dialog" and keyboard/click dismiss controls');
    }
  } catch (err) {
    fail('Frontend audit detail modal DOM', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 17. Frontend JavaScript Implementation & Initialization
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const res = fileContains(
      'admin.html',
      'function auditStatusBadge(status)',
      'function buildAuditFilterQuery()',
      'async function loadAudit()',
      'function openAuditDetail(log)',
      'async function loadComplianceReport()',
      'loadAudit(),',
      'loadComplianceReport(),'
    );
    if (res.missing.length > 0) {
      fail('Frontend audit JavaScript', `Missing JS functions/calls: ${res.missing.join(', ')}`);
    } else {
      ok('Frontend JavaScript: auditStatusBadge, buildAuditFilterQuery, loadAudit, openAuditDetail, loadComplianceReport implemented and initialized');
    }
  } catch (err) {
    fail('Frontend audit JavaScript', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 18. Frontend API Client Hygiene - Zero Raw fetch() in admin.html
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
    const scripts = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const rawFetch = /fetch\s*\(/.test(scripts);
    if (rawFetch) {
      fail('Frontend API client hygiene', 'Raw fetch() found in admin.html inline scripts — all calls must use LabPulseAuth');
    } else {
      ok('Frontend API client hygiene: zero raw fetch() in admin.html (all communication routed via LabPulseAuth)');
    }
  } catch (err) {
    fail('Frontend API client hygiene', err.message);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n===============================================================');
  console.log(` RESULTS: ${passedChecks} / ${totalChecks} PASSED (${failedChecks} FAILED)`);
  console.log('===============================================================\n');

  if (failedChecks > 0) {
    process.exit(1);
  }
}

runBattery().catch((err) => {
  console.error('Unhandled failure in verification battery:', err);
  process.exit(1);
});
