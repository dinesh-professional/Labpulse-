/**
 * Breakage Report Repository (Module 06)
 * Handles data access for instrument incident and breakage reports.
 * Backed by public.breakage_reports (Supabase PostgreSQL) with fallback to BreakageReport model.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const BreakageReport = require('../models/BreakageReport');
const { mapBreakageReportToApp, mapAppToBreakageReport } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class BreakageRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('breakage_reports').select('*').eq('id', id).single();
      if (error || !data) return null;
      return mapBreakageReportToApp(data);
    }
    return BreakageReport.findById(id);
  }

  _buildMongoFilter(filter = {}) {
    const q = {};
    if (filter.instrumentId) q.instrumentId = filter.instrumentId;
    if (filter.reportedBy) q.reportedBy = filter.reportedBy;
    if (filter.status) q.status = filter.status;
    if (filter.severity) q.severity = filter.severity;
    if (filter.statusIn && Array.isArray(filter.statusIn)) q.status = { $in: filter.statusIn };
    if (filter.q) {
      const rx = new RegExp(escapeRegex(filter.q), 'i');
      q.$or = [
        { issueType: rx },
        { description: rx },
        { resolutionNotes: rx },
      ];
    }
    return q;
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('breakage_reports').select('id', { count: 'exact', head: true });
      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.reportedBy) query = query.eq('reported_by', filter.reportedBy);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.severity) query = query.eq('severity', filter.severity);
      if (filter.statusIn && Array.isArray(filter.statusIn)) query = query.in('status', filter.statusIn);
      if (filter.q) query = query.ilike('issue_type', `%${filter.q}%`);
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    const q = this._buildMongoFilter(filter);
    return BreakageReport.countDocuments(q);
  }

  async list(filter = {}, { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('breakage_reports').select('*');
      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.reportedBy) query = query.eq('reported_by', filter.reportedBy);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.severity) query = query.eq('severity', filter.severity);
      if (filter.statusIn && Array.isArray(filter.statusIn)) query = query.in('status', filter.statusIn);
      if (filter.q) query = query.ilike('issue_type', `%${filter.q}%`);
      const from = (page - 1) * limit;
      const to = from + limit - 1;
      const sortColumnMap = {
        createdAt: 'created_at',
        severity: 'severity',
        status: 'status',
        breakageFee: 'breakage_fee',
      };
      const dbCol = sortColumnMap[sortBy] || 'created_at';
      query = query.order(dbCol, { ascending: sortOrder === 'asc' }).order('id', { ascending: false }).range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map(mapBreakageReportToApp);
    }
    const q = this._buildMongoFilter(filter);
    const mongoSort = {};
    const sortField = ['createdAt', 'severity', 'status', 'breakageFee'].includes(sortBy) ? sortBy : 'createdAt';
    mongoSort[sortField] = sortOrder === 'asc' ? 1 : -1;
    mongoSort._id = -1;
    return BreakageReport.find(q).sort(mongoSort).skip((page - 1) * limit).limit(limit).lean();
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToBreakageReport(data);
      const { data: res, error } = await client.from('breakage_reports').insert(payload).select().single();
      if (error) throw translateDbError(error);
      return mapBreakageReportToApp(res);
    }
    return BreakageReport.create(data);
  }

  async updateById(id, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToBreakageReport(data);
      payload.updated_at = new Date().toISOString();
      const { data: res, error } = await client.from('breakage_reports').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapBreakageReportToApp(res);
    }
    return BreakageReport.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('breakage_reports').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    return BreakageReport.findByIdAndDelete(id);
  }
}

module.exports = new BreakageRepository();
