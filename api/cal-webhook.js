const crypto = require('crypto');
const {
  isSupabaseConfigured,
  updateBookingByReference,
  updateBookingByCalUid,
  getBookingForManage,
  supabaseFetch,
} = require('./_lib/supabase');
const { logPaymentEvent, errorMessageOf } = require('./_lib/payment-log');
const { sendResendEmail } = require('./_lib/confirm-core');
const { isLateReschedule, amountPaidAed, formatDubaiTime, adminNoticeHtml } = require('./_lib/manage');

// The booking as we have it, found by reference or Cal.com uid.
async function findBooking(bookingReference, calUid) {
  if (bookingReference) {
    const b = await getBookingForManage(bookingReference);
    if (b) return b;
  }
  if (calUid) {
    const res = await supabaseFetch(
      `bookings?cal_booking_uid=eq.${encodeURIComponent(calUid)}&select=*,clients(*),payments(*)&limit=1`,
      { method: 'GET' }
    );
    return Array.isArray(res.data) ? res.data[0] || null : null;
  }
  return null;
}

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

    async function logResult(updated) {
      await logPaymentEvent({
        source: 'cal_webhook',
        event: `cal.${String(triggerEvent).toLowerCase()}`,
        level: updated ? 'info' : 'warn',
        bookingReference,
        message: updated ? null : 'No matching booking found to update',
        details: { cal_booking_uid: calUid, updated: Boolean(updated) },
      });
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
      // Our reschedule page already saved this change (same new uid): nothing more to add.
      // Otherwise it was done on Cal.com (old links, or by Andy), so apply the same
      // bookkeeping and 24-hour rule as our page does.
      const existing = await findBooking(bookingReference, payload.rescheduleUid || null).catch(() => null);
      if (existing && payload.uid && existing.cal_booking_uid !== payload.uid) {
        const late = isLateReschedule(existing.scheduled_start);
        Object.assign(patch, {
          original_scheduled_start: existing.original_scheduled_start || existing.scheduled_start || null,
          reschedule_count: (existing.reschedule_count || 0) + 1,
          last_rescheduled_at: new Date().toISOString(),
          last_rescheduled_by: 'cal.com',
          non_refundable: Boolean(existing.non_refundable) || late,
        });
      }
      const updated = await applyPatch(patch);
      await logResult(updated);
      return res.status(200).json({ received: true, triggerEvent, updated: Boolean(updated) });
    }

    if (triggerEvent === 'BOOKING_CANCELLED') {
      const existing = await findBooking(bookingReference, calUid).catch(() => null);
      if (existing && payload.uid && existing.cal_booking_uid && existing.cal_booking_uid !== payload.uid) {
        // An older Cal.com booking that was replaced by a reschedule, not this booking.
        await logResult(null);
        return res.status(200).json({ received: true, triggerEvent, ignored: 'stale_uid' });
      }
      if (existing && existing.cancelled_by) {
        // Cancelled from our cancel page, which handles the refund itself.
        const updated = await applyPatch({ status: 'cancelled' });
        await logResult(updated);
        return res.status(200).json({ received: true, triggerEvent, updated: Boolean(updated) });
      }
      // Cancelled on Cal.com directly: no refund was made, so flag it for review.
      const paid = existing ? amountPaidAed(existing) : 0;
      const updated = await applyPatch({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_by: 'cal.com',
        cancellation_reason: payload.cancellationReason || null,
        refund_status: paid > 0 ? 'needs_review' : 'none',
      });
      await logResult(updated);
      const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
      if (adminEmail && existing) {
        await sendResendEmail({
          to: adminEmail,
          subject: `[Review refund] ${existing.booking_reference} was cancelled on Cal.com`,
          html: adminNoticeHtml({
            title: 'Booking cancelled on Cal.com, not through our cancel page',
            lines: [
              ['Booking Reference', existing.booking_reference, true],
              ['Client', `${existing.clients?.name || ''} (${existing.clients?.email || ''})`],
              ['Was Scheduled', existing.scheduled_start ? `${formatDubaiTime(existing.scheduled_start)} (Dubai)` : 'None'],
              ['Amount Paid', `${paid} AED`],
              ['Action', 'No refund was made automatically. Check the 24-hour rule and refund in Ziina if due.'],
            ],
          }),
        }).catch(() => null);
      }
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
