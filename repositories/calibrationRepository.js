/**
 * Calibration Repository (Module 06)
 * Handles data access for metrology and instrument calibrations.
 * Backed by public.calibrations (Supabase PostgreSQL) with fallback to Calibration model.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const Calibration = require('../models/Calibration');
const { mapCalibrationToApp, mapAppToCalibration } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

const { dayRangeUTC } = require('../utils/time');

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class CalibrationRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('calibrations').select('*').eq('id', id).single();
      if (error || !data) return null;
      return mapCalibrationToApp(data);
    }
    return Calibration.findById(id);
  }

  _buildMongoFilter(filter = {}) {
    const q = {};
    if (filter.instrumentId) q.instrumentId = filter.instrumentId;
    if (filter.status) q.status = filter.status;
    if (filter.result) q.result = filter.result;
    if (filter.date) {
      const range = dayRangeUTC(String(filter.date));
      if (range) q.date = { $gte: range.start, $lt: range.next };
    }
    if (filter.startDate) {
      q.date = q.date || {};
      q.date.$gte = new Date(filter.startDate);
    }
    if (filter.endDate) {
      q.date = q.date || {};
      q.date.$lte = new Date(filter.endDate);
    }
    if (filter.q) {
      const rx = new RegExp(escapeRegex(filter.q), 'i');
      q.$or = [
        { calibrationType: rx },
        { standard: rx },
        { referenceStandard: rx },
        { certificateNumber: rx },
        { notes: rx },
      ];
    }
    return q;
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('calibrations').select('id', { count: 'exact', head: true });
      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.result) query = query.eq('result', filter.result);
      if (filter.date) query = query.eq('date', filter.date);
      if (filter.startDate) query = query.gte('date', filter.startDate);
      if (filter.endDate) query = query.lte('date', filter.endDate);
      if (filter.q) query = query.ilike('calibration_type', `%${filter.q}%`);
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    const q = this._buildMongoFilter(filter);
    return Calibration.countDocuments(q);
  }

  async list(filter = {}, { page = 1, limit = 20, sortBy = 'date', sortOrder = 'desc' } = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('calibrations').select('*');
      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.result) query = query.eq('result', filter.result);
      if (filter.date) query = query.eq('date', filter.date);
      if (filter.startDate) query = query.gte('date', filter.startDate);
      if (filter.endDate) query = query.lte('date', filter.endDate);
      if (filter.q) query = query.ilike('calibration_type', `%${filter.q}%`);
      const from = (page - 1) * limit;
      const to = from + limit - 1;
      const sortColumnMap = {
        date: 'date',
        startTime: 'start_time',
        status: 'status',
        result: 'result',
        createdAt: 'created_at',
      };
      const dbCol = sortColumnMap[sortBy] || 'date';
      query = query.order(dbCol, { ascending: sortOrder === 'asc' }).order('id', { ascending: false }).range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map(mapCalibrationToApp);
    }
    const q = this._buildMongoFilter(filter);
    const mongoSort = {};
    const sortField = ['date', 'startTime', 'status', 'result', 'createdAt'].includes(sortBy) ? sortBy : 'date';
    mongoSort[sortField] = sortOrder === 'asc' ? 1 : -1;
    mongoSort._id = -1;
    return Calibration.find(q).sort(mongoSort).skip((page - 1) * limit).limit(limit).lean();
  }

  async findBlockingCalibration(instrumentId, dateStr, startTime, endTime) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('calibrations')
        .select('*')
        .eq('instrument_id', instrumentId)
        .eq('date', dateStr)
        .in('status', ['CALIBRATION_SCHEDULED', 'UNDER_CALIBRATION'])
        .lt('start_time', endTime)
        .gt('end_time', startTime)
        .limit(1);

      if (error || !data || data.length === 0) return null;
      return mapCalibrationToApp(data[0]);
    }

    const { dayRangeUTC } = require('../utils/time');
    const range = dayRangeUTC(dateStr);
    if (!range) return null;
    return Calibration.findOne({
      instrumentId,
      date: { $gte: range.start, $lt: range.next },
      status: { $in: ['CALIBRATION_SCHEDULED', 'UNDER_CALIBRATION'] },
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    }).lean();
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToCalibration(data);
      if (data.date && data.startTime && data.endTime) {
        const dStr = typeof data.date === 'string' ? data.date.slice(0, 10) : new Date(data.date).toISOString().slice(0, 10);
        payload.start_at = new Date(`${dStr}T${data.startTime}:00Z`).toISOString();
        payload.end_at = new Date(`${dStr}T${data.endTime}:00Z`).toISOString();
      }
      const { data: res, error } = await client.from('calibrations').insert(payload).select().single();
      if (error) throw translateDbError(error);
      return mapCalibrationToApp(res);
    }
    return Calibration.create(data);
  }

  async updateById(id, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToCalibration(data);
      payload.updated_at = new Date().toISOString();
      const { data: res, error } = await client.from('calibrations').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapCalibrationToApp(res);
    }
    return Calibration.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('calibrations').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    return Calibration.findByIdAndDelete(id);
  }
}

module.exports = new CalibrationRepository();
