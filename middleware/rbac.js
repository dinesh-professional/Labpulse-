/**
 * Server-side RBAC (Phase 03). Backend authorization is authoritative — frontend hiding is not security.
 * Use after requireAuth: requireRole('admin'), requireRole('admin','faculty'), etc.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });
    }
    if (!req.user.isActive) {
      return res.status(403).json({ success: false, error: { code: 'ACCOUNT_INACTIVE', message: 'Account is deactivated.' } });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' } });
    }
    return next();
  };
}

module.exports = { requireRole };
