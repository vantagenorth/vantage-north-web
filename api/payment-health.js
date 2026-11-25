// Payment health check. Supabase pg_cron calls this every 5 minutes
// (supabase/migrations/20261122140100_payment_health_schedule.sql).
//
// 1. Alerts when a checkout hold has been stuck in 'processing' for more than
//    5 minutes: the payment was confirmed but the booking never finished.
// 2. Checks expired 'pending' holds with Ziina. Paid ones raise an alert
//    (paid, but neither the webhook nor the redirect confirmed it). Unpaid
//    ones are marked 'abandoned' or 'expired'.
// 3. Alerts when Ziina reported a completed payment with no checkout hold and
//    no payment record has appeared since.
// 4. Deletes abandoned and expired holds older than 24 hours.
//
// Each alert is emailed once: an alert.* row in payment_events marks it sent.

const crypto = require('crypto');
const {
  isSupabaseConfigured,
  listCheckoutHolds,
  deleteCheckoutHoldsWhere,
  updateCheckoutHoldStatus,
  listPaymentEvents,
  getBookingByReference,
  getPaymentByIntentId,
  deleteCheckoutHold,
} = require('./_lib/supabase');
const { sendResendEmail } = require('./_lib/confirm-core');
const { logPaymentEvent, ziinaSummary, errorMessageOf } = require('./_lib/payment-log');

const STUCK_AFTER_MS = 5 * 60 * 1000;
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;
const NO_HOLD_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const MAX_ZIINA_CHECKS_PER_RUN = 20;

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = String(req.headers.authorization || '');
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDubai(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dubai',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function alreadyAlerted(alertEvent, { bookingReference, intentId }) {
  const params = new URLSearchParams({ select: 'id', event: `eq.${alertEvent}`, limit: '1' });
  if (bookingReference) params.set('booking_reference', `eq.${bookingReference}`);
  else if (intentId) params.set('ziina_payment_intent_id', `eq.${intentId}`);
  else return false;
  const rows = await listPaymentEvents(params.toString());
  return rows.length > 0;
}

async function recentEventsFor({ bookingReference, intentId }) {
  const params = new URLSearchParams({
    select: 'created_at,source,event,level,http_status,ziina_status,message',
    order: 'created_at.desc',
    limit: '15',
  });
  if (bookingReference && intentId) {
    params.set('or', `(booking_reference.eq.${bookingReference},ziina_payment_intent_id.eq.${intentId})`);
  } else if (bookingReference) {
    params.set('booking_reference', `eq.${bookingReference}`);
  } else if (intentId) {
    params.set('ziina_payment_intent_id', `eq.${intentId}`);
  } else {
    return [];
  }
  try {
    return await listPaymentEvents(params.toString());
  } catch {
    return [];
  }
}

function buildAlertHtml({ title, summary, nextSteps, bookingReference, intentId, payload, ziina, events }) {
  const p = payload || {};
  const rows = [
    ['Booking reference', bookingReference],
    ['Ziina payment ID', intentId],
    ['Ziina status', ziina?.status],
    ['Amount', p.priceAed ? `${p.priceAed} AED` : ziina?.amount ? `${ziina.amount / 100} AED` : null],
    ['Customer', p.fullName],
    ['Email', p.email],
    ['Phone', p.phone],
    ['Property', [p.propertyType, p.bedroomTier].filter(Boolean).join(' — ')],
    ['Unit', [p.unitNumber, p.projectName, p.areaCommunity].filter(Boolean).join(', ')],
    ['Slot', p.scheduledStart ? formatDubai(p.scheduledStart) : null],
    ['Package', p.packageLabel],
  ].filter(([, v]) => v);

  const eventRows = (events || [])
    .map(
      (e) => `<tr>
        <td style="padding:4px 8px; white-space:nowrap; color:#646464;">${escapeHtml(formatDubai(e.created_at))}</td>
        <td style="padding:4px 8px; white-space:nowrap;">${escapeHtml(e.event)}</td>
        <td style="padding:4px 8px; color:${e.level === 'error' ? '#B42318' : e.level === 'warn' ? '#B54708' : '#2B2B2B'};">${escapeHtml(
          [e.http_status, e.ziina_status, e.message].filter(Boolean).join(' · ')
        )}</td>
      </tr>`
    )
    .join('');

  return `<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:#2B2B2B; max-width:640px;">
    <h2 style="margin:0 0 8px; font-size:18px;">${escapeHtml(title)}</h2>
    <p style="margin:0 0 16px; font-size:14px; line-height:1.5;">${escapeHtml(summary)}</p>
    <table style="border-collapse:collapse; font-size:14px; margin-bottom:16px;">
      ${rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 12px 4px 0; color:#646464;">${escapeHtml(k)}</td><td style="padding:4px 0;"><strong>${escapeHtml(v)}</strong></td></tr>`
        )
        .join('')}
    </table>
    <p style="margin:0 0 6px; font-size:14px;"><strong>What to do</strong></p>
    <p style="margin:0 0 16px; font-size:14px; line-height:1.5;">${escapeHtml(nextSteps)}</p>
    ${
      eventRows
        ? `<p style="margin:0 0 6px; font-size:14px;"><strong>Recent events (newest first, Dubai time)</strong></p>
    <table style="border-collapse:collapse; font-size:12px;">${eventRows}</table>`
        : ''
    }
  </div>`;
}

async function sendAlert({ alertEvent, subject, bookingReference, intentId, html, details }) {
  const to = process.env.PAYMENT_ALERT_EMAIL || process.env.ADMIN_NOTIFICATION_EMAIL;
  const result = await sendResendEmail({ to, subject, html });
  if (result.sent) {
    // This row is what stops the same alert being sent again.
    await logPaymentEvent({
      source: 'health',
      event: alertEvent,
      level: 'error',
      bookingReference,
      intentId,
      message: subject,
      details: { ...details, resend_id: result.id },
    });
  } else {
    await logPaymentEvent({
      source: 'health',
      event: 'alert.email_failed',
      level: 'error',
      bookingReference,
      intentId,
      message: result.reason,
      details: { alert: alertEvent },
    });
  }
  return result.sent;
}

async function fetchZiinaIntent(intentId) {
  const ziinaKey = process.env.ZIINA_API_KEY;
  if (!ziinaKey) throw new Error('ZIINA_API_KEY is not configured');
  const res = await fetch(`https://api-v2.ziina.com/api/payment_intent/${encodeURIComponent(intentId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${ziinaKey}` },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 1. Holds stuck in 'processing'
async function checkStuckProcessing(now, summary) {
  const holds = await listCheckoutHolds(
    new URLSearchParams({
      select: 'booking_reference,ziina_payment_intent_id,created_at,status,payload',
      status: 'eq.processing',
      order: 'created_at.asc',
      limit: '50',
    }).toString()
  );

  for (const hold of holds) {
    const ref = hold.booking_reference;
    const intentId = hold.ziina_payment_intent_id;

    // When did confirmation start? Use the latest finalize.started event, or
    // the hold's creation time if there is none.
    const started = await listPaymentEvents(
      new URLSearchParams({
        select: 'created_at',
        booking_reference: `eq.${ref}`,
        event: 'in.("finalize.started","finalize.claim_wait_timeout")',
        order: 'created_at.desc',
        limit: '1',
      }).toString()
    );
    const startedAt = new Date(started[0]?.created_at || hold.created_at).getTime();
    if (now - startedAt < STUCK_AFTER_MS) continue;

    summary.stuckProcessing += 1;
    if (await alreadyAlerted('alert.stuck_processing', { bookingReference: ref })) continue;

    // If the booking did get saved (only the hold delete failed), tidy up quietly.
    const existing = await getBookingByReference(ref);
    if (existing.data) {
      await deleteCheckoutHold(ref);
      await logPaymentEvent({
        source: 'health',
        event: 'health.stale_hold_removed',
        level: 'warn',
        bookingReference: ref,
        intentId,
        message: 'Booking exists but its hold was still in processing; hold removed',
      });
      continue;
    }

    const events = await recentEventsFor({ bookingReference: ref, intentId });
    const sent = await sendAlert({
      alertEvent: 'alert.stuck_processing',
      subject: `[ACTION REQUIRED: Paid booking not created] ${ref}`,
      bookingReference: ref,
      intentId,
      details: { started_at: new Date(startedAt).toISOString() },
      html: buildAlertHtml({
        title: 'A paid booking did not finish',
        summary: `Payment for ${ref} was confirmed and booking creation started at ${formatDubai(
          new Date(startedAt).toISOString()
        )}, but it has not completed. The customer has paid and may not have a booking or confirmation email.`,
        nextSteps:
          'Check the events below for the step that failed. Then check your Google Calendar for a booking in this slot, add it by hand if needed, and email the customer. Refund through Ziina if the slot cannot be honoured.',
        bookingReference: ref,
        intentId,
        payload: hold.payload,
        events,
      }),
    });
    if (sent) summary.alertsSent += 1;
  }
}

// 2. Expired 'pending' holds: check with Ziina whether they were paid
async function checkExpiredPending(now, summary) {
  const holds = await listCheckoutHolds(
    new URLSearchParams({
      select: 'booking_reference,ziina_payment_intent_id,created_at,expires_at,status,payload',
      status: 'eq.pending',
      expires_at: `lt.${new Date(now - STUCK_AFTER_MS).toISOString()}`,
      order: 'expires_at.asc',
      limit: String(MAX_ZIINA_CHECKS_PER_RUN),
    }).toString()
  );

  for (const hold of holds) {
    const ref = hold.booking_reference;
    const intentId = hold.ziina_payment_intent_id;
    summary.expiredPendingChecked += 1;

    if (!intentId) {
      await updateCheckoutHoldStatus(ref, 'abandoned');
      summary.markedAbandoned += 1;
      continue;
    }

    let ziina;
    try {
      ziina = await fetchZiinaIntent(intentId);
    } catch (err) {
      await logPaymentEvent({
        source: 'health',
        event: 'ziina.verify_failed',
        level: 'error',
        bookingReference: ref,
        intentId,
        message: errorMessageOf(err),
      });
      continue;
    }
    if (!ziina.ok) {
      await logPaymentEvent({
        source: 'health',
        event: 'ziina.verify_failed',
        level: 'error',
        bookingReference: ref,
        intentId,
        httpStatus: ziina.status,
        message: ziina.data?.message || 'Ziina payment intent lookup failed',
        details: { ziina: ziinaSummary(ziina.data) },
      });
      continue;
    }

    const status = ziina.data.status;
    if (status === 'completed') {
      const existing = await getBookingByReference(ref);
      if (existing.data) {
        await deleteCheckoutHold(ref);
        continue;
      }
      await updateCheckoutHoldStatus(ref, 'paid_unconfirmed');
      await logPaymentEvent({
        source: 'health',
        event: 'health.paid_not_confirmed',
        level: 'error',
        bookingReference: ref,
        intentId,
        ziinaStatus: status,
        message: 'Ziina shows this payment as completed but it was never confirmed',
        details: { ziina: ziinaSummary(ziina.data) },
      });
      summary.paidNotConfirmed += 1;
      if (await alreadyAlerted('alert.paid_not_confirmed', { bookingReference: ref })) continue;
      const events = await recentEventsFor({ bookingReference: ref, intentId });
      const sent = await sendAlert({
        alertEvent: 'alert.paid_not_confirmed',
        subject: `[ACTION REQUIRED: Payment received, no booking] ${ref}`,
        bookingReference: ref,
        intentId,
        details: { ziina_status: status },
        html: buildAlertHtml({
          title: 'Payment received but the booking was never confirmed',
          summary: `Ziina shows ${ref} as paid, but neither the Ziina webhook nor the confirmation page confirmed it, so no booking record or Google Calendar event was created.`,
          nextSteps:
            'Check whether the slot is still free in your Google Calendar, add the booking by hand, and email the customer. Refund through Ziina if the slot cannot be honoured. The hold is kept with status paid_unconfirmed until you delete it.',
          bookingReference: ref,
          intentId,
          payload: hold.payload,
          ziina: ziinaSummary(ziina.data),
          events,
        }),
      });
      if (sent) summary.alertsSent += 1;
    } else if (status === 'failed' || status === 'canceled') {
      await updateCheckoutHoldStatus(ref, 'expired');
      summary.markedExpired += 1;
    } else {
      await updateCheckoutHoldStatus(ref, 'abandoned');
      summary.markedAbandoned += 1;
    }
  }
}

// 3. Completed payments that arrived with no checkout hold
async function checkCompletedWithoutHold(now, summary) {
  const events = await listPaymentEvents(
    new URLSearchParams({
      select: 'ziina_payment_intent_id,created_at',
      event: 'eq.webhook.completed_no_hold',
      created_at: `gt.${new Date(now - NO_HOLD_LOOKBACK_MS).toISOString()}`,
      order: 'created_at.asc',
      limit: '50',
    }).toString()
  );

  const seen = new Set();
  for (const e of events) {
    // Give the redirect page 5 minutes to confirm it first.
    if (now - new Date(e.created_at).getTime() < STUCK_AFTER_MS) continue;
    const intentId = e.ziina_payment_intent_id;
    if (!intentId || seen.has(intentId)) continue;
    seen.add(intentId);

    const payment = await getPaymentByIntentId(intentId);
    if (payment) continue;

    summary.paidNoHold += 1;
    if (await alreadyAlerted('alert.paid_no_hold', { intentId })) continue;
    const recent = await recentEventsFor({ intentId });
    const sent = await sendAlert({
      alertEvent: 'alert.paid_no_hold',
      subject: `[ACTION REQUIRED: Payment with no booking details] ${intentId}`,
      intentId,
      details: { first_seen: e.created_at },
      html: buildAlertHtml({
        title: 'Payment received with no booking details',
        summary:
          'Ziina reported a completed payment, but the website had no checkout hold for it and no payment record has been created since. The booking details were probably never saved at checkout.',
        nextSteps:
          'Find the payment in the Ziina dashboard to identify the customer, then contact them to arrange the booking or refund it.',
        intentId,
        events: recent,
      }),
    });
    if (sent) summary.alertsSent += 1;
  }
}

// 4. Clear out old abandoned and expired holds
async function cleanupHolds(now, summary) {
  const deleted = await deleteCheckoutHoldsWhere(
    new URLSearchParams({
      status: 'in.(abandoned,expired)',
      expires_at: `lt.${new Date(now - CLEANUP_AFTER_MS).toISOString()}`,
      select: 'booking_reference',
    }).toString()
  );
  summary.holdsDeleted = deleted.length;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isSupabaseConfigured()) {
    return res.status(500).json({ error: 'Supabase is not configured' });
  }

  const now = Date.now();
  const summary = {
    stuckProcessing: 0,
    expiredPendingChecked: 0,
    paidNotConfirmed: 0,
    paidNoHold: 0,
    markedAbandoned: 0,
    markedExpired: 0,
    holdsDeleted: 0,
    alertsSent: 0,
  };
  const errors = [];

  for (const [name, step] of [
    ['stuckProcessing', checkStuckProcessing],
    ['expiredPending', checkExpiredPending],
    ['completedWithoutHold', checkCompletedWithoutHold],
    ['cleanup', cleanupHolds],
  ]) {
    try {
      await step(now, summary);
    } catch (err) {
      errors.push({ step: name, error: errorMessageOf(err) });
      await logPaymentEvent({
        source: 'health',
        event: 'health.step_failed',
        level: 'error',
        message: errorMessageOf(err),
        details: { step: name },
      });
    }
  }

  return res.status(errors.length ? 500 : 200).json({ ok: errors.length === 0, summary, errors });
};
