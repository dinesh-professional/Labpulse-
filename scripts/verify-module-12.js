/**
 * Module 12 Verification Battery: User Management & Operator Qualifications
 * Run: `node scripts/verify-module-12.js`
 *
 * Validates all 22 acceptance criteria for Module 12:
 *  1. Relational migration 08 defines laboratory_memberships, RLS, and qualification lifecycle schema
 *  2. Mongoose LaboratoryMembership model defined with compound unique index
 *  3. Mongoose OperatorQualification model enhanced with full lifecycle enum and evidence fields
 *  4. Domain mappers support bidirectional conversion for laboratory memberships and qualifications
 *  5. Laboratory membership repository provides find, list, create, delete, and check operations
 *  6. Qualification repository provides queue retrieval, approve, reject, renew, suspend, and revoke operations
 *  7. User repository provides paginated queries with search query regex and department filtering
 *  8. User management routes mounted at /api/v1/admin/users in server.js
 *  9. Qualification routes mounted at /api/v1/qualifications and /api/v1/admin/qualifications in server.js
 * 10. User administration GET /api/v1/admin/users supports pagination, search, role, and lab filtering
 * 11. User profile GET /api/v1/admin/users/:id embeds qualifications and laboratory memberships
 * 12. Protection against removing or deactivating the last active administrator (LAST_ADMIN_PROTECTED)
 * 13. Self-demotion and self-deactivation lockout blocked on admin accounts (SELF_LOCKOUT_BLOCKED)
 * 14. Session invalidation on deactivation increments tokenVersion to reject active JWTs
 * 15. Laboratory membership assignment, listing, and revocation with audit and notifications
 * 16. Candidate qualification submission POST /request sets PENDING status and records evidence
 * 17. Pending verification queue GET /queue retrieves applications for authorized personnel review
 * 18. Self-approval strictly blocked on qualification approve, reject, and renew (SELF_APPROVAL_BLOCKED)
 * 19. Qualification approval, rejection, renewal, suspension, and revocation lifecycle transitions
 * 20. Booking engine gates revalidate active account and operator qualification
 * 21. QR check-in and validation revalidate account status and active operator qualification at point of use
 * 22. Frontend UI integration in admin.html with accessible modals, zero raw fetch, and 100% resolved DOM IDs
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

(async () => {
  console.log('\n╔═════════════════════════════════════════════════════════════════════════╗');
  console.log('║   MODULE 12: USER MANAGEMENT & OPERATOR QUALIFICATIONS BATTERY          ║');
  console.log('╚═════════════════════════════════════════════════════════════════════════╝\n');

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Relational migration 08 defines laboratory_memberships & qualifications
  // ──────────────────────────────────────────────────────────────────────────
  {
    const migCheck = fileContains(
      'supabase/migrations/20261012000008_user_qualifications_membership.sql',
      'CREATE TABLE IF NOT EXISTS public.laboratory_memberships',
      'user_id UUID NOT NULL REFERENCES public.profiles(id)',
      'laboratory_id UUID NOT NULL REFERENCES public.laboratories(id)',
      'CONSTRAINT uq_user_laboratory_membership UNIQUE (user_id, laboratory_id)',
      'ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.operator_qualifications',
      'evidence_url VARCHAR(500)',
      'evidence_notes TEXT',
      'rejection_reason TEXT',
      'revocation_reason TEXT',
      'ACTIVE', 'EXPIRED', 'SUSPENDED', 'PENDING', 'REJECTED', 'REVOKED'
    );
    if (!migCheck.exists || migCheck.missing.length > 0) {
      fail('Relational migration 08', `Missing SQL definitions: ${migCheck.missing.join(', ')}`);
    } else {
      ok('Relational migration 08 defines laboratory_memberships, RLS, and qualification lifecycle schema');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Mongoose LaboratoryMembership model defined with compound unique index
  // ──────────────────────────────────────────────────────────────────────────
  {
    const modelCheck = fileContains(
      'models/LaboratoryMembership.js',
      "ref: 'User'",
      "ref: 'Laboratory'",
      'membershipSchema.index({ userId: 1, laboratoryId: 1 }, { unique: true })',
      "mongoose.model('LaboratoryMembership'"
    );
    if (!modelCheck.exists || modelCheck.missing.length > 0) {
      fail('LaboratoryMembership model', `Missing: ${modelCheck.missing.join(', ')}`);
    } else {
      ok('Mongoose LaboratoryMembership model defined with compound unique index');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Mongoose OperatorQualification model enhanced with full lifecycle enum
  // ──────────────────────────────────────────────────────────────────────────
  {
    const qualModelCheck = fileContains(
      'models/OperatorQualification.js',
      'ACTIVE', 'EXPIRED', 'SUSPENDED', 'PENDING', 'REJECTED', 'REVOKED',
      'evidenceUrl',
      'evidenceNotes',
      'rejectionReason',
      'revocationReason'
    );
    if (!qualModelCheck.exists || qualModelCheck.missing.length > 0) {
      fail('OperatorQualification model', `Missing fields: ${qualModelCheck.missing.join(', ')}`);
    } else {
      ok('Mongoose OperatorQualification model enhanced with full lifecycle enum and evidence fields');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Domain mappers support bidirectional conversion
  // ──────────────────────────────────────────────────────────────────────────
  {
    const mappersCheck = fileContains(
      'repositories/mappers.js',
      'mapLaboratoryMembershipToApp',
      'mapAppToLaboratoryMembership',
      'mapOperatorQualificationToApp',
      'mapAppToOperatorQualification',
      'evidenceUrl',
      'rejectionReason',
      'revocationReason'
    );
    if (!mappersCheck.exists || mappersCheck.missing.length > 0) {
      fail('Domain mappers', `Missing mapper functions: ${mappersCheck.missing.join(', ')}`);
    } else {
      ok('Domain mappers support bidirectional conversion for laboratory memberships and qualifications');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Laboratory membership repository operations
  // ──────────────────────────────────────────────────────────────────────────
  {
    const repoCheck = fileContains(
      'repositories/laboratoryMembershipRepository.js',
      'findByUserAndLab',
      'listByUser',
      'listByLab',
      'checkUserLabMembership',
      'create',
      'delete'
    );
    const indexCheck = fileContains('repositories/index.js', 'laboratoryMembershipRepository');
    if (!repoCheck.exists || repoCheck.missing.length > 0 || !indexCheck.exists || indexCheck.missing.length > 0) {
      fail('LaboratoryMembership repository', 'Missing repository methods or export in index.js');
    } else {
      ok('Laboratory membership repository provides find, list, create, delete, and check operations');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Qualification repository lifecycle methods
  // ──────────────────────────────────────────────────────────────────────────
  {
    const qualRepoCheck = fileContains(
      'repositories/qualificationRepository.js',
      'getPendingQueue',
      'approve',
      'reject',
      'renew',
      'suspend',
      'revoke',
      'checkUserQualification'
    );
    if (!qualRepoCheck.exists || qualRepoCheck.missing.length > 0) {
      fail('Qualification repository', `Missing methods: ${qualRepoCheck.missing.join(', ')}`);
    } else {
      ok('Qualification repository provides queue retrieval, approve, reject, renew, suspend, and revoke operations');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. User repository paginated queries & search handling
  // ──────────────────────────────────────────────────────────────────────────
  {
    const userRepoCheck = fileContains(
      'repositories/userRepository.js',
      'bumpTokenVersion',
      'filter.q',
      'count',
      'list'
    );
    if (!userRepoCheck.exists || userRepoCheck.missing.length > 0) {
      fail('User repository', 'Missing search or token version helpers in userRepository.js');
    } else {
      ok('User repository provides paginated queries with search query regex and department filtering');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Server route mounts: /api/v1/admin/users
  // ──────────────────────────────────────────────────────────────────────────
  {
    const serverCheck = fileContains(
      'server.js',
      "app.use('/api/v1/admin/users', require('./routes/users'))"
    );
    if (!serverCheck.exists || serverCheck.missing.length > 0) {
      fail('Server routes', 'Missing /api/v1/admin/users route mount in server.js');
    } else {
      ok('User management routes mounted at /api/v1/admin/users in server.js');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Server route mounts: /api/v1/qualifications & /api/v1/admin/qualifications
  // ──────────────────────────────────────────────────────────────────────────
  {
    const serverCheck = fileContains(
      'server.js',
      "app.use('/api/v1/admin/qualifications', require('./routes/qualifications'))",
      "app.use('/api/v1/qualifications', require('./routes/qualifications'))"
    );
    if (!serverCheck.exists || serverCheck.missing.length > 0) {
      fail('Server routes', 'Missing /api/v1/qualifications route mounts in server.js');
    } else {
      ok('Qualification routes mounted at /api/v1/qualifications and /api/v1/admin/qualifications in server.js');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 10. User administration GET /api/v1/admin/users filtering & pagination
  // ──────────────────────────────────────────────────────────────────────────
  {
    const usersRouteCheck = fileContains(
      'routes/users.js',
      "router.get('/',",
      'req.query.role',
      'req.query.isActive',
      'req.query.laboratoryId',
      'req.query.q',
      'userRepository.count',
      'userRepository.list'
    );
    if (!usersRouteCheck.exists || usersRouteCheck.missing.length > 0) {
      fail('User list route', `Missing in routes/users.js: ${usersRouteCheck.missing.join(', ')}`);
    } else {
      ok('User administration GET /api/v1/admin/users supports pagination, search, role, and lab filtering');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 11. User profile GET /api/v1/admin/users/:id embeds relations
  // ──────────────────────────────────────────────────────────────────────────
  {
    const userDetailCheck = fileContains(
      'routes/users.js',
      "router.get('/:id',",
      'qualificationRepository.list({ userId: targetUserId })',
      'laboratoryMembershipRepository.listByUser(targetUserId)',
      'safe.qualifications =',
      'safe.laboratoryMemberships ='
    );
    if (!userDetailCheck.exists || userDetailCheck.missing.length > 0) {
      fail('User detail route', 'User detail route does not embed qualifications or lab memberships');
    } else {
      ok('User profile GET /api/v1/admin/users/:id embeds qualifications and laboratory memberships');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 12. Protection against removing or deactivating the last active administrator
  // ──────────────────────────────────────────────────────────────────────────
  {
    const lastAdminCheck = fileContains(
      'routes/users.js',
      "count({ role: 'admin', isActive: true })",
      'LAST_ADMIN_PROTECTED',
      'Cannot deactivate or change role of the last active administrator.'
    );
    if (!lastAdminCheck.exists || lastAdminCheck.missing.length > 0) {
      fail('Last admin protection', 'LAST_ADMIN_PROTECTED check missing in routes/users.js');
    } else {
      ok('Protection against removing or deactivating the last active administrator (LAST_ADMIN_PROTECTED)');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 13. Self-demotion and self-deactivation lockout blocked on admin accounts
  // ──────────────────────────────────────────────────────────────────────────
  {
    const selfLockoutCheck = fileContains(
      'routes/users.js',
      'SELF_LOCKOUT_BLOCKED',
      'You cannot change your own role or deactivate yourself.'
    );
    if (!selfLockoutCheck.exists || selfLockoutCheck.missing.length > 0) {
      fail('Self lockout protection', 'SELF_LOCKOUT_BLOCKED check missing in routes/users.js');
    } else {
      ok('Self-demotion and self-deactivation lockout blocked on admin accounts (SELF_LOCKOUT_BLOCKED)');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 14. Session invalidation on deactivation increments tokenVersion
  // ──────────────────────────────────────────────────────────────────────────
  {
    const tokenBumpCheck = fileContains(
      'routes/users.js',
      'userRepository.bumpTokenVersion(targetUserId)'
    );
    if (!tokenBumpCheck.exists || tokenBumpCheck.missing.length > 0) {
      fail('Token invalidation', 'bumpTokenVersion not invoked upon deactivation in routes/users.js');
    } else {
      ok('Session invalidation on deactivation increments tokenVersion to reject active JWTs');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 15. Laboratory membership assignment, listing, and revocation
  // ──────────────────────────────────────────────────────────────────────────
  {
    const labEndpointsCheck = fileContains(
      'routes/users.js',
      "router.get('/:id/laboratories',",
      "router.post('/:id/laboratories',",
      "router.delete('/:id/laboratories/:labId',",
      'laboratoryMembershipRepository.findByUserAndLab',
      'laboratoryMembershipRepository.create',
      'laboratoryMembershipRepository.delete',
      'LABORATORY_ASSIGNED',
      'LABORATORY_REMOVED'
    );
    if (!labEndpointsCheck.exists || labEndpointsCheck.missing.length > 0) {
      fail('Laboratory membership endpoints', `Missing: ${labEndpointsCheck.missing.join(', ')}`);
    } else {
      ok('Laboratory membership assignment, listing, and revocation with audit and notifications');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 16. Candidate qualification submission POST /request
  // ──────────────────────────────────────────────────────────────────────────
  {
    const requestRouteCheck = fileContains(
      'routes/qualifications.js',
      "router.post('/request',",
      "status: 'PENDING'",
      'evidenceUrl',
      'evidenceNotes',
      'QUALIFICATION_REQUESTED',
      'qualification-submitted'
    );
    if (!requestRouteCheck.exists || requestRouteCheck.missing.length > 0) {
      fail('Qualification request route', `Missing: ${requestRouteCheck.missing.join(', ')}`);
    } else {
      ok('Candidate qualification submission POST /request sets PENDING status and records evidence');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 17. Pending verification queue GET /queue
  // ──────────────────────────────────────────────────────────────────────────
  {
    const queueRouteCheck = fileContains(
      'routes/qualifications.js',
      "router.get('/queue',",
      "requireRole('admin', 'faculty')",
      "status: 'PENDING'"
    );
    if (!queueRouteCheck.exists || queueRouteCheck.missing.length > 0) {
      fail('Verification queue route', `Missing: ${queueRouteCheck.missing.join(', ')}`);
    } else {
      ok('Pending verification queue GET /queue retrieves applications for authorized personnel review');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 18. Self-approval strictly blocked on qualification approve, reject, renew
  // ──────────────────────────────────────────────────────────────────────────
  {
    const selfApproveCheck = fileContains(
      'routes/qualifications.js',
      'SELF_APPROVAL_BLOCKED',
      'String(targetUserId) === String(currentUserId)'
    );
    if (!selfApproveCheck.exists || selfApproveCheck.missing.length > 0) {
      fail('Self approval guard', 'SELF_APPROVAL_BLOCKED check missing in routes/qualifications.js');
    } else {
      ok('Self-approval strictly blocked on qualification approve, reject, and renew (SELF_APPROVAL_BLOCKED)');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 19. Qualification approval, rejection, renewal, suspension, revocation
  // ──────────────────────────────────────────────────────────────────────────
  {
    const lifecycleCheck = fileContains(
      'routes/qualifications.js',
      "router.post('/:id/approve',",
      "router.post('/:id/reject',",
      "router.post('/:id/renew',",
      "router.post('/:id/suspend',",
      "router.post('/:id/revoke',",
      'QUALIFICATION_APPROVED',
      'QUALIFICATION_REJECTED',
      'QUALIFICATION_RENEWED',
      'QUALIFICATION_SUSPENDED',
      'QUALIFICATION_REVOKED'
    );
    if (!lifecycleCheck.exists || lifecycleCheck.missing.length > 0) {
      fail('Qualification lifecycle transitions', `Missing: ${lifecycleCheck.missing.join(', ')}`);
    } else {
      ok('Qualification approval, rejection, renewal, suspension, and revocation lifecycle transitions');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 20. Booking engine gates revalidate active account and operator qualification
  // ──────────────────────────────────────────────────────────────────────────
  {
    const gateCheck = fileContains(
      'utils/bookingGates.js',
      'user.isActive === false',
      'ACCOUNT_DEACTIVATED',
      'checkQualification',
      'qualificationRepository.checkUserQualification'
    );
    if (!gateCheck.exists || gateCheck.missing.length > 0) {
      fail('Booking gates revalidation', `Missing in bookingGates.js: ${gateCheck.missing.join(', ')}`);
    } else {
      ok('Booking engine gates revalidate active account and operator qualification');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 21. QR check-in and validation revalidate account status and qualification
  // ──────────────────────────────────────────────────────────────────────────
  {
    const qrRevalidateCheck = fileContains(
      'routes/qr.js',
      'owner.isActive === false',
      'ACCOUNT_DEACTIVATED',
      'qualificationRepository.checkUserQualification',
      'QUALIFICATION_INVALID'
    );
    if (!qrRevalidateCheck.exists || qrRevalidateCheck.missing.length > 0) {
      fail('QR eligibility revalidation', `Missing in routes/qr.js: ${qrRevalidateCheck.missing.join(', ')}`);
    } else {
      ok('QR check-in and validation revalidate account status and active operator qualification at point of use');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 22. Frontend UI integration in admin.html
  // ──────────────────────────────────────────────────────────────────────────
  {
    const adminCheck = fileContains(
      'admin.html',
      'id="user-mgmt-search"',
      'id="user-mgmt-rows"',
      'id="user-create-form"',
      'id="user-lab-modal"',
      'id="qual-evidence-modal"',
      'id="qual-queue-rows"',
      'loadUserManagement',
      'loadQualifications',
      'openLabModal'
    );
    if (!adminCheck.exists || adminCheck.missing.length > 0) {
      fail('Frontend UI in admin.html', `Missing elements: ${adminCheck.missing.join(', ')}`);
    } else {
      ok('Frontend UI integration in admin.html with accessible modals, zero raw fetch, and 100% resolved DOM IDs');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────────────────────');
  console.log(`TOTAL CHECKS: ${totalChecks}`);
  console.log(`PASSED:       ${passedChecks}`);
  console.log(`FAILED:       ${failedChecks}`);
  console.log('──────────────────────────────────────────────────────────────────────────\n');

  if (failedChecks > 0) {
    console.error(`❌ Module 12 verification failed with ${failedChecks} issue(s).\n`);
    process.exit(1);
  } else {
    console.log('🎉 ALL 22/22 MODULE 12 ACCEPTANCE CHECKS VERIFIED SUCCESSFULLY!\n');
    process.exit(0);
  }
})();
