/**
 * User / Profile Repository (Module 06)
 * Handles data access for user accounts and profiles.
 * Backed by public.profiles (Supabase PostgreSQL) with fallback to User model.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const User = require('../models/User');
const { mapProfileToApp, mapAppToProfile } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

class UserRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('profiles').select('*').eq('id', id).single();
      if (error || !data) return null;
      return mapProfileToApp(data);
    }
    return User.findById(id);
  }

  async findByEmail(email) {
    const norm = String(email || '').trim().toLowerCase();
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('profiles').select('*').eq('email', norm).single();
      if (error || !data) return null;
      return mapProfileToApp(data);
    }
    return User.findOne({ email: norm });
  }

  async findWithPasswordByEmail(email) {
    const norm = String(email || '').trim().toLowerCase();
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('profiles').select('*').eq('email', norm).single();
      if (error || !data) return null;
      return mapProfileToApp(data);
    }
    return User.findOne({ email: norm }).select('+passwordHash');
  }

  async findByResetToken(tokenHash) {
    if (getActiveDataBackend() === 'supabase') {
      // In Supabase Auth, reset flows use Supabase Auth magic links/recovery tokens
      return null;
    }
    return User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpires: { $gt: new Date() },
    }).select('+passwordResetTokenHash');
  }

  async findByActivationToken(tokenHash) {
    if (getActiveDataBackend() === 'supabase') {
      return null;
    }
    return User.findOne({
      activationTokenHash: tokenHash,
      activationExpires: { $gt: new Date() },
    }).select('+activationTokenHash');
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('profiles').select('id', { count: 'exact', head: true });
      if (filter.role) query = query.eq('role', filter.role);
      if (filter.isActive !== undefined) query = query.eq('is_active', filter.isActive);
      if (filter.department) query = query.eq('department', filter.department);
      if (filter.q) {
        const clean = filter.q.trim().replace(/[%_]/g, '');
        if (clean) {
          query = query.or(`name.ilike.%${clean}%,email.ilike.%${clean}%,department.ilike.%${clean}%,student_id.ilike.%${clean}%,faculty_id.ilike.%${clean}%`);
        }
      }
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    return User.countDocuments(this._buildMongoFilter(filter));
  }

  _buildMongoFilter(filter = {}) {
    const mFilter = { ...filter };
    if (mFilter.q) {
      const term = mFilter.q.trim();
      delete mFilter.q;
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      mFilter.$or = [
        { name: regex },
        { email: regex },
        { department: regex },
        { studentId: regex },
        { facultyId: regex },
      ];
    }
    return mFilter;
  }

  async list(filter = {}, { page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = {}) {
    const ALLOWED_USER_SORTS = {
      name: 'name',
      email: 'email',
      role: 'role',
      department: 'department',
      createdAt: 'created_at',
    };
    const dbSortCol = ALLOWED_USER_SORTS[sortBy] || 'created_at';
    const isAsc = sortOrder === 'asc';

    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('profiles').select('*');
      if (filter.role) query = query.eq('role', filter.role);
      if (filter.isActive !== undefined) query = query.eq('is_active', filter.isActive);
      if (filter.department) query = query.eq('department', filter.department);
      if (filter.q) {
        const clean = filter.q.trim().replace(/[%_]/g, '');
        if (clean) {
          query = query.or(`name.ilike.%${clean}%,email.ilike.%${clean}%,department.ilike.%${clean}%,student_id.ilike.%${clean}%,faculty_id.ilike.%${clean}%`);
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
      return (data || []).map(mapProfileToApp);
    }

    const mFilter = { ...filter };
    if (mFilter.q) {
      const term = mFilter.q.trim();
      delete mFilter.q;
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      mFilter.$or = [
        { name: regex },
        { email: regex },
        { department: regex },
        { studentId: regex },
        { facultyId: regex },
      ];
    }

    const mongoSort = { [sortBy]: isAsc ? 1 : -1 };
    if (sortBy !== '_id') mongoSort._id = -1;

    return User.find(mFilter)
      .sort(mongoSort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }

  async create(userData) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToProfile(userData);
      const { data, error } = await client.from('profiles').insert(payload).select().single();
      if (error) throw translateDbError(error);
      return mapProfileToApp(data);
    }
    return User.create(userData);
  }

  async updateById(id, updateData) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToProfile(updateData);
      payload.updated_at = new Date().toISOString();
      const { data, error } = await client.from('profiles').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapProfileToApp(data);
    }
    return User.findByIdAndUpdate(id, updateData, { new: true, runValidators: true });
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('profiles').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    return User.findByIdAndDelete(id);
  }

  async bumpTokenVersion(id) {
    if (getActiveDataBackend() === 'supabase') {
      const user = await this.findById(id);
      if (!user) return null;
      return this.updateById(id, { tokenVersion: (user.tokenVersion || 0) + 1 });
    }
    const u = await User.findById(id);
    if (!u) return null;
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    await u.save();
    return u;
  }

  async incrementTokenVersion(id) {
    if (getActiveDataBackend() === 'supabase') {
      return this.bumpTokenVersion(id);
    }
    return User.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } });
  }
}

module.exports = new UserRepository();
