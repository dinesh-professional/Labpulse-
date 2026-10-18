/**
 * QR Access Pass Repository (Module 06)
 * Handles data access for single-use cryptographic terminal access passes.
 * Backed by public.qr_access_passes (Supabase PostgreSQL) with atomic redemption via stored function.
 */
const { getSupabaseAdminClient, getActiveDataBackend } = require('../config/supabase');
const QrAccessPass = require('../models/QrAccessPass');
const Booking = require('../models/Booking');
const { mapQrAccessPassToApp, mapAppToQrAccessPass } = require('./mappers');
const { translateDbError } = require('../utils/dbErrors');

class QrRepository {
  async findById(id) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('qr_access_passes').select('*').eq('id', id).single();
      if (error || !data) return null;
      return mapQrAccessPassToApp(data);
    }
    return QrAccessPass.findById(id);
  }

  async findByTokenHash(tokenHash) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('qr_access_passes').select('*').eq('token_hash', tokenHash).single();
      if (error || !data) return null;
      return mapQrAccessPassToApp(data);
    }
    return QrAccessPass.findOne({ tokenHash });
  }

  async findByBookingId(bookingId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from('qr_access_passes').select('*').eq('booking_id', bookingId).single();
      if (error || !data) return null;
      return mapQrAccessPassToApp(data);
    }
    return QrAccessPass.findOne({ bookingId });
  }

  async count(filter = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('qr_access_passes').select('id', { count: 'exact', head: true });
      if (filter.bookingId) query = query.eq('booking_id', filter.bookingId);
      if (filter.status) query = query.eq('status', filter.status);
      const { count, error } = await query;
      if (error) throw translateDbError(error);
      return count || 0;
    }
    return QrAccessPass.countDocuments(filter);
  }

  async list(filter = {}, { page = 1, limit = 20 } = {}) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      let query = client.from('qr_access_passes').select('*');
      if (filter.bookingId) query = query.eq('booking_id', filter.bookingId);
      if (filter.status) query = query.eq('status', filter.status);
      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.order('created_at', { ascending: false }).range(from, to);

      const { data, error } = await query;
      if (error) throw translateDbError(error);
      return (data || []).map(mapQrAccessPassToApp);
    }
    return QrAccessPass.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
  }

  async create(data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToQrAccessPass(data);
      const { data: res, error } = await client.from('qr_access_passes').insert(payload).select().single();
      if (error) throw translateDbError(error);
      return mapQrAccessPassToApp(res);
    }
    return QrAccessPass.create(data);
  }

  async updateById(id, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToQrAccessPass(data);
      payload.updated_at = new Date().toISOString();
      const { data: res, error } = await client.from('qr_access_passes').update(payload).eq('id', id).select().single();
      if (error) throw translateDbError(error);
      return mapQrAccessPassToApp(res);
    }
    return QrAccessPass.findByIdAndUpdate(id, data, { new: true });
  }

  /**
   * Atomic check-in and pass redemption.
   * Invokes PostgreSQL stored procedure public.redeem_qr_pass() with SELECT ... FOR UPDATE row locking.
   */
  async redeemPassAtomic(tokenHash, operatorId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.rpc('redeem_qr_pass', {
        p_token_hash: tokenHash,
        p_operator_id: operatorId,
      });
      if (error) throw translateDbError(error);
      return data;
    }

    const pass = await QrAccessPass.findOne({ tokenHash });
    if (!pass) return { success: false, error: 'QR_NOT_FOUND' };
    if (pass.status === 'REVOKED') return { success: false, error: 'QR_REVOKED' };
    if (pass.status === 'USED') return { success: false, error: 'QR_ALREADY_USED' };
    if (pass.status === 'EXPIRED' || pass.expiresAt < new Date()) {
      pass.status = 'EXPIRED';
      await pass.save();
      return { success: false, error: 'QR_EXPIRED' };
    }

    const booking = await Booking.findById(pass.bookingId);
    if (!booking) return { success: false, error: 'BOOKING_GONE' };
    if (booking.status === 'CANCELLED') return { success: false, error: 'BOOKING_CANCELLED' };
    if (booking.status === 'CHECKED_IN' || booking.status === 'COMPLETED') return { success: false, error: 'ALREADY_CHECKED_IN' };

    const now = new Date();
    pass.status = 'USED';
    pass.checkedInAt = now;
    await pass.save();

    booking.status = 'CHECKED_IN';
    await booking.save();

    return {
      success: true,
      booking_id: booking._id,
      pass_id: pass._id,
      checked_in_at: now.toISOString(),
    };
  }

  async updateByBookingId(bookingId, data) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const payload = mapAppToQrAccessPass(data);
      payload.updated_at = new Date().toISOString();
      const { data: res, error } = await client
        .from('qr_access_passes')
        .update(payload)
        .eq('booking_id', bookingId)
        .eq('status', 'ACTIVE')
        .select();
      if (error) throw translateDbError(error);
      return (res || []).map(mapQrAccessPassToApp);
    }
    return QrAccessPass.updateMany({ bookingId, status: 'ACTIVE' }, data);
  }

  async findActiveByBookingId(bookingId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('qr_access_passes')
        .select('*')
        .eq('booking_id', bookingId)
        .eq('status', 'ACTIVE')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (error || !data) return null;
      return mapQrAccessPassToApp(data);
    }
    return QrAccessPass.findOne({ bookingId, status: 'ACTIVE' }).sort({ createdAt: -1 }).lean();
  }

  async revokeForBooking(bookingId) {
    if (getActiveDataBackend() === 'supabase') {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from('qr_access_passes')
        .update({ status: 'REVOKED', updated_at: new Date().toISOString() })
        .eq('booking_id', bookingId)
        .eq('status', 'ACTIVE');
      if (error) throw translateDbError(error);
      return data;
    }
    return QrAccessPass.updateMany({ bookingId, status: 'ACTIVE' }, { status: 'REVOKED' });
  }
}

module.exports = new QrRepository();
