/**
 * User Administration & Laboratory Membership Management (Module 12)
 * Endpoints under /api/v1/admin/users
 *
 * Supported workflows:
 * - Paginated user listing with search (q), role, status, and laboratory filters
 * - Single user profile retrieval with qualifications and laboratory memberships
 * - User profile field updates
 * - Account activation / suspension / deactivation with token version bumping
 * - Last active administrator protection (cannot remove or deactivate last admin)
 * - Self-lockout / self-deactivation protection
 * - Secure invitation creation and resending
 * - Laboratory membership assignment, listing, and removal
 *
 * All routes require requireAuth + requireRole('admin')
 */
const crypto = require('crypto');
const express = require('express');
const {
  userRepository,
  laboratoryRepository,
  laboratoryMembershipRepository,
  qualificationRepository,
  auditRepository,
} = require('../repositories');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/rbac');
const { hashPassword } = require('../utils/password');
const { issueOpaqueToken } = require('../utils/tokens');
const { notifyUser } = require('../services/notify');
const { logAudit } = require('../utils/audit');
const { isValidId } = require('../utils/idValidation');

const router = express.Router();
const adminOnly = requireRole('admin');

router.use(requireAuth, adminOnly);

const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERMITTED_ROLES = ['admin', 'faculty', 'student'];
const INVITE_ROLES = ['faculty', 'student'];

function allowOnly(obj, allowed) {
  const extra = Object.keys(obj || {}).filter((k) => !allowed.includes(k));
  return extra.length ? `Unexpected field(s): ${extra.join(', ')}` : null;
}

function normEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function formatSafeUser(u) {
  if (!u) return null;
  if (typeof u.toSafeJSON === 'function') return u.toSafeJSON();
  return {
    id: u.id || u._id,
    _id: u.id || u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department || null,
    facultyId: u.facultyId || null,
    studentId: u.studentId || null,
    year: u.year || null,
    section: u.section || null,
    isActive: u.isActive !== false,
    emailVerified: !!u.emailVerified,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

const { parsePagination, parseSort, sanitizeSearchTerm } = require('../utils/queryParser');
const { toCsv } = require('../utils/csv');

const ALLOWED_USER_SORTS = {
  name: 'name',
  email: 'email',
  role: 'role',
  department: 'department',
  createdAt: 'createdAt',
};

/* ============================================================================
   0. GET /export — CSV Export of Filtered User Directory (Admin Only)
   ============================================================================ */
router.get('/export', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.role && req.query.role !== 'all' && PERMITTED_ROLES.includes(req.query.role)) {
      filter.role = req.query.role;
    }
    if (req.query.isActive !== undefined && ['true', 'false'].includes(req.query.isActive)) {
      filter.isActive = req.query.isActive === 'true';
    }
    if (req.query.department) {
      filter.department = String(req.query.department).trim().slice(0, 120);
    }
    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) filter.q = term;

    if (req.query.laboratoryId && isValidId(req.query.laboratoryId)) {
      const labMemberships = await laboratoryMembershipRepository.listByLab(req.query.laboratoryId);
      const userIds = labMemberships.map((m) => m.userId || (m.user && m.user.id));
      if (!userIds.length) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        return res.send('name,email,role,department,status,createdAt\r\n');
      }
      filter._id = { $in: userIds };
    }

    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_USER_SORTS, 'createdAt', 'desc');

    const users = await userRepository.list(filter, {
      page: 1,
      limit: 1000,
      sortBy,
      sortOrder,
    });

    const columns = [
      { key: 'id', label: 'User ID', transform: (u) => u.id || u._id },
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'role', label: 'Role' },
      { key: 'department', label: 'Department', transform: (u) => u.department || 'N/A' },
      { key: 'status', label: 'Account Status', transform: (u) => (u.isActive !== false ? 'ACTIVE' : 'INACTIVE') },
      { key: 'facultyId', label: 'Faculty ID', transform: (u) => u.facultyId || '' },
      { key: 'studentId', label: 'Student ID', transform: (u) => u.studentId || '' },
      { key: 'createdAt', label: 'Created At', transform: (u) => (u.createdAt ? new Date(u.createdAt).toISOString() : '') },
    ];

    const csvData = toCsv(users, columns);

    await logAudit({
      userId: req.user._id || req.user.id,
      actorRole: req.user.role,
      action: 'USERS_EXPORTED',
      resource: 'User',
      status: 'SUCCESS',
      details: { count: users.length, filter },
      req,
    });

    const filename = `users-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvData);
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   1. GET / — Paginated User Listing with Filter & Search
   ============================================================================ */
router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.role && req.query.role !== 'all') {
      if (!PERMITTED_ROLES.includes(req.query.role)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'role must be admin, faculty, student, or all.' },
        });
      }
      filter.role = req.query.role;
    }

    if (req.query.isActive !== undefined) {
      if (!['true', 'false'].includes(req.query.isActive)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'isActive must be true or false.' },
        });
      }
      filter.isActive = req.query.isActive === 'true';
    }

    if (req.query.department) {
      filter.department = String(req.query.department).trim().slice(0, 120);
    }

    const term = sanitizeSearchTerm(req.query.q || req.query.search);
    if (term) {
      filter.q = term;
    }

    const { page, limit } = parsePagination(req.query, 20, 100);
    const { sortBy, sortOrder } = parseSort(req.query, ALLOWED_USER_SORTS, 'createdAt', 'desc');

    // Optional laboratory filter
    if (req.query.laboratoryId) {
      if (!isValidId(req.query.laboratoryId)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid laboratoryId.' },
        });
      }
      const labMemberships = await laboratoryMembershipRepository.listByLab(req.query.laboratoryId);
      const userIds = labMemberships.map((m) => m.userId || (m.user && m.user.id));
      if (!userIds.length) {
        return res.json({ success: true, data: { users: [], page, limit, total: 0, totalPages: 1, sortBy, sortOrder } });
      }
      filter._id = { $in: userIds };
    }

    const [total, users] = await Promise.all([
      userRepository.count(filter),
      userRepository.list(filter, { page, limit, sortBy, sortOrder }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;
    return res.json({
      success: true,
      data: {
        users: users.map(formatSafeUser),
        page,
        limit,
        total,
        totalPages,
        sortBy,
        sortOrder,
      },
    });
  } catch (err) { return next(err); }
});

/* ============================================================================
   2. POST /invite — Create and Invite User with Activation Token
   ============================================================================ */
router.post('/invite', async (req, res, next) => {
  try {
    const bad = allowOnly(req.body, ['name', 'email', 'role', 'department', 'facultyId', 'studentId', 'year', 'section']);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });

    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = normEmail(req.body.email);
    const role = req.body.role || 'faculty';

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Name and email are required.' },
      });
    }

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid email address.' },
      });
    }

    if (!INVITE_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invited user role must be faculty or student.' },
      });
    }

    // Unusable placeholder hash — account cannot log in until activation sets a real password
    const placeholder = await hashPassword(crypto.randomBytes(48).toString('hex'));
    const { token, tokenHash } = issueOpaqueToken();

    const currentAdminId = req.user._id || req.user.id;
    const userPayload = {
      name: name.slice(0, 120),
      email,
      passwordHash: placeholder,
      role,
      department: typeof req.body.department === 'string' ? req.body.department.trim().slice(0, 120) : undefined,
      facultyId: role === 'faculty' && typeof req.body.facultyId === 'string' ? req.body.facultyId.trim().slice(0, 60) : undefined,
      studentId: role === 'student' && typeof req.body.studentId === 'string' ? req.body.studentId.trim().slice(0, 60) : undefined,
      year: typeof req.body.year === 'string' ? req.body.year.trim().slice(0, 20) : undefined,
      section: typeof req.body.section === 'string' ? req.body.section.trim().slice(0, 20) : undefined,
      isActive: false,
      emailVerified: false,
      createdBy: currentAdminId,
      activationTokenHash: tokenHash,
      activationExpires: new Date(Date.now() + INVITE_TTL_MS),
    };

    const user = await userRepository.create(userPayload);
    const targetUserId = user._id || user.id;

    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const baseUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || origin).replace(/\/$/, '');
    const activationLink = `${baseUrl}/reset-password.html?token=${encodeURIComponent(token)}`;

    // Send invitation notification & email
    const notifyOutcome = await notifyUser({
      userId: targetUserId,
      type: `${role}-invitation`,
      title: `LabPulse ${role} account activation`,
      message: `Account created for ${user.email}. Activation link expires in 72 hours.`,
      email: {
        to: user.email,
        subject: `LabPulse ${role} account activation`,
        template: `${role}-invitation`,
        data: { name: user.name, activationToken: token, expiresInHours: 72, baseUrl },
      },
    });

    if (process.env.NODE_ENV !== 'test') {
      if (notifyOutcome && notifyOutcome.emailSent) {
        console.log(`[users:invite] Invitation email delivered to ${user.email}`);
      } else {
        console.warn(`[users:invite] Warning: Email delivery to ${user.email} failed (${(notifyOutcome && notifyOutcome.emailError) || 'undelivered'}). Activation link: ${activationLink}`);
      }
    }

    await logAudit({
      userId: currentAdminId,
      action: `${role.toUpperCase()}_INVITED`,
      resource: 'User',
      resourceId: targetUserId,
      details: { email, role },
      req,
    });

    return res.status(201).json({
      success: true,
      data: { user: formatSafeUser(user), activationToken: token, activationLink },
      emailSent: !!(notifyOutcome && notifyOutcome.emailSent),
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} invited. ${notifyOutcome && notifyOutcome.emailSent ? 'Activation email delivered.' : 'Activation link generated.'}`,
    });
  } catch (err) {
    if (err && (err.code === 11000 || err.code === '23505' || err.code === 'DUPLICATE_RESOURCE')) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_TAKEN', message: 'Email is already registered.' },
      });
    }
    return next(err);
  }
});

/* ============================================================================
   2b. POST /:id/resend-invite — Re-issue and Resend Activation Link
   ============================================================================ */
router.post('/:id/resend-invite', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }
    const user = await userRepository.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
    }
    if (user.isActive && user.emailVerified) {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_ACTIVE', message: 'User account is already active and verified.' } });
    }

    const { token, tokenHash } = issueOpaqueToken();
    const expires = new Date(Date.now() + INVITE_TTL_MS);

    const targetUserId = user.id || user._id;
    await userRepository.updateById(targetUserId, {
      activationTokenHash: tokenHash,
      activationExpires: expires,
    });

    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const baseUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || origin).replace(/\/$/, '');
    const activationLink = `${baseUrl}/reset-password.html?token=${encodeURIComponent(token)}`;
    const role = user.role || 'faculty';

    const notifyOutcome = await notifyUser({
      userId: targetUserId,
      type: `${role}-invitation`,
      title: `LabPulse ${role} account activation`,
      message: `New activation link generated for ${user.email}. Link expires in 72 hours.`,
      email: {
        to: user.email,
        subject: `LabPulse ${role} account activation`,
        template: `${role}-invitation`,
        data: { name: user.name, activationToken: token, expiresInHours: 72, baseUrl },
      },
    });

    const currentAdminId = req.user._id || req.user.id;
    await logAudit({
      userId: currentAdminId,
      action: `${role.toUpperCase()}_INVITE_RESENT`,
      resource: 'User',
      resourceId: targetUserId,
      details: { email: user.email },
      req,
    });

    return res.json({
      success: true,
      data: { activationToken: token, activationLink },
      emailSent: !!(notifyOutcome && notifyOutcome.emailSent),
      message: `Invitation link re-issued. ${notifyOutcome && notifyOutcome.emailSent ? 'Email delivered.' : 'Activation link available below.'}`,
    });
  } catch (err) { return next(err); }
});

/* ============================================================================
   3. GET /:id — Retrieve User Detail with Qualifications & Lab Memberships
   ============================================================================ */
router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }

    const user = await userRepository.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
    }

    const targetUserId = user._id || user.id;

    const [qualifications, laboratoryMemberships] = await Promise.all([
      qualificationRepository.list({ userId: targetUserId }),
      laboratoryMembershipRepository.listByUser(targetUserId),
    ]);

    const safe = formatSafeUser(user);
    safe.qualifications = qualifications;
    safe.laboratoryMemberships = laboratoryMemberships;

    return res.json({ success: true, data: { user: safe } });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   4. PATCH /:id — Update User Profile with Last-Admin & Self-Lockout Guards
   ============================================================================ */
router.patch('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }

    const bad = allowOnly(req.body, [
      'name',
      'email',
      'department',
      'facultyId',
      'studentId',
      'year',
      'section',
      'role',
      'isActive',
    ]);
    if (bad) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: bad } });

    const user = await userRepository.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
    }

    const currentUserId = String(req.user._id || req.user.id);
    const targetUserId = String(user._id || user.id);
    const isSelf = targetUserId === currentUserId;

    // Guard: Prevent self-lockout or self-demotion
    if (isSelf && ((req.body.role !== undefined && req.body.role !== user.role) || req.body.isActive === false)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'SELF_LOCKOUT_BLOCKED',
          message: 'You cannot change your own role or deactivate yourself.',
        },
      });
    }

    // Guard: Protect against removal of the last active administrator
    if (user.role === 'admin') {
      const willDemote = req.body.role !== undefined && req.body.role !== 'admin';
      const willDeactivate = req.body.isActive === false && user.isActive === true;

      if (willDemote || willDeactivate) {
        const activeAdmins = await userRepository.count({ role: 'admin', isActive: true });
        if (activeAdmins <= 1) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'LAST_ADMIN_PROTECTED',
              message: 'Cannot deactivate or change role of the last active administrator.',
            },
          });
        }
      }
    }

    const updates = {};
    const changed = [];

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Name must be a non-empty string.' },
        });
      }
      updates.name = req.body.name.trim().slice(0, 120);
      changed.push('name');
    }

    if (req.body.email !== undefined) {
      const email = normEmail(req.body.email);
      if (!EMAIL_RE.test(email)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid email address.' },
        });
      }
      if (email !== user.email) {
        updates.email = email;
        updates.emailVerified = false;
        changed.push('email');
      }
    }

    if (req.body.department !== undefined) {
      updates.department = typeof req.body.department === 'string' ? req.body.department.trim().slice(0, 120) : null;
      changed.push('department');
    }

    if (req.body.facultyId !== undefined) {
      updates.facultyId = typeof req.body.facultyId === 'string' && req.body.facultyId.trim() ? req.body.facultyId.trim().slice(0, 60) : null;
      changed.push('facultyId');
    }

    if (req.body.studentId !== undefined) {
      updates.studentId = typeof req.body.studentId === 'string' && req.body.studentId.trim() ? req.body.studentId.trim().slice(0, 60) : null;
      changed.push('studentId');
    }

    if (req.body.year !== undefined) {
      updates.year = typeof req.body.year === 'string' ? req.body.year.trim().slice(0, 20) : null;
      changed.push('year');
    }

    if (req.body.section !== undefined) {
      updates.section = typeof req.body.section === 'string' ? req.body.section.trim().slice(0, 20) : null;
      changed.push('section');
    }

    if (req.body.role !== undefined) {
      if (!PERMITTED_ROLES.includes(req.body.role)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'role must be admin, faculty, or student.' },
        });
      }
      if (req.body.role !== user.role) {
        updates.role = req.body.role;
        changed.push('role');
      }
    }

    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'isActive must be true or false.' },
        });
      }
      if (req.body.isActive !== user.isActive) {
        updates.isActive = req.body.isActive;
        // Invalidate active session tokens immediately on deactivation
        if (!req.body.isActive) {
          updates.tokenVersion = (user.tokenVersion || 0) + 1;
          await userRepository.bumpTokenVersion(targetUserId);
        }
        changed.push('isActive');
      }
    }

    const updatedUser = await userRepository.updateById(targetUserId, updates);

    await logAudit({
      userId: currentAdminId,
      action: 'USER_UPDATED',
      resource: 'User',
      resourceId: targetUserId,
      details: { changed, updates },
      req,
    });

    return res.json({ success: true, data: { user: formatSafeUser(updatedUser) } });
  } catch (err) {
    if (err && (err.code === 11000 || err.code === '23505' || err.code === 'DUPLICATE_RESOURCE')) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_TAKEN', message: 'Email is already registered.' },
      });
    }
    return next(err);
  }
});

/* ============================================================================
   5. DELETE /:id — Deactivate User (Soft Delete) with Last-Admin Guard
   ============================================================================ */
router.delete('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }

    const user = await userRepository.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
    }

    const currentUserId = String(req.user._id || req.user.id);
    const targetUserId = String(user._id || user.id);

    if (targetUserId === currentUserId) {
      return res.status(400).json({
        success: false,
        error: { code: 'SELF_DELETE_BLOCKED', message: 'You cannot delete or deactivate your own account.' },
      });
    }

    if (user.role === 'admin') {
      const activeAdmins = await userRepository.count({ role: 'admin', isActive: true });
      if (activeAdmins <= 1) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'LAST_ADMIN_PROTECTED',
            message: 'Cannot deactivate or change role of the last active administrator.',
          },
        });
      }
    }

    // Deactivate user and bump token version
    await userRepository.updateById(targetUserId, {
      isActive: false,
      tokenVersion: (user.tokenVersion || 0) + 1,
    });
    await userRepository.bumpTokenVersion(targetUserId);

    await logAudit({
      userId: currentUserId,
      action: 'USER_DEACTIVATED',
      resource: 'User',
      resourceId: targetUserId,
      details: { email: user.email },
      req,
    });

    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   6. POST /:id/resend-invite — Resend Invitation Token
   ============================================================================ */
router.post('/:id/resend-invite', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }

    const user = await userRepository.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
    }

    if (user.isActive && user.emailVerified) {
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_ACTIVE', message: 'User account is already active and verified.' },
      });
    }

    const { token, tokenHash } = issueOpaqueToken();
    const targetUserId = user._id || user.id;

    await userRepository.updateById(targetUserId, {
      activationTokenHash: tokenHash,
      activationExpires: new Date(Date.now() + INVITE_TTL_MS),
    });

    await notifyUser({
      userId: targetUserId,
      type: `${user.role}-invitation`,
      title: 'LabPulse account activation (re-issued)',
      message: `A new activation link has been issued for ${user.email}. Valid for 72 hours.`,
      email: {
        to: user.email,
        subject: 'LabPulse account activation',
        template: `${user.role}-invitation`,
        data: { name: user.name, activationToken: token, expiresInHours: 72 },
      },
    });

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'INVITE_RESENT',
      resource: 'User',
      resourceId: targetUserId,
      details: { email: user.email },
      req,
    });

    return res.json({
      success: true,
      data: { activationToken: token },
      message: 'Invitation resent successfully.',
    });
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   7. Laboratory Membership Management (GET/POST/DELETE)
   ============================================================================ */
router.get('/:id/laboratories', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }

    const memberships = await laboratoryMembershipRepository.listByUser(req.params.id);
    return res.json({ success: true, data: { memberships } });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/laboratories', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }

    const user = await userRepository.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
    }

    const laboratoryId = req.body && req.body.laboratoryId;
    if (!isValidId(laboratoryId)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Valid laboratoryId is required.' },
      });
    }

    const lab = await laboratoryRepository.findById(laboratoryId);
    if (!lab) {
      return res.status(404).json({
        success: false,
        error: { code: 'LABORATORY_NOT_FOUND', message: 'Laboratory not found.' },
      });
    }

    const targetUserId = user._id || user.id;
    const existing = await laboratoryMembershipRepository.findByUserAndLab(targetUserId, laboratoryId);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_MEMBER', message: 'User is already assigned to this laboratory.' },
      });
    }

    const role = req.body.role || 'MEMBER';
    const membership = await laboratoryMembershipRepository.create({
      userId: targetUserId,
      laboratoryId,
      role,
      assignedBy: req.user._id || req.user.id,
      assignedAt: new Date(),
    });

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'LABORATORY_ASSIGNED',
      resource: 'LaboratoryMembership',
      resourceId: membership.id || membership._id,
      details: { userId: targetUserId, laboratoryId, role },
      req,
    });

    await notifyUser({
      userId: targetUserId,
      type: 'lab-membership-assigned',
      title: 'Laboratory Membership Assigned',
      message: `You have been assigned access to laboratory: ${lab.name}.`,
      entityType: 'laboratory',
      entityId: laboratoryId,
    });

    return res.status(201).json({ success: true, data: { membership } });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id/laboratories/:labId', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id) || !isValidId(req.params.labId)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid IDs.' } });
    }

    const targetUserId = req.params.id;
    const laboratoryId = req.params.labId;

    const existing = await laboratoryMembershipRepository.findByUserAndLab(targetUserId, laboratoryId);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Membership not found.' },
      });
    }

    await laboratoryMembershipRepository.delete(targetUserId, laboratoryId);

    await logAudit({
      userId: req.user._id || req.user.id,
      action: 'LABORATORY_REMOVED',
      resource: 'LaboratoryMembership',
      resourceId: existing.id || existing._id,
      details: { userId: targetUserId, laboratoryId },
      req,
    });

    await notifyUser({
      userId: targetUserId,
      type: 'lab-membership-removed',
      title: 'Laboratory Access Revoked',
      message: 'Your membership in the laboratory has been removed by an administrator.',
      entityType: 'laboratory',
      entityId: laboratoryId,
    });

    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

/* ============================================================================
   8. GET /:id/qualifications — User Qualifications List
   ============================================================================ */
router.get('/:id/qualifications', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid id.' } });
    }

    const qualifications = await qualificationRepository.list({ userId: req.params.id });
    return res.json({ success: true, data: { qualifications } });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
