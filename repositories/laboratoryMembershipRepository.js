/**
 * Laboratory Membership Repository (Module 12)
 * Handles data access for laboratory user memberships and access control.
 * Backed by public.laboratory_memberships (Supabase PostgreSQL) with fallback to LaboratoryMembership model.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const LaboratoryMembership = require('../models/LaboratoryMembership');
const { mapLaboratoryMembershipToApp, mapAppToLaboratoryMembership } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

class LaboratoryMembershipRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('laboratory_memberships')
        .select(`
          *,
          laboratories (id, name, department, building, room_number),
          profiles (id, name, email, role)
        `)
        .eq('id', id)
        .single();
      if (error || !data) return null;
      return mapLaboratoryMembershipToApp(data);
    }
    return LaboratoryMembership.findById(id).populate('laboratoryId', 'name department building roomNumber').populate('userId', 'name email role');
  }

  async findByUserAndLab(userId, laboratoryId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('laboratory_memberships')
        .select('*')
        .eq('user_id', userId)
        .eq('laboratory_id', laboratoryId)
        .single();
      if (error || !data) return null;
      return mapLaboratoryMembershipToApp(data);
    }
    return LaboratoryMembership.findOne({ userId, laboratoryId }).lean();
  }

  async listByUser(userId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('laboratory_memberships')
        .select(`
          *,
          laboratories (id, name, department, building, room_number)
        `)
        .eq('user_id', userId)
        .order('assigned_at', { ascending: false });
      if (error) throw translateDbError(error);
      return (data || []).map((row) => {
        const item = mapLaboratoryMembershipToApp(row);
        if (row.laboratories) item.laboratory = row.laboratories;
        return item;
      });
    }
    return LaboratoryMembership.find({ userId })
      .populate('laboratoryId', 'name department building roomNumber')
      .sort({ assignedAt: -1 })
      .lean();
  }

  async listByLab(laboratoryId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('laboratory_memberships')
        .select(`
          *,
          profiles (id, name, email, role)
        `)
        .eq('laboratory_id', laboratoryId)
        .order('assigned_at', { ascending: false });
      if (error) throw translateDbError(error);
      return (data || []).map((row) => {
        const item = mapLaboratoryMembershipToApp(row);
        if (row.profiles) item.user = row.profiles;
        return item;
      });
    }
    return LaboratoryMembership.find({ laboratoryId })
      .populate('userId', 'name email role')
      .sort({ assignedAt: -1 })
      .lean();
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('laboratory_memberships').select('id', { count: 'exact', head: true });
      if (filter.userId) query = query.eq('user_id', filter.userId);
      if (filter.laboratoryId) query = query.eq('laboratory_id', filter.laboratoryId);
      if (filter.role) query = query.eq('role', filter.role);
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    return LaboratoryMembership.countDocuments(filter);
  }

  async checkUserLabMembership(userId, laboratoryId) {
    if (!laboratoryId) return true;
    const membership = await this.findByUserAndLab(userId, laboratoryId);
    return !!membership;
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToLaboratoryMembership(data);
      const { data: res, error } = await client
        .from('laboratory_memberships')
        .insert(payload)
        .select()
        .single();
      if (error) throw translateDbError(error);
      return mapLaboratoryMembershipToApp(res);
    }
    return LaboratoryMembership.create(data);
  }

  async delete(userId, laboratoryId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client
        .from('laboratory_memberships')
        .delete()
        .eq('user_id', userId)
        .eq('laboratory_id', laboratoryId);
      if (error) throw translateDbError(error);
      return true;
    }
    await LaboratoryMembership.deleteOne({ userId, laboratoryId });
    return true;
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('laboratory_memberships').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    await LaboratoryMembership.findByIdAndDelete(id);
    return true;
  }
}

module.exports = new LaboratoryMembershipRepository();
