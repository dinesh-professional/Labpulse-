/**
 * Instrument Repository (Module 06)
 * Handles data access for laboratory instruments and equipment.
 * Backed by public.instruments (Supabase PostgreSQL) with fallback to Instrument model.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const Instrument = require('../models/Instrument');
const { mapInstrumentToApp, mapAppToInstrument } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

class InstrumentRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('instruments').select('*').eq('id', id).single();
      if (error || !data) return null;
      return mapInstrumentToApp(data);
    }
    return Instrument.findById(id);
  }

  async findBySerialNumber(serial) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('instruments').select('*').eq('serial_number', serial).single();
      if (error || !data) return null;
      return mapInstrumentToApp(data);
    }
    return Instrument.findOne({ serialNumber: serial });
  }

  _buildMongoFilter(filter = {}) {
    const q = {};
    if (filter.category) q.category = filter.category;
    if (filter.status) q.status = filter.status;
    if (filter.laboratoryId) q.laboratoryId = filter.laboratoryId;
    if (filter.lifecycleState) q.lifecycleState = filter.lifecycleState;
    if (filter.requiredQualificationLevel !== undefined) {
      q.requiredQualificationLevel = filter.requiredQualificationLevel;
    }
    if (filter.q && typeof filter.q === 'string' && filter.q.trim()) {
      const regex = new RegExp(filter.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [
        { name: regex },
        { model: regex },
        { assetTag: regex },
        { manufacturer: regex },
        { category: regex },
      ];
    }
    return q;
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('instruments').select('id', { count: 'exact', head: true });
      if (filter.category) query = query.eq('category', filter.category);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.laboratoryId) query = query.eq('laboratory_id', filter.laboratoryId);
      if (filter.lifecycleState) query = query.eq('lifecycle_state', filter.lifecycleState);
      if (filter.requiredQualificationLevel !== undefined) {
        query = query.eq('required_qualification_level', filter.requiredQualificationLevel);
      }
      if (filter.q) {
        const clean = filter.q.trim().replace(/[%_]/g, '');
        if (clean) {
          query = query.or(`name.ilike.%${clean}%,model.ilike.%${clean}%,asset_tag.ilike.%${clean}%,manufacturer.ilike.%${clean}%,category.ilike.%${clean}%`);
        }
      }
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    return Instrument.countDocuments(this._buildMongoFilter(filter));
  }

  async list(filter = {}, { page = 1, limit = 20, sortBy = 'name', sortOrder = 'asc', role = 'student' } = {}) {
    const ALLOWED_INSTRUMENT_SORTS = {
      name: 'name',
      category: 'category',
      status: 'status',
      lifecycleState: 'lifecycle_state',
      createdAt: 'created_at',
      nextCalibrationDue: 'next_calibration_due',
      updatedAt: 'updated_at',
    };
    const dbSortCol = ALLOWED_INSTRUMENT_SORTS[sortBy] || 'name';
    const isAsc = sortOrder === 'asc';

    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('instruments').select('*');
      if (filter.category) query = query.eq('category', filter.category);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.laboratoryId) query = query.eq('laboratory_id', filter.laboratoryId);
      if (filter.lifecycleState) query = query.eq('lifecycle_state', filter.lifecycleState);
      if (filter.requiredQualificationLevel !== undefined) {
        query = query.eq('required_qualification_level', filter.requiredQualificationLevel);
      }
      if (filter.q) {
        const clean = filter.q.trim().replace(/[%_]/g, '');
        if (clean) {
          query = query.or(`name.ilike.%${clean}%,model.ilike.%${clean}%,asset_tag.ilike.%${clean}%,manufacturer.ilike.%${clean}%,category.ilike.%${clean}%`);
        }
      }
      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query
        .order(dbSortCol, { ascending: isAsc })
        .order('id', { ascending: false })
        .range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);

      return (data || []).map((row) => {
        const item = mapInstrumentToApp(row);
        if (role === 'student') {
          delete item.breakageFee;
        }
        return item;
      });
    }

    const project = role === 'student' ? '-breakageFee' : '';
    const mongoFilter = this._buildMongoFilter(filter);
    const mongoSort = { [sortBy]: isAsc ? 1 : -1 };
    if (sortBy !== '_id') mongoSort._id = -1;

    return Instrument.find(mongoFilter, project || undefined)
      .sort(mongoSort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToInstrument(data);
      const { data: res, error } = await client.from('instruments').insert(payload).select().single();
      if (error) throw translateDbError(error);
      return mapInstrumentToApp(res);
    }
    return Instrument.create(data);
  }

  async updateById(id, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToInstrument(data);
      payload.updated_at = new Date().toISOString();
      const { data: res, error } = await client.from('instruments').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapInstrumentToApp(res);
    }
    return Instrument.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }

  async updateStatus(id, status) {
    return this.updateById(id, { status });
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('instruments').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    return Instrument.findByIdAndDelete(id);
  }
}

module.exports = new InstrumentRepository();
