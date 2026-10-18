/**
 * Schedule Repository (Module 06)
 * Handles data access for teaching sessions and curriculum laboratory schedules.
 * Backed by public.schedules (Supabase PostgreSQL) with fallback to Schedule model.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const Schedule = require('../models/Schedule');
const { mapScheduleToApp, mapAppToSchedule } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

class ScheduleRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('schedules')
        .select(`
          *,
          laboratories (id, name, department),
          profiles:faculty_id (id, name, email)
        `)
        .eq('id', id)
        .single();

      if (error || !data) return null;
      return mapScheduleToApp(data);
    }
    return Schedule.findById(id).populate('facultyId', 'name email').populate('laboratoryId', 'name department');
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('schedules').select('id', { count: 'exact', head: true });
      if (filter.facultyId) query = query.eq('faculty_id', filter.facultyId);
      if (filter.laboratoryId) query = query.eq('laboratory_id', filter.laboratoryId);
      if (filter.department) query = query.eq('department', filter.department);
      if (filter.year) query = query.eq('year', filter.year);
      if (filter.section) query = query.eq('section', filter.section);
      if (filter.status) query = query.eq('status', filter.status);
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    return Schedule.countDocuments(filter);
  }

  async list(filter = {}, { page = 1, limit = 20 } = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('schedules').select(`
        *,
        laboratories (id, name, department),
        profiles:faculty_id (id, name, email)
      `);

      if (filter.facultyId) query = query.eq('faculty_id', filter.facultyId);
      if (filter.laboratoryId) query = query.eq('laboratory_id', filter.laboratoryId);
      if (filter.department) query = query.eq('department', filter.department);
      if (filter.year) query = query.eq('year', filter.year);
      if (filter.section) query = query.eq('section', filter.section);
      if (filter.status) query = query.eq('status', filter.status);

      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.order('date', { ascending: false }).range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map(mapScheduleToApp);
    }

    return Schedule.find(filter)
      .populate('facultyId', 'name email')
      .populate('laboratoryId', 'name department')
      .sort({ date: -1, startTime: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }

  async findLabConflict(laboratoryId, dateStr, startTime, endTime, excludeId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client
        .from('schedules')
        .select('*')
        .eq('laboratory_id', laboratoryId)
        .eq('date', dateStr)
        .neq('status', 'CANCELLED')
        .lt('start_time', endTime)
        .gt('end_time', startTime);

      if (excludeId) {
        query = query.neq('id', excludeId);
      }
      const { data, error } = await query.limit(1);
      if (error || !data || data.length === 0) return null;
      return mapScheduleToApp(data[0]);
    }

    const { dayRangeUTC } = require('../utils/time');
    const range = dayRangeUTC(dateStr);
    if (!range) return null;
    const q = {
      laboratoryId,
      date: { $gte: range.start, $lt: range.next },
      status: { $ne: 'CANCELLED' },
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    };
    if (excludeId) q._id = { $ne: excludeId };
    return Schedule.findOne(q).lean();
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToSchedule(data);

      const dateStr = typeof data.date === 'string' ? data.date.slice(0, 10) : new Date(data.date).toISOString().slice(0, 10);
      payload.date = dateStr;
      payload.start_at = new Date(`${dateStr}T${data.startTime}:00Z`).toISOString();
      payload.end_at = new Date(`${dateStr}T${data.endTime}:00Z`).toISOString();

      const { data: res, error } = await client.from('schedules').insert(payload).select().single();
      if (error) throw translateDbError(error);
      return mapScheduleToApp(res);
    }
    return Schedule.create(data);
  }

  async updateById(id, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToSchedule(data);
      if (data.date && data.startTime && data.endTime) {
        const dateStr = typeof data.date === 'string' ? data.date.slice(0, 10) : new Date(data.date).toISOString().slice(0, 10);
        payload.date = dateStr;
        payload.start_at = new Date(`${dateStr}T${data.startTime}:00Z`).toISOString();
        payload.end_at = new Date(`${dateStr}T${data.endTime}:00Z`).toISOString();
      }
      payload.updated_at = new Date().toISOString();

      const { data: res, error } = await client.from('schedules').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapScheduleToApp(res);
    }
    return Schedule.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('schedules').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    return Schedule.findByIdAndDelete(id);
  }
}

module.exports = new ScheduleRepository();
