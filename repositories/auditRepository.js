/**
 * Audit Repository (Module 06 / Module 13)
 * Handles append-only audit logging for security-sensitive and operational events.
 * Backed by public.audit_logs (Supabase PostgreSQL) with fallback to AuditLog model.
 * Invariant: Audit logs are strictly immutable (append-only); no updates or deletes permitted.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const AuditLog = require('../models/AuditLog');
const { mapAuditLogToApp } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
  'jwt',
  'secret',
  'apikey',
  'api_key',
  'cookie',
  'authorization',
  'servicerolekey',
  'service_role_key',
  'qrtoken',
  'qr_token',
  'sessiontoken',
  'session_token',
  'creditcard',
  'credit_card',
  'cvv'
]);

/**
 * Recursively redacts sensitive credentials from metadata objects.
 */
function deepSanitize(val, depth = 0) {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    if (/^bearer\s+/i.test(val)) return '[REDACTED]';
    if (/^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/i.test(val)) return '[REDACTED]';
    return val.length > 2000 ? val.slice(0, 2000) + '...[TRUNCATED]' : val;
  }
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    return val.slice(0, 50).map((item) => deepSanitize(item, depth + 1));
  }
  const clean = {};
  for (const [k, v] of Object.entries(val)) {
    const lowerKey = k.toLowerCase().replace(/[-_]/g, '');
    if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.includes('password') || lowerKey.includes('secret')) {
      clean[k] = '[REDACTED]';
    } else {
      clean[k] = deepSanitize(v, depth + 1);
    }
  }
  return clean;
}

class AuditRepository {
  /**
   * Appends an immutable audit log entry.
   * Fire-and-forget safe (does not throw into user requests).
   */
  async log({
    userId,
    actorRole,
    action,
    resource,
    resourceId,
    status = 'SUCCESS',
    laboratoryId = null,
    details,
    req,
    ipAddress,
    userAgent,
  }) {
    try {
      const sanitizedDetails = details ? deepSanitize(details) : null;

      const actorId = userId || (req && req.user ? (req.user.id || req.user._id) : null);
      const role = actorRole || (req && req.user ? req.user.role : null);
      const ip = ipAddress || (req && req.ip ? String(req.ip).slice(0, 80) : null);
      const ua = userAgent || (req && typeof req.get === 'function' ? String(req.get('user-agent') || '').slice(0, 500) : null);
      const logStatus = ['SUCCESS', 'FAILURE', 'DENIED'].includes(status) ? status : 'SUCCESS';

      if (getActiveDataBackend() === 'supabase') {
        const client = getSupabaseAdminClient();
        const payload = {
          user_id: actorId ? String(actorId) : null,
          actor_role: role ? String(role).slice(0, 32) : null,
          action: String(action).slice(0, 64),
          resource: String(resource).slice(0, 64),
          resource_id: resourceId ? String(resourceId).slice(0, 128) : null,
          status: logStatus,
          laboratory_id: laboratoryId ? String(laboratoryId) : null,
          details: sanitizedDetails,
          ip_address: ip,
          user_agent: ua,
        };
        await client.from('audit_logs').insert(payload);
        return;
      }

      await AuditLog.create({
        userId: actorId || undefined,
        actorRole: role || undefined,
        action,
        resource,
        resourceId: resourceId ? String(resourceId) : undefined,
        status: logStatus,
        laboratoryId: laboratoryId || undefined,
        details: sanitizedDetails,
        ipAddress: ip,
        userAgent: ua,
      });
    } catch (err) {
      console.warn('[audit] write failed:', err.message);
    }
  }

  deepSanitize(val, depth = 0) {
    return deepSanitize(val, depth);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // IMMUTABILITY GUARDS (Spec §4)
  // ──────────────────────────────────────────────────────────────────────────
  update() {
    const err = new Error('AUDIT_IMMUTABILITY_VIOLATION: Audit logs are strictly append-only and cannot be modified.');
    err.code = 'AUDIT_IMMUTABILITY_VIOLATION';
    throw err;
  }

  updateById() {
    const err = new Error('AUDIT_IMMUTABILITY_VIOLATION: Audit logs are strictly append-only and cannot be modified.');
    err.code = 'AUDIT_IMMUTABILITY_VIOLATION';
    throw err;
  }

  delete() {
    const err = new Error('AUDIT_IMMUTABILITY_VIOLATION: Audit logs are strictly append-only and cannot be deleted.');
    err.code = 'AUDIT_IMMUTABILITY_VIOLATION';
    throw err;
  }

  deleteById() {
    const err = new Error('AUDIT_IMMUTABILITY_VIOLATION: Audit logs are strictly append-only and cannot be deleted.');
    err.code = 'AUDIT_IMMUTABILITY_VIOLATION';
    throw err;
  }

  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('audit_logs').select('*').eq('id', id).single();
      if (error || !data) return null;
      return mapAuditLogToApp(data);
    }
    return AuditLog.findById(id).populate('userId', 'name email role').lean();
  }

  _buildMongoFilter(filter = {}) {
    const q = {};
    if (filter.userId) q.userId = filter.userId;
    if (filter.actorRole) q.actorRole = filter.actorRole;
    if (filter.action) q.action = filter.action;
    if (filter.resource) q.resource = filter.resource;
    if (filter.resourceId) q.resourceId = filter.resourceId;
    if (filter.status) q.status = filter.status;
    if (filter.laboratoryId) q.laboratoryId = filter.laboratoryId;

    if (filter.startDate || filter.endDate) {
      q.createdAt = {};
      if (filter.startDate) q.createdAt.$gte = new Date(filter.startDate);
      if (filter.endDate) q.createdAt.$lte = new Date(filter.endDate);
    }

    if (filter.q && typeof filter.q === 'string' && filter.q.trim()) {
      const regex = new RegExp(filter.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [
        { action: regex },
        { resource: regex },
        { resourceId: regex },
        { actorRole: regex },
      ];
    }
    return q;
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('audit_logs').select('id', { count: 'exact', head: true });
      if (filter.userId) query = query.eq('user_id', filter.userId);
      if (filter.actorRole) query = query.eq('actor_role', filter.actorRole);
      if (filter.action) query = query.eq('action', filter.action);
      if (filter.resource) query = query.eq('resource', filter.resource);
      if (filter.resourceId) query = query.eq('resource_id', filter.resourceId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.laboratoryId) query = query.eq('laboratory_id', filter.laboratoryId);
      if (filter.startDate) query = query.gte('created_at', new Date(filter.startDate).toISOString());
      if (filter.endDate) query = query.lte('created_at', new Date(filter.endDate).toISOString());
      if (filter.q && typeof filter.q === 'string' && filter.q.trim()) {
        const term = `%${filter.q.trim()}%`;
        query = query.or(`action.ilike.${term},resource.ilike.${term},resource_id.ilike.${term}`);
      }
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    return AuditLog.countDocuments(this._buildMongoFilter(filter));
  }

  async list(filter = {}, { page = 1, limit = 50 } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('audit_logs').select('*');
      if (filter.userId) query = query.eq('user_id', filter.userId);
      if (filter.actorRole) query = query.eq('actor_role', filter.actorRole);
      if (filter.action) query = query.eq('action', filter.action);
      if (filter.resource) query = query.eq('resource', filter.resource);
      if (filter.resourceId) query = query.eq('resource_id', filter.resourceId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.laboratoryId) query = query.eq('laboratory_id', filter.laboratoryId);
      if (filter.startDate) query = query.gte('created_at', new Date(filter.startDate).toISOString());
      if (filter.endDate) query = query.lte('created_at', new Date(filter.endDate).toISOString());
      if (filter.q && typeof filter.q === 'string' && filter.q.trim()) {
        const term = `%${filter.q.trim()}%`;
        query = query.or(`action.ilike.${term},resource.ilike.${term},resource_id.ilike.${term}`);
      }

      const from = (safePage - 1) * safeLimit;
      const to = from + safeLimit - 1;
      query = query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map(mapAuditLogToApp);
    }

    const mongoFilter = this._buildMongoFilter(filter);
    return AuditLog.find(mongoFilter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('userId', 'name email role')
      .lean();
  }

  /**
   * Generates aggregated compliance metrics across real database data.
   */
  async getComplianceSummary({ startDate, endDate, laboratoryId } = {}) {
    const bookingRepo = require('./bookingRepository');
    const instrumentRepo = require('./instrumentRepository');
    const qualRepo = require('./qualificationRepository');
    const qrRepo = require('./qrRepository');

    const dateFilter = {};
    if (startDate) dateFilter.startDate = startDate;
    if (endDate) dateFilter.endDate = endDate;
    if (laboratoryId) dateFilter.laboratoryId = laboratoryId;

    // Booking counts
    const [
      totalBookings,
      confirmedBookings,
      completedBookings,
      cancelledBookings,
      rejectedBookings,
      noShowBookings,
    ] = await Promise.all([
      bookingRepo.count(laboratoryId ? { laboratoryId } : {}),
      bookingRepo.count({ status: 'CONFIRMED' }),
      bookingRepo.count({ status: 'COMPLETED' }),
      bookingRepo.count({ status: 'CANCELLED' }),
      bookingRepo.count({ status: 'REJECTED' }),
      bookingRepo.count({ status: 'NO_SHOW' }),
    ]);

    // Instrument counts
    const [
      totalInstruments,
      availableInstruments,
      maintenanceInstruments,
      calibrationInstruments,
      downInstruments,
      retiredInstruments,
    ] = await Promise.all([
      instrumentRepo.count(laboratoryId ? { laboratoryId } : {}),
      instrumentRepo.count({ status: 'AVAILABLE' }),
      instrumentRepo.count({ status: 'UNDER_MAINTENANCE' }),
      instrumentRepo.count({ status: 'UNDER_CALIBRATION' }),
      instrumentRepo.count({ status: 'OUT_OF_ORDER' }),
      instrumentRepo.count({ lifecycleState: 'RETIRED' }),
    ]);

    // Qualification counts
    const [
      totalQuals,
      verifiedQuals,
      pendingQuals,
      suspendedQuals,
      revokedQuals,
      expiredQuals,
    ] = await Promise.all([
      qualRepo.count(),
      qualRepo.count({ status: 'ACTIVE' }),
      qualRepo.count({ status: 'PENDING' }),
      qualRepo.count({ status: 'SUSPENDED' }),
      qualRepo.count({ status: 'REVOKED' }),
      qualRepo.count({ status: 'EXPIRED' }),
    ]);

    // Access pass counts
    const [
      totalPasses,
      redeemedPasses,
      revokedPasses,
      expiredPasses,
    ] = await Promise.all([
      qrRepo.count(),
      qrRepo.count({ status: 'REDEEMED' }),
      qrRepo.count({ status: 'REVOKED' }),
      qrRepo.count({ status: 'EXPIRED' }),
    ]);

    // Audit counts
    const [
      totalAuditLogs,
      successAuditLogs,
      failureAuditLogs,
      deniedAuditLogs,
    ] = await Promise.all([
      this.count(dateFilter),
      this.count({ ...dateFilter, status: 'SUCCESS' }),
      this.count({ ...dateFilter, status: 'FAILURE' }),
      this.count({ ...dateFilter, status: 'DENIED' }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      scope: { startDate: startDate || null, endDate: endDate || null, laboratoryId: laboratoryId || null },
      bookings: {
        total: totalBookings,
        confirmed: confirmedBookings,
        completed: completedBookings,
        cancelled: cancelledBookings,
        rejected: rejectedBookings,
        noShow: noShowBookings,
      },
      instruments: {
        total: totalInstruments,
        available: availableInstruments,
        underMaintenance: maintenanceInstruments,
        underCalibration: calibrationInstruments,
        outOfOrder: downInstruments,
        retired: retiredInstruments,
      },
      qualifications: {
        total: totalQuals,
        active: verifiedQuals,
        pending: pendingQuals,
        suspended: suspendedQuals,
        revoked: revokedQuals,
        expired: expiredQuals,
      },
      access: {
        totalPasses,
        redeemed: redeemedPasses,
        revoked: revokedPasses,
        expired: expiredPasses,
      },
      audit: {
        totalEvents: totalAuditLogs,
        successCount: successAuditLogs,
        failureCount: failureAuditLogs,
        deniedCount: deniedAuditLogs,
      },
    };
  }

  /**
   * Serializes an array of audit logs to an RFC 4180 CSV string.
   */
  toCsv(logs = []) {
    const headers = ['id', 'timestamp', 'action', 'status', 'actor_id', 'actor_role', 'laboratory_id', 'resource', 'resource_id', 'ip_address', 'user_agent', 'details'];
    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [headers.join(',')];
    for (const l of logs) {
      const actorId = l.userId && typeof l.userId === 'object' ? (l.userId.id || l.userId._id || l.userId.email) : l.userId;
      const row = [
        l.id || l._id || '',
        l.createdAt ? new Date(l.createdAt).toISOString() : '',
        l.action || '',
        l.status || 'SUCCESS',
        actorId || '',
        l.actorRole || (l.userId && l.userId.role) || '',
        l.laboratoryId || '',
        l.resource || '',
        l.resourceId || '',
        l.ipAddress || '',
        l.userAgent || '',
        l.details || {},
      ];
      lines.push(row.map(escapeCsv).join(','));
    }
    return lines.join('\r\n');
  }
}

module.exports = new AuditRepository();

