/**
 * Laboratory Repository (Module 06)
 * Handles data access for physical laboratories.
 * Backed by public.laboratories (Supabase PostgreSQL) with fallback to Laboratory model.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const Laboratory = require('../models/Laboratory');
const { mapLaboratoryToApp, mapAppToLaboratory } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

class LaboratoryRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('laboratories').select('*').eq('id', id).single();
      if (error || !data) return null;
      return mapLaboratoryToApp(data);
    }
    return Laboratory.findById(id);
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('laboratories').select('id', { count: 'exact', head: true });
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.department) query = query.eq('department', filter.department);
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    return Laboratory.countDocuments(filter);
  }

  async list(filter = {}, { page = 1, limit = 50 } = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('laboratories').select('*');
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.department) query = query.eq('department', filter.department);
      if (filter.q) query = query.ilike('name', `%${filter.q}%`);
      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.order('name', { ascending: true }).range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map(mapLaboratoryToApp);
    }
    return Laboratory.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean();
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToLaboratory(data);
      const { data: res, error } = await client.from('laboratories').insert(payload).select().single();
      if (error) throw translateDbError(error);
      return mapLaboratoryToApp(res);
    }
    return Laboratory.create(data);
  }

  async updateById(id, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToLaboratory(data);
      payload.updated_at = new Date().toISOString();
      const { data: res, error } = await client.from('laboratories').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapLaboratoryToApp(res);
    }
    return Laboratory.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('laboratories').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    return Laboratory.findByIdAndDelete(id);
  }
}

module.exports = new LaboratoryRepository();
