/**
 * Maintenance Repository (Module 06)
 * Handles data access for preventive and corrective maintenance work orders.
 * Backed by public.maintenance (Supabase PostgreSQL) with fallback to Maintenance model.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const Maintenance = require('../models/Maintenance');
const { mapMaintenanceToApp, mapAppToMaintenance } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');
const { toDayString, isHHMM, dayRangeUTC } = require('../utils/time');

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class MaintenanceRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('maintenance').select('*').eq('id', id).single();
      if (error || !data) return null;
      return mapMaintenanceToApp(data);
    }
    return Maintenance.findById(id);
  }

  _buildMongoFilter(filter = {}) {
    const q = {};
    if (filter.instrumentId) q.instrumentId = filter.instrumentId;
    if (filter.status) q.status = filter.status;
    if (filter.type) q.type = filter.type;
    if (filter.startDate) {
      q.startDate = q.startDate || {};
      q.startDate.$gte = new Date(filter.startDate);
    }
    if (filter.endDate) {
      q.startDate = q.startDate || {};
      q.startDate.$lte = new Date(filter.endDate);
    }
    if (filter.q) {
      const rx = new RegExp(escapeRegex(filter.q), 'i');
      q.$or = [
        { description: rx },
        { workPerformed: rx },
        { partsReplaced: rx },
        { resolutionNotes: rx },
      ];
    }
    return q;
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('maintenance').select('id', { count: 'exact', head: true });
      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.type) query = query.eq('type', filter.type);
      if (filter.startDate) query = query.gte('start_date', filter.startDate);
      if (filter.endDate) query = query.lte('start_date', filter.endDate);
      if (filter.q) query = query.ilike('description', `%${filter.q}%`);
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    const q = this._buildMongoFilter(filter);
    return Maintenance.countDocuments(q);
  }

  async list(filter = {}, { page = 1, limit = 20, sortBy = 'startDate', sortOrder = 'desc' } = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('maintenance').select('*');
      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.type) query = query.eq('type', filter.type);
      if (filter.startDate) query = query.gte('start_date', filter.startDate);
      if (filter.endDate) query = query.lte('start_date', filter.endDate);
      if (filter.q) query = query.ilike('description', `%${filter.q}%`);
      const from = (page - 1) * limit;
      const to = from + limit - 1;
      const sortColumnMap = {
        startDate: 'start_date',
        scheduledStart: 'start_date',
        status: 'status',
        type: 'type',
        createdAt: 'created_at',
      };
      const dbCol = sortColumnMap[sortBy] || 'start_date';
      query = query.order(dbCol, { ascending: sortOrder === 'asc' }).order('id', { ascending: false }).range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map(mapMaintenanceToApp);
    }
    const q = this._buildMongoFilter(filter);
    const mongoSort = {};
    const sortField = ['startDate', 'status', 'type', 'createdAt'].includes(sortBy) ? sortBy : 'startDate';
    mongoSort[sortField] = sortOrder === 'asc' ? 1 : -1;
    mongoSort._id = -1;
    return Maintenance.find(q).sort(mongoSort).skip((page - 1) * limit).limit(limit).lean();
  }

  async findBlockingMaintenance(instrumentId, dateStr, startTime, endTime, excludeId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client
        .from('maintenance')
        .select('*')
        .eq('instrument_id', instrumentId)
        .in('status', ['SCHEDULED', 'IN_PROGRESS'])
        .lte('start_date', dateStr);

      if (excludeId) {
        query = query.neq('id', excludeId);
      }

      const { data, error } = await query;
      if (error || !data) return null;

      for (const row of data) {
        const s = String(row.start_date).slice(0, 10);
        const e = row.end_date ? String(row.end_date).slice(0, 10) : s;
        if (e < dateStr || s > dateStr) continue;
        if (s === e && isHHMM(row.start_time) && isHHMM(row.end_time)) {
          if (row.start_time < endTime && row.end_time > startTime) {
            return mapMaintenanceToApp(row);
          }
          continue;
        }
        return mapMaintenanceToApp(row);
      }
      return null;
    }

    const range = dayRangeUTC(dateStr);
    if (!range) return null;
    const q = {
      instrumentId,
      status: { $in: ['SCHEDULED', 'IN_PROGRESS'] },
      startDate: { $lt: range.next },
    };
    if (excludeId) q._id = { $ne: excludeId };
    const cands = await Maintenance.find(q).lean();
    for (const m of cands) {
      const s = toDayString(m.startDate);
      const e = m.endDate ? toDayString(m.endDate) : s;
      if (e < dateStr || s > dateStr) continue;
      if (s === e && isHHMM(m.startTime) && isHHMM(m.endTime)) {
        if (m.startTime < endTime && m.endTime > startTime) return m;
        continue;
      }
      return m;
    }
    return null;
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToMaintenance(data);
      const { data: res, error } = await client.from('maintenance').insert(payload).select().single();
      if (error) throw translateDbError(error);
      return mapMaintenanceToApp(res);
    }
    return Maintenance.create(data);
  }

  async updateById(id, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToMaintenance(data);
      payload.updated_at = new Date().toISOString();
      const { data: res, error } = await client.from('maintenance').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapMaintenanceToApp(res);
    }
    return Maintenance.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('maintenance').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    return Maintenance.findByIdAndDelete(id);
  }
}

module.exports = new MaintenanceRepository();
