/**
 * Notification Repository (Module 06 & Module 10)
 * Handles data access for user operational notifications and transactional outbox.
 * Backed by public.notifications / public.notification_outbox (Supabase PostgreSQL)
 * with fallback to Notification / NotificationOutbox Mongoose models.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const Notification = require('../models/Notification');
const NotificationOutbox = require('../models/NotificationOutbox');
const {
  mapNotificationToApp,
  mapAppToNotification,
  mapOutboxToApp,
  mapAppToOutbox,
} = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

class NotificationRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('notifications').select('*').eq('id', id).single();
      if (error || !data) return null;
      return mapNotificationToApp(data);
    }
    return Notification.findById(id);
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('notifications').select('id', { count: 'exact', head: true });
      if (filter.userId) query = query.eq('user_id', filter.userId);
      if (filter.read !== undefined) query = query.eq('read', filter.read);
      if (filter.type) query = query.eq('type', filter.type);
      if (filter.entityType) query = query.eq('entity_type', filter.entityType);
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    return Notification.countDocuments(filter);
  }

  async getUnreadCount(userId) {
    return this.count({ userId, read: false });
  }

  async list(filter = {}, { page = 1, limit = 20 } = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('notifications').select('*');
      if (filter.userId) query = query.eq('user_id', filter.userId);
      if (filter.read !== undefined) query = query.eq('read', filter.read);
      if (filter.type) query = query.eq('type', filter.type);
      if (filter.entityType) query = query.eq('entity_type', filter.entityType);
      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.order('created_at', { ascending: false }).range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map(mapNotificationToApp);
    }
    return Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }

  async create(data) {
    // Idempotent creation if dedupKey is provided
    if (data.dedupKey) {
      if (getActiveDataBackend() === 'supabase') {
        const client = getSupabaseAdminClient();
        const { data: existing } = await client
          .from('notifications')
          .select('*')
          .eq('dedup_key', data.dedupKey)
          .maybeSingle();
        if (existing) return mapNotificationToApp(existing);
      } else {
        const existing = await Notification.findOne({ dedupKey: data.dedupKey }).lean();
        if (existing) return existing;
      }
    }

    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToNotification(data);
      const { data: res, error } = await client.from('notifications').insert(payload).select().single();
      if (error) {
        // If race condition hit on unique dedup_key, fetch and return existing
        if (error.code === '23505' && data.dedupKey) {
          const { data: existing } = await client
            .from('notifications')
            .select('*')
            .eq('dedup_key', data.dedupKey)
            .maybeSingle();
          if (existing) return mapNotificationToApp(existing);
        }
        throw translateDbError(error);
      }
      return mapNotificationToApp(res);
    }

    try {
      return await Notification.create(data);
    } catch (err) {
      if (err.code === 11000 && data.dedupKey) {
        return Notification.findOne({ dedupKey: data.dedupKey }).lean();
      }
      throw err;
    }
  }

  async markAsRead(id, userId) {
    const nowIso = new Date().toISOString();
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('notifications').update({ read: true, read_at: nowIso }).eq('id', id);
      if (userId) query = query.eq('user_id', userId);
      const { data, error } = await query.select().maybeSingle();
      if (error) throw translateDbError(error);
      return data ? mapNotificationToApp(data) : null;
    }
    const q = { _id: id };
    if (userId) q.userId = userId;
    return Notification.findOneAndUpdate(q, { read: true, readAt: new Date() }, { new: true });
  }

  async markAsUnread(id, userId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('notifications').update({ read: false, read_at: null }).eq('id', id);
      if (userId) query = query.eq('user_id', userId);
      const { data, error } = await query.select().maybeSingle();
      if (error) throw translateDbError(error);
      return data ? mapNotificationToApp(data) : null;
    }
    const q = { _id: id };
    if (userId) q.userId = userId;
    return Notification.findOneAndUpdate(q, { read: false, readAt: null }, { new: true });
  }

  async markAllAsRead(userId) {
    const nowIso = new Date().toISOString();
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('notifications')
        .update({ read: true, read_at: nowIso })
        .eq('user_id', userId)
        .eq('read', false)
        .select();
      if (error) throw translateDbError(error);
      return (data || []).map(mapNotificationToApp);
    }
    return Notification.updateMany({ userId, read: false }, { read: true, readAt: new Date() });
  }

  async deleteById(id, userId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('notifications').delete().eq('id', id);
      if (userId) query = query.eq('user_id', userId);
      const { data, error } = await query.select();
      if (error) throw translateDbError(error);
      return data && data.length > 0;
    }
    const q = { _id: id };
    if (userId) q.userId = userId;
    const res = await Notification.findOneAndDelete(q);
    return !!res;
  }

  // ============================================================================
  // Transactional Notification Outbox (Module 10)
  // ============================================================================

  async enqueueOutbox({ eventId, eventType, payload }) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const row = mapAppToOutbox({
        eventId,
        eventType,
        payload,
        status: 'PENDING',
        attempts: 0,
      });
      const { data, error } = await client.from('notification_outbox').insert(row).select().single();
      if (error) {
        if (error.code === '23505') {
          // Idempotent: already enqueued
          const { data: existing } = await client
            .from('notification_outbox')
            .select('*')
            .eq('event_id', eventId)
            .single();
          return mapOutboxToApp(existing);
        }
        throw translateDbError(error);
      }
      return mapOutboxToApp(data);
    }

    try {
      const row = await NotificationOutbox.create({
        eventId,
        eventType,
        payload,
        status: 'PENDING',
        attempts: 0,
      });
      return row;
    } catch (err) {
      if (err.code === 11000) {
        return NotificationOutbox.findOne({ eventId }).lean();
      }
      throw err;
    }
  }

  async fetchPendingOutbox(limit = 50) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('notification_outbox')
        .select('*')
        .in('status', ['PENDING', 'PROCESSING'])
        .lt('attempts', 3)
        .order('created_at', { ascending: true })
        .limit(limit);
      if (error) throw translateDbError(error);
      return (data || []).map(mapOutboxToApp);
    }
    return NotificationOutbox.find({
      status: { $in: ['PENDING', 'PROCESSING'] },
      attempts: { $lt: 3 },
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
  }

  async updateOutboxStatus(id, { status, attempts, lastError, processedAt }) {
    const updateObj = { status };
    if (attempts !== undefined) updateObj.attempts = attempts;
    if (lastError !== undefined) updateObj.last_error = lastError;
    if (processedAt !== undefined) updateObj.processed_at = processedAt ? new Date(processedAt).toISOString() : null;

    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('notification_outbox')
        .update(updateObj)
        .eq('id', id)
        .select()
        .single();
      if (error) throw translateDbError(error);
      return mapOutboxToApp(data);
    }

    const mongoUpdate = { status };
    if (attempts !== undefined) mongoUpdate.attempts = attempts;
    if (lastError !== undefined) mongoUpdate.lastError = lastError;
    if (processedAt !== undefined) mongoUpdate.processedAt = processedAt;
    return NotificationOutbox.findByIdAndUpdate(id, mongoUpdate, { new: true }).lean();
  }

  async findOutboxByEventId(eventId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('notification_outbox')
        .select('*')
        .eq('event_id', eventId)
        .maybeSingle();
      if (error || !data) return null;
      return mapOutboxToApp(data);
    }
    return NotificationOutbox.findOne({ eventId }).lean();
  }
}

module.exports = new NotificationRepository();
