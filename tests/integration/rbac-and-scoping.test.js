/**
 * Integration Test Suite: RBAC & Role Boundaries (Module 16)
 * Validates role-based access control, active account enforcement,
 * and privilege isolation across all user roles.
 */
const assert = require('assert');
const { requireRole } = require('../../middleware/rbac');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS [integration/rbac] ${name}`);
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function run() {
  console.log('\n--- Integration: RBAC & Role Isolation ---');

  const adminOnly = requireRole('admin');
  const facultyOrAdmin = requireRole('admin', 'faculty');

  // 1. Unauthenticated request rejected
  {
    const req = {};
    const res = mockResponse();
    let nextCalled = false;
    adminOnly(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'next() must not be called when unauthenticated');
    assert.strictEqual(res.statusCode, 401, 'Status 401 on missing req.user');
    assert.strictEqual(res.body.error.code, 'UNAUTHENTICATED');
    ok('requireRole rejects unauthenticated callers with 401 UNAUTHENTICATED');
  }

  // 2. Inactive account rejected
  {
    const req = { user: { role: 'admin', isActive: false } };
    const res = mockResponse();
    let nextCalled = false;
    adminOnly(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error.code, 'ACCOUNT_INACTIVE');
    ok('requireRole rejects deactivated accounts with 403 ACCOUNT_INACTIVE regardless of role');
  }

  // 3. Student attempting admin-only route
  {
    const req = { user: { role: 'student', isActive: true } };
    const res = mockResponse();
    let nextCalled = false;
    adminOnly(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error.code, 'FORBIDDEN');
    ok('Student role is blocked from admin routes with 403 FORBIDDEN');
  }

  // 4. Faculty attempting admin-only route
  {
    const req = { user: { role: 'faculty', isActive: true } };
    const res = mockResponse();
    let nextCalled = false;
    adminOnly(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error.code, 'FORBIDDEN');
    ok('Faculty role is blocked from admin-only routes with 403 FORBIDDEN');
  }

  // 5. Admin allowed on admin-only route
  {
    const req = { user: { role: 'admin', isActive: true } };
    const res = mockResponse();
    let nextCalled = false;
    adminOnly(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'next() invoked for valid admin');
    ok('Admin role passes adminOnly guard successfully');
  }

  // 6. Faculty allowed on faculty-or-admin route
  {
    const req = { user: { role: 'faculty', isActive: true } };
    const res = mockResponse();
    let nextCalled = false;
    facultyOrAdmin(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    ok('Faculty role passes multi-role guard (admin, faculty)');
  }

  // 7. Student rejected on faculty-or-admin route
  {
    const req = { user: { role: 'student', isActive: true } };
    const res = mockResponse();
    let nextCalled = false;
    facultyOrAdmin(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
    ok('Student role is blocked from faculty/admin routes');
  }

  console.log(`  Summary: ${passed} RBAC & role checks passed.`);
}

run();
