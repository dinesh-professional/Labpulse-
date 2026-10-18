/**
 * Booking Repository (Module 06 / Module 07)
 * Handles data access for instrument reservations, scheduling, and lifecycle.
 * Backed by public.bookings (Supabase PostgreSQL) with GiST exclusion conflict handling.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const Booking = require('../models/Booking');
const QrAccessPass = require('../models/QrAccessPass');
const { mapBookingToApp, mapAppToBooking } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');
const { dayRangeUTC } = require('../utils/time');
const { BLOCKING_STATUSES } = require('../services/bookingLifecycle');

class BookingRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('bookings')
        .select(`
          *,
          instruments (id, name, category, model, status),
          profiles (id, name, email)
        `)
        .eq('id', id)
        .single();

      if (error || !data) return null;
      return mapBookingToApp(data);
    }
    return Booking.findById(id).populate('instrumentId', 'name category model status').populate('userId', 'name email');
  }

  async findByIdempotencyKey(idempotencyKey, userId) {
    if (!idempotencyKey) return null;
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client
        .from('bookings')
        .select(`
          *,
          instruments (id, name, category, model, status),
          profiles (id, name, email)
        `)
        .eq('idempotency_key', idempotencyKey);
      if (userId) query = query.eq('user_id', userId);
      const { data, error } = await query.limit(1);

      if (error || !data || data.length === 0) return null;
      return mapBookingToApp(data[0]);
    }
    const q = { idempotencyKey };
    if (userId) q.userId = userId;
    return Booking.findOne(q)
      .populate('instrumentId', 'name category model status')
      .populate('userId', 'name email');
  }

  _buildMongoFilter(filter = {}) {
    const { parseDayUTC } = require('../utils/time');
    const q = {};
    if (filter.instrumentId) q.instrumentId = filter.instrumentId;
    if (filter.userId) q.userId = filter.userId;
    if (filter.status) q.status = filter.status;
    if (filter.statusIn && Array.isArray(filter.statusIn)) q.status = { $in: filter.statusIn };

    if (filter.date) {
      q.date = parseDayUTC(filter.date);
    } else if (filter.startDate || filter.endDate || filter.dateGte) {
      q.date = {};
      const start = filter.startDate || filter.dateGte;
      if (start) q.date.$gte = parseDayUTC(start);
      if (filter.endDate) q.date.$lte = parseDayUTC(filter.endDate);
    }

    if (filter.q && typeof filter.q === 'string' && filter.q.trim()) {
      const regex = new RegExp(filter.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.purpose = regex;
    }
    return q;
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('bookings').select('id', { count: 'exact', head: true });
      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.userId) query = query.eq('user_id', filter.userId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.statusIn && Array.isArray(filter.statusIn)) query = query.in('status', filter.statusIn);
      if (filter.date) query = query.eq('date', filter.date);
      if (filter.startDate || filter.dateGte) query = query.gte('date', filter.startDate || filter.dateGte);
      if (filter.endDate) query = query.lte('date', filter.endDate);
      if (filter.q) {
        const clean = filter.q.trim().replace(/[%_]/g, '');
        if (clean) query = query.ilike('purpose', `%${clean}%`);
      }
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    return Booking.countDocuments(this._buildMongoFilter(filter));
  }

  async list(filter = {}, { page = 1, limit = 20, sortBy = 'date', sortOrder = 'desc' } = {}) {
    const ALLOWED_BOOKING_SORTS = {
      date: 'date',
      startTime: 'start_time',
      endTime: 'end_time',
      status: 'status',
      createdAt: 'created_at',
    };
    const dbSortCol = ALLOWED_BOOKING_SORTS[sortBy] || 'date';
    const isAsc = sortOrder === 'asc';

    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('bookings').select(`
        *,
        instruments (id, name, category, model, status),
        profiles (id, name, email)
      `);

      if (filter.instrumentId) query = query.eq('instrument_id', filter.instrumentId);
      if (filter.userId) query = query.eq('user_id', filter.userId);
      if (filter.status) query = query.eq('status', filter.status);
      if (filter.statusIn && Array.isArray(filter.statusIn)) query = query.in('status', filter.statusIn);
      if (filter.date) query = query.eq('date', filter.date);
      if (filter.startDate || filter.dateGte) query = query.gte('date', filter.startDate || filter.dateGte);
      if (filter.endDate) query = query.lte('date', filter.endDate);
      if (filter.q) {
        const clean = filter.q.trim().replace(/[%_]/g, '');
        if (clean) query = query.ilike('purpose', `%${clean}%`);
      }

      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query
        .order(dbSortCol, { ascending: isAsc })
        .order('id', { ascending: false })
        .range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map(mapBookingToApp);
    }

    const mongoFilter = this._buildMongoFilter(filter);
    const mongoSort = { [sortBy]: isAsc ? 1 : -1 };
    if (sortBy !== '_id') mongoSort._id = -1;

    return Booking.find(mongoFilter)
      .populate('instrumentId', 'name category model status')
      .populate('userId', 'name email')
      .sort(mongoSort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }

  async findConflict(instrumentId, dateStr, startTime, endTime, excludeId) {
    const blockingStatuses = ['CONFIRMED', 'CHECKED_IN', 'PENDING_APPROVAL'];

    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const startAt = new Date(`${dateStr}T${startTime}:00Z`).toISOString();
      const endAt = new Date(`${dateStr}T${endTime}:00Z`).toISOString();

      let query = client
        .from('bookings')
        .select('*')
        .eq('instrument_id', instrumentId)
        .in('status', blockingStatuses)
        .lt('start_at', endAt)
        .gt('end_at', startAt);

      if (excludeId) query = query.neq('id', excludeId);

      const { data, error } = await query.limit(1);
      if (error || !data || data.length === 0) return null;
      return mapBookingToApp(data[0]);
    }

    const range = dayRangeUTC(dateStr);
    if (!range) return null;
    const q = {
      instrumentId,
      date: { $gte: range.start, $lt: range.next },
      status: { $in: blockingStatuses },
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    };
    if (excludeId) q._id = { $ne: excludeId };
    return Booking.findOne(q).lean();
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToBooking(data);

      const dateStr = typeof data.date === 'string' ? data.date.slice(0, 10) : new Date(data.date).toISOString().slice(0, 10);
      payload.date = dateStr;
      payload.start_at = new Date(`${dateStr}T${data.startTime}:00Z`).toISOString();
      payload.end_at = new Date(`${dateStr}T${data.endTime}:00Z`).toISOString();

      const { data: res, error } = await client.from('bookings').insert(payload).select().single();
      if (error) {
        throw translateDbError(error);
      }
      return mapBookingToApp(res);
    }
    return Booking.create(data);
  }

  async updateById(id, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToBooking(data);
      if (data.date && data.startTime && data.endTime) {
        const dateStr = typeof data.date === 'string' ? data.date.slice(0, 10) : new Date(data.date).toISOString().slice(0, 10);
        payload.date = dateStr;
        payload.start_at = new Date(`${dateStr}T${data.startTime}:00Z`).toISOString();
        payload.end_at = new Date(`${dateStr}T${data.endTime}:00Z`).toISOString();
      }
      payload.updated_at = new Date().toISOString();

      const { data: res, error } = await client.from('bookings').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapBookingToApp(res);
    }
    return Booking.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }

  async updateStatus(id, newStatus, { notes, actorId, reason } = {}) {
    const updates = { status: newStatus };
    if (newStatus === 'CONFIRMED') {
      updates.approvedBy = actorId;
      updates.approvedAt = new Date();
      if (notes) updates.approvalNotes = notes;
    } else if (newStatus === 'REJECTED') {
      if (reason) updates.rejectionReason = reason;
      if (notes) updates.approvalNotes = notes;
      updates.approvedBy = actorId;
      updates.approvedAt = new Date();
    }
    return this.updateById(id, updates);
  }

  async cancelBookingAtomic(bookingId, userId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.rpc('cancel_booking_atomic', {
        p_booking_id: bookingId,
        p_user_id: userId,
      });
      if (error) throw translateDbError(error);
      return data;
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return null;
    booking.status = 'CANCELLED';
    await booking.save();
    await QrAccessPass.updateMany({ bookingId, status: 'ACTIVE' }, { status: 'REVOKED' });
    return booking;
  }

  async deleteById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { error } = await client.from('bookings').delete().eq('id', id);
      if (error) throw translateDbError(error);
      return true;
    }
    return Booking.findByIdAndDelete(id);
  }
}

module.exports = new BookingRepository();
