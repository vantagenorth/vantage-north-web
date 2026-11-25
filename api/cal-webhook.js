const crypto = require('crypto');
const {
  isSupabaseConfigured,
  getBookingByReference,
  getBookingByCalUid,
  updateBookingByReference,
} = require('./_lib/supabase');
const { logPaymentEvent, errorMessageOf } = require('./_lib/payment-log');

function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return !secret;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function dubaiDate(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date(iso));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const secret = process.env.CAL_WEBHOOK_SECRET;
    const sig = req.headers['x-cal-signature-256'];
    // Without a secret anyone could move or cancel bookings through this URL.
    if (!secret) {
      await logPaymentEvent({
        source: 'cal_webhook',
        event: 'webhook.no_secret',
        level: 'error',
        httpStatus: 503,
        message: 'CAL_WEBHOOK_SECRET is not set; Cal.com webhook ignored',
      });
      return res.status(503).json({ error: 'Webhook secret not configured' });
    }
    if (!verifySignature(rawBody, sig, secret)) {
      await logPaymentEvent({
        source: 'cal_webhook',
        event: 'webhook.rejected_signature',
        level: 'warn',
        httpStatus: 401,
      });
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const triggerEvent = event.triggerEvent;
    const payload = event.payload || {};

    if (!isSupabaseConfigured()) {
      return res.status(200).json({ received: true, skipped: true });
    }

    const metadataRef = payload?.metadata?.bookingReference || null;
    // On a reschedule Cal.com makes a new booking: uid is the new one and
    // rescheduleUid the one it replaced.
    const oldUid = payload?.rescheduleUid || null;
    const uid = payload?.uid || null;

    // Find our row: by booking reference first, then by the Cal.com uid we stored.
    async function findRow() {
      if (metadataRef) {
        const byRef = await getBookingByReference(metadataRef);
        if (byRef?.data) return byRef.data;
      }
      for (const candidate of [oldUid, uid]) {
        if (!candidate) continue;
        const byUid = await getBookingByCalUid(candidate);
        if (byUid) return byUid;
      }
      return null;
    }

    const row = await findRow();
    const bookingReference = row?.booking_reference || metadataRef;

    async function applyPatch(patch) {
      if (!row) return null;
      const res = await updateBookingByReference(row.booking_reference, patch);
      return res?.data || null;
    }

    async function logResult(updated, note = null) {
      await logPaymentEvent({
        source: 'cal_webhook',
        event: `cal.${String(triggerEvent).toLowerCase()}`,
        level: updated || note ? 'info' : 'warn',
        bookingReference,
        message: note || (updated ? null : 'No matching booking found to update'),
        details: { cal_booking_uid: uid, reschedule_uid: oldUid, updated: Boolean(updated) },
      });
    }

    if (triggerEvent === 'BOOKING_RESCHEDULED') {
      // Skip an old reschedule that arrives after a newer one was applied.
      if (row && row.cal_booking_uid && oldUid && row.cal_booking_uid !== oldUid && row.cal_booking_uid !== uid) {
        await logResult(null, 'Reschedule was for an older Cal.com booking; newer time kept');
        return res.status(200).json({ received: true, triggerEvent, updated: false, stale: true });
      }
      const startTime = payload.startTime || payload.start;
      const endTime = payload.endTime || payload.end;
      const patch = {
        status: 'confirmed',
        ...(startTime ? { scheduled_date: dubaiDate(startTime), scheduled_start: startTime } : {}),
        ...(endTime ? { scheduled_end: endTime } : {}),
        ...(payload.uid ? { cal_booking_uid: payload.uid } : {}),
        ...(payload.bookingId ? { cal_booking_id: payload.bookingId } : {}),
      };
      const updated = await applyPatch(patch);
      await logResult(updated);
      return res.status(200).json({ received: true, triggerEvent, updated: Boolean(updated) });
    }

    if (triggerEvent === 'BOOKING_CANCELLED') {
      // Ignore a cancel for a Cal.com booking that has since been replaced by a
      // reschedule: the client still has a live booking.
      if (row && row.cal_booking_uid && uid && row.cal_booking_uid !== uid) {
        await logResult(null, 'Cancel was for an older Cal.com booking; current booking kept');
        return res.status(200).json({ received: true, triggerEvent, updated: false, stale: true });
      }
      // Refunds are handled by hand: only the booking status changes, the
      // payment row is left as it is so the app can show a refund may be owed.
      const updated = await applyPatch({ status: 'cancelled' });
      await logResult(updated);
      return res.status(200).json({ received: true, triggerEvent, updated: Boolean(updated) });
    }

    return res.status(200).json({ received: true, ignored: triggerEvent || 'unknown' });
  } catch (err) {
    console.error('Error in /api/cal-webhook:', err);
    await logPaymentEvent({
      source: 'cal_webhook',
      event: 'webhook.exception',
      level: 'error',
      message: errorMessageOf(err),
    });
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
