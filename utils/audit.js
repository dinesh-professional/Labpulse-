/**
 * Audit helper (Phase 03 / Module 13) — spec §19. Append-only; fire-and-forget safe (never throws into requests).
 * Never pass passwords, tokens, or hashes in details.
 * Actor identity (userId, actorRole) is derived server-side from req.user — never trust client values.
 */
const { auditRepository } = require('../repositories');

async function logAudit({ userId, action, resource, resourceId, details, req, status, laboratoryId, actorRole, userRole }) {
  try {
    const derivedUserId = userId || (req && req.user ? (req.user.id || req.user._id) : null);
    const derivedRole = actorRole || (req && req.user && req.user.role) || userRole || null;
    await auditRepository.log({
      userId: derivedUserId,
      actorRole: derivedRole,
      action,
      resource,
      resourceId,
      status: status || 'SUCCESS',
      laboratoryId: laboratoryId || null,
      details,
      req,
    });
  } catch (err) {
    console.warn('[audit] logAudit failed:', err.message);
  }
}

module.exports = { logAudit };

