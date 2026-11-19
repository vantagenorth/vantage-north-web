const crypto = require('crypto');
const {
  isSupabaseConfigured,
  updateBookingByReference,
  updateBookingByCalUid,
} = require('./_lib/supabase');

function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return !secret;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const secret = process.env.CAL_WEBHOOK_SECRET;
    const sig = req.headers['x-cal-signature-256'];
    if (secret && !verifySignature(rawBody, sig, secret)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const triggerEvent = event.triggerEvent;
    const payload = event.payload || {};

    if (!isSupabaseConfigured()) {
      return res.status(200).json({ received: true, skipped: true });
    }

    const bookingReference = payload?.metadata?.bookingReference || null;
    const calUid = payload?.rescheduleUid || payload?.uid || null;

    async function applyPatch(patch) {
      if (bookingReference) {
        const resByRef = await updateBookingByReference(bookingReference, patch);
        if (resByRef?.data) return resByRef.data;
      }
      if (calUid) {
        const resByUid = await updateBookingByCalUid(calUid, patch);
        return resByUid?.data || null;
      }
      return null;
    }

    if (triggerEvent === 'BOOKING_RESCHEDULED') {
      const startTime = payload.startTime || payload.start;
      const endTime = payload.endTime || payload.end;
      const patch = {
        status: 'confirmed',
        ...(startTime ? { scheduled_date: String(startTime).slice(0, 10), scheduled_start: startTime } : {}),
        ...(endTime ? { scheduled_end: endTime } : {}),
        ...(payload.uid ? { cal_booking_uid: payload.uid } : {}),
        ...(payload.bookingId ? { cal_booking_id: payload.bookingId } : {}),
      };
      const updated = await applyPatch(patch);
      return res.status(200).json({ received: true, triggerEvent, updated: Boolean(updated) });
    }

    if (triggerEvent === 'BOOKING_CANCELLED') {
      const updated = await applyPatch({ status: 'cancelled' });
      return res.status(200).json({ received: true, triggerEvent, updated: Boolean(updated) });
    }

    return res.status(200).json({ received: true, ignored: triggerEvent || 'unknown' });
  } catch (err) {
    console.error('Error in /api/cal-webhook:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
