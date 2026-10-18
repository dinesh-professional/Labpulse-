/**
 * Operator Qualification Repository (Module 06 & Module 12)
 * Handles data access for instrument operator certification tiers (Levels 1 to 4)
 * and the complete qualification lifecycle: PENDING → ACTIVE → RENEWED / SUSPENDED / REVOKED / EXPIRED.
 * Backed by public.operator_qualifications (Supabase PostgreSQL) with fallback to OperatorQualification model.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const OperatorQualification = require('../models/OperatorQualification');
const { mapOperatorQualificationToApp, mapAppToOperatorQualification } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

class QualificationRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('operator_qualifications')
        .select(`
          *,
          instruments (id, name, category, model, status),
          profiles:user_id (id, name, email, role)
        `)
        .eq('id', id)
        .single();
      if (error || !data) return null;
      return mapOperatorQualificationToApp(data);
    }
    return OperatorQualification.findById(id)
      .populate('instrumentId', 'name category model status')
      .populate('userId', 'name email role');
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('operator_qualifications').select('id', { count: 'exact', head: true });
      if (filter.userId) query = query.eq('user_id', filter.userId);
      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.statusIn && Array.isArray(filter.statusIn)) query = query.in('status', filter.statusIn);
      if (filter.level !== undefined) query = query.eq('level', filter.level);
      if (filter.expiresBefore) query = query.lte('expires_at', filter.expiresBefore);
      if (filter.expiresAfter) query = query.gte('expires_at', filter.expiresAfter);
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    const mongoFilter = { ...filter };
    if (filter.statusIn) {
      delete mongoFilter.statusIn;
      mongoFilter.status = { $in: filter.statusIn };
    }
    if (filter.expiresBefore || filter.expiresAfter) {
      mongoFilter.expiresAt = {};
      if (filter.expiresBefore) mongoFilter.expiresAt.$lte = new Date(filter.expiresBefore);
      if (filter.expiresAfter) mongoFilter.expiresAt.$gte = new Date(filter.expiresAfter);
      delete mongoFilter.expiresBefore;
      delete mongoFilter.expiresAfter;
    }
    return OperatorQualification.countDocuments(mongoFilter);
  }

  async list(filter = {}, { page = 1, limit = 50, sortBy = 'createdAt', sortOrder = 'desc' } = {}) {
    const SORT_MAP = {
      createdAt: 'created_at',
      expiresAt: 'expires_at',
      level: 'level',
      status: 'status',
    };
    const dbSortCol = SORT_MAP[sortBy] || 'created_at';
    const isAsc = sortOrder === 'asc';

    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('operator_qualifications').select(`
        *,
        instruments (id, name, category, model, status),
        profiles:user_id (id, name, email, role)
      `);
      if (filter.userId) query = query.eq('user_id', filter.userId);
      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.statusIn && Array.isArray(filter.statusIn)) query = query.in('status', filter.statusIn);
      if (filter.level !== undefined) query = query.eq('level', filter.level);
      if (filter.expiresBefore) query = query.lte('expires_at', filter.expiresBefore);
      if (filter.expiresAfter) query = query.gte('expires_at', filter.expiresAfter);

      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query
        .order(dbSortCol, { ascending: isAsc })
        .order('id', { ascending: false })
        .range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map((row) => {
        const item = mapOperatorQualificationToApp(row);
        if (row.instruments) item.instrument = row.instruments;
        if (row.profiles) item.user = row.profiles;
        return item;
      });
    }

    const mongoFilter = { ...filter };
    if (filter.statusIn) {
      delete mongoFilter.statusIn;
      mongoFilter.status = { $in: filter.statusIn };
    }
    if (filter.expiresBefore || filter.expiresAfter) {
      mongoFilter.expiresAt = {};
      if (filter.expiresBefore) mongoFilter.expiresAt.$lte = new Date(filter.expiresBefore);
      if (filter.expiresAfter) mongoFilter.expiresAt.$gte = new Date(filter.expiresAfter);
      delete mongoFilter.expiresBefore;
      delete mongoFilter.expiresAfter;
    }

    const mongoSort = { [sortBy]: isAsc ? 1 : -1 };
    if (sortBy !== '_id') mongoSort._id = -1;

    return OperatorQualification.find(mongoFilter)
      .populate('instrumentId', 'name category model status')
      .populate('userId', 'name email role')
      .sort(mongoSort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }

  async checkUserQualification(userId, instrumentId, requiredLevel) {
    if (!requiredLevel) return true;

    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const now = new Date().toISOString();
      let query = client
        .from('operator_qualifications')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'ACTIVE')
        .gte('level', requiredLevel)
        .or(`expires_at.is.null,expires_at.gt.${now}`);

      if (instrumentId) {
        query = query.or(`instrument_id.eq.${instrumentId},instrument_id.is.null`);
      }

      const { data, error } = await query.limit(1);
      if (error || !data || data.length === 0) return false;
      return true;
    }

    const q = await OperatorQualification.findOne({
      userId,
      instrumentId,
      status: 'ACTIVE',
      level: { $gte: requiredLevel },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    }).lean();
    return !!q;
  }

  async getPendingQueue({ page = 1, limit = 50 } = {}) {
    return this.list({ status: 'PENDING' }, { page, limit });
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToOperatorQualification(data);
      const { data: res, error } = await client.from('operator_qualifications').insert(payload).select().single();
      if (error) throw translateDbError(error);
      return mapOperatorQualificationToApp(res);
    }
    return OperatorQualification.create(data);
  }

  async updateById(id, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToOperatorQualification(data);
      payload.updated_at = new Date().toISOString();
      const { data: res, error } = await client.from('operator_qualifications').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapOperatorQualificationToApp(res);
    }
    return OperatorQualification.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }

  async approve(id, { certifiedBy, level, expiresAt, notes }) {
    const updates = {
      status: 'ACTIVE',
      certifiedBy,
      certifiedAt: new Date(),
    };
    if (level !== undefined) updates.level = level;
    if (expiresAt !== undefined) updates.expiresAt = expiresAt;
    if (notes !== undefined) updates.evidenceNotes = notes;
    return this.updateById(id, updates);
  }

  async reject(id, { certifiedBy, reason }) {
    const updates = {
      status: 'REJECTED',
      certifiedBy,
      rejectionReason: reason || 'Application rejected by verifier.',
    };
    return this.updateById(id, updates);
  }

  async renew(id, { certifiedBy, expiresAt, level }) {
    const updates = {
      status: 'ACTIVE',
      certifiedBy,
      certifiedAt: new Date(),
    };
    if (expiresAt !== undefined) updates.expiresAt = expiresAt;
    if (level !== undefined) updates.level = level;
    return this.updateById(id, updates);
  }

  async suspend(id, { certifiedBy, reason }) {
    const updates = {
      status: 'SUSPENDED',
      certifiedBy,
      revocationReason: reason || 'Qualification temporarily suspended.',
    };
    return this.updateById(id, updates);
  }

  async revoke(id, { certifiedBy, reason }) {
    const updates = {
      status: 'REVOKED',
      certifiedBy,
      revocationReason: reason || 'Qualification revoked.',
    };
    return this.updateById(id, updates);
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('operator_qualifications').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    await OperatorQualification.findByIdAndDelete(id);
    return true;
  }
}

module.exports = new QualificationRepository();
