// Self-service reschedule and cancel, used by reschedule.html and cancel.html
// (served at reschedule.vantagenorth.ae/{ref} and cancel.vantagenorth.ae/{ref}).
//
//   GET  /api/manage-booking?ref=VN-…&t=…            booking summary + what is allowed
//   GET  /api/manage-booking?action=slots&ref=…&t=…  open times to move to
//   POST /api/manage-booking { action: 'reschedule', ref, t, start }
//   POST /api/manage-booking { action: 'cancel', ref, t, reason, acknowledgeNoRefund }
//
// Every call needs either the link token (t) or the email address on the booking.
// One function for all of it keeps the project under the Vercel Hobby function limit.
const crypto = require('crypto');
const {
  isSupabaseConfigured,
  getBookingForManage,
  claimBookingStatus,
  updateBookingByReference,
  updatePaymentByIntentId,
  supabaseFetch,
  isOverlapError,
} = require('./_lib/supabase');
const { fetchSlots } = require('./_lib/availability');
const { createBookingEvent, moveBookingEvent, deleteBookingEvent } = require('./_lib/google-calendar');
const { sendResendEmail } = require('./_lib/confirm-core');
const { logPaymentEvent, errorMessageOf } = require('./_lib/payment-log');
const {
  ACTIVE_STATUSES,
  normalizeRef,
  isValidRef,
  manageToken,
  verifyManageToken,
  evaluatePolicy,
  isLateReschedule,
  publicBookingView,
  paidPayment,
  formatDubaiTime,
  rescheduleEmailHtml,
  cancelEmailHtml,
  adminNoticeHtml,
} = require('./_lib/manage');

function dubaiDate(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function durationMinutesOf(booking) {
  const s = booking.scheduled_start ? new Date(booking.scheduled_start).getTime() : null;
  const e = booking.scheduled_end ? new Date(booking.scheduled_end).getTime() : null;
  if (s && e && e > s) return Math.round((e - s) / 60000);
  return 120;
}

// Ziina refund ids must be client-generated UUIDs. Deriving it from the payment intent
// means a retried request reuses the same id instead of creating a second refund.
function refundIdFor(intentId) {
  const h = crypto.createHash('sha256').update(`vn-refund:${intentId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function slotsFor(booking, durationMinutes) {
  return fetchSlots({ durationMinutes, excludeRef: booking.booking_reference });
}

function readParams(req) {
  const q = req.query || {};
  let body = {};
  if (req.method === 'POST') {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  }
  return { ...q, ...body };
}

async function loadAuthorized(params) {
  const ref = normalizeRef(params.ref);
  if (!isValidRef(ref)) return { error: 'That booking reference does not look right.', status: 400 };
  const booking = await getBookingForManage(ref);
  const tokenOk = verifyManageToken(ref, params.t);
  const email = String(params.email || '').trim().toLowerCase();
  const emailOk = Boolean(
    booking && email && String(booking?.clients?.email || '').trim().toLowerCase() === email
  );
  if (!tokenOk && !emailOk) {
    if (email) {
      await logPaymentEvent({ source: 'manage', event: 'manage.auth_failed', level: 'warn', bookingReference: ref });
      return { error: 'That email address does not match this booking.', status: 403, needsEmail: true };
    }
    return { error: 'Please confirm the email address you booked with.', status: 401, needsEmail: true };
  }
  if (!booking) return { error: 'We could not find that booking.', status: 404 };
  return { ref, booking };
}

async function sendCustomerAndAdmin({ booking, subject, html, adminSubject, adminHtml }) {
  const to = booking?.clients?.email;
  const customer = await sendResendEmail({ to, subject, html });
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (adminEmail) {
    await sendResendEmail({ to: adminEmail, subject: adminSubject, html: adminHtml || html }).catch(() => null);
  }
  return customer;
}

// ---------- GET: summary ----------
async function handleLookup(res, auth) {
  return res.status(200).json({
    booking: publicBookingView(auth.booking),
    t: manageToken(auth.ref),
  });
}

// ---------- GET: slots ----------
async function handleSlots(res, auth) {
  const { booking } = auth;
  const policy = evaluatePolicy(booking);
  if (!policy.canReschedule) {
    return res.status(409).json({ error: 'This booking can no longer be rescheduled online.', booking: publicBookingView(booking) });
  }
  const durationMinutes = durationMinutesOf(booking);
  const result = await slotsFor(booking, durationMinutes);
  if (!result.ok) {
    await logPaymentEvent({
      source: 'manage',
      event: 'manage.slots_failed',
      level: 'error',
      bookingReference: auth.ref,
      httpStatus: result.status,
      message: result.error,
    });
    return res.status(502).json({ error: 'We could not load available times. Please try again or WhatsApp us.' });
  }
  // Leave out the time they already have.
  const currentMs = booking.scheduled_start ? new Date(booking.scheduled_start).getTime() : null;
  const slots = {};
  for (const [day, list] of Object.entries(result.slots)) {
    const kept = list.filter((s) => new Date(s.start).getTime() !== currentMs);
    if (kept.length) slots[day] = kept;
  }
  return res.status(200).json({ durationMinutes, timeZone: 'Asia/Dubai', slots });
}

// After a reschedule is saved: email the client and Andy, and log it.
async function finishReschedule(res, { ref, booking, merged, previousStart, startIso, late, calendarNote, logDetails }) {
  const emailResult = await sendCustomerAndAdmin({
    booking: merged,
    subject: `Vantage North Booking Rescheduled — ${ref}`,
    html: rescheduleEmailHtml({ booking: merged, previousStart, newStart: startIso, nonRefundable: late && !booking.non_refundable }),
    adminSubject: `${calendarNote ? '[ACTION REQUIRED: Update Google Calendar] ' : '[Rescheduled] '}${ref} — now ${formatDubaiTime(startIso)}${late ? ' (late, now non-refundable)' : ''}`,
    adminHtml: adminNoticeHtml({
      title: 'Client rescheduled their inspection',
      lines: [
        ['Booking Reference', ref, true],
        ['Client', `${booking.clients?.name || ''} (${booking.clients?.email || ''})`],
        ['Previous Time', previousStart ? `${formatDubaiTime(previousStart)} (Dubai)` : 'None'],
        ['New Time', `${formatDubaiTime(startIso)} (Dubai)`, true],
        ['Inside 24 hours', late ? 'Yes, booking is now non-refundable' : 'No'],
        calendarNote ? ['Google Calendar', calendarNote, true] : null,
      ],
    }),
  });
  await logPaymentEvent({
    source: 'manage',
    event: 'manage.rescheduled',
    bookingReference: ref,
    details: { previous_start: previousStart, new_start: startIso, late_reschedule: late, email_sent: Boolean(emailResult?.sent), ...logDetails },
  });
  return res.status(200).json({ rescheduled: true, booking: publicBookingView(merged), emailSent: Boolean(emailResult?.sent) });
}

// Supabase is saved first (its no-overlap rule is the final say on
// clashes), then the Google Calendar event is moved, or added if there was none.
async function moveBooking(res, auth, { newStartIso, durationMinutes, previousStart }) {
  const { ref, booking } = auth;
  const endIso = new Date(new Date(newStartIso).getTime() + durationMinutes * 60000).toISOString();
  const late = isLateReschedule(previousStart);
  const patch = {
    status: 'confirmed',
    scheduled_date: dubaiDate(newStartIso),
    scheduled_start: newStartIso,
    scheduled_end: endIso,
    original_scheduled_start: booking.original_scheduled_start || previousStart || null,
    reschedule_count: (booking.reschedule_count || 0) + 1,
    last_rescheduled_at: new Date().toISOString(),
    last_rescheduled_by: 'customer',
    non_refundable: Boolean(booking.non_refundable) || late,
  };
  let updated;
  try {
    updated = (await updateBookingByReference(ref, patch)).data;
  } catch (err) {
    if (isOverlapError(err)) {
      return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another.', slotTaken: true });
    }
    await logPaymentEvent({ source: 'manage', event: 'manage.reschedule_db_failed', level: 'error', bookingReference: ref, message: errorMessageOf(err) });
    return res.status(502).json({ error: 'We could not move your booking. Please try again or WhatsApp us.' });
  }

  let googleEventId = booking.google_event_id || null;
  let calendarNote = null;
  try {
    if (googleEventId) {
      await moveBookingEvent(googleEventId, { start: newStartIso, end: endIso });
    } else {
      googleEventId = await createBookingEvent({
        ref,
        start: newStartIso,
        end: endIso,
        title: `Inspection ${ref}`,
        clientName: booking.clients?.name,
        clientEmail: booking.clients?.email,
        clientPhone: booking.clients?.phone,
      });
      await updateBookingByReference(ref, { google_event_id: googleEventId }).catch(() => null);
    }
  } catch (err) {
    calendarNote = `Not updated automatically (${errorMessageOf(err)}). Please move it by hand.`;
    await logPaymentEvent({ source: 'calendar', event: 'calendar.event_move_failed', level: 'error', bookingReference: ref, message: errorMessageOf(err) });
  }

  const merged = { ...booking, ...(updated || patch), google_event_id: googleEventId };
  return finishReschedule(res, {
    ref,
    booking,
    merged,
    previousStart,
    startIso: newStartIso,
    late,
    calendarNote,
    logDetails: { google_event_id: googleEventId },
  });
}

// ---------- POST: reschedule ----------
async function handleReschedule(res, auth, params) {
  const { ref, booking } = auth;
  const policy = evaluatePolicy(booking);
  if (!policy.canReschedule) {
    return res.status(409).json({ error: 'This booking can no longer be rescheduled online. Please WhatsApp us.', booking: publicBookingView(booking) });
  }
  const newStartMs = new Date(params.start).getTime();
  if (!params.start || !Number.isFinite(newStartMs)) {
    return res.status(400).json({ error: 'Please choose a new time.' });
  }
  if (booking.scheduled_start && newStartMs === new Date(booking.scheduled_start).getTime()) {
    return res.status(400).json({ error: 'That is your current time. Please choose a different one.' });
  }

  // Only allow a time that is open right now, from the same source /book uses.
  const durationMinutes = durationMinutesOf(booking);
  const avail = await slotsFor(booking, durationMinutes);
  const allSlots = Object.values(avail.slots || {}).flat();
  if (!avail.ok || !allSlots.some((s) => new Date(s.start).getTime() === newStartMs)) {
    return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another.', slotTaken: true });
  }

  const newStartIso = new Date(newStartMs).toISOString();
  const previousStart = booking.scheduled_start;
  return moveBooking(res, auth, { newStartIso, durationMinutes, previousStart });
}

// ---------- POST: cancel ----------
async function issueRefund({ ref, payment, amountAed }) {
  const intentId = payment?.ziina_payment_intent_id;
  if (process.env.ZIINA_AUTO_REFUND !== 'true') {
    return { refundStatus: 'manual_required', reason: 'Automatic refunds are turned off (ZIINA_AUTO_REFUND)' };
  }
  if (!intentId || !process.env.ZIINA_API_KEY) {
    return { refundStatus: 'manual_required', reason: 'No Ziina payment intent or API key' };
  }
  const amountFils = Number(payment.amount_fils) || Math.round(amountAed * 100);
  const refundId = refundIdFor(intentId);
  try {
    const zRes = await fetch('https://api-v2.ziina.com/api/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.ZIINA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: refundId,
        payment_intent_id: intentId,
        amount: amountFils,
        currency_code: payment.currency || 'AED',
        ...(payment.is_test ? { test: true } : {}),
      }),
    });
    const zJson = await zRes.json().catch(() => ({}));
    await logPaymentEvent({
      source: 'manage',
      event: zRes.ok && zJson?.status !== 'failed' ? 'ziina.refund_created' : 'ziina.refund_failed',
      level: zRes.ok && zJson?.status !== 'failed' ? 'info' : 'error',
      bookingReference: ref,
      intentId,
      httpStatus: zRes.status,
      ziinaStatus: zJson?.status || null,
      message: zJson?.error?.message || zJson?.message || null,
      details: { refund_id: zJson?.id || refundId, amount_fils: amountFils },
    });
    if (!zRes.ok || zJson?.status === 'failed') {
      return { refundStatus: 'manual_required', reason: zJson?.error?.message || zJson?.message || `Ziina returned ${zRes.status}`, refundId };
    }
    return { refundStatus: zJson?.status === 'completed' ? 'refunded' : 'processing', refundId: zJson?.id || refundId };
  } catch (err) {
    await logPaymentEvent({
      source: 'manage',
      event: 'ziina.refund_request_failed',
      level: 'error',
      bookingReference: ref,
      intentId,
      message: errorMessageOf(err),
    });
    return { refundStatus: 'manual_required', reason: errorMessageOf(err), refundId };
  }
}

async function handleCancel(res, auth, params) {
  const { ref, booking } = auth;
  const policy = evaluatePolicy(booking);
  if (!policy.canCancel) {
    const msg =
      policy.cancelBlockedReason === 'within_24h'
        ? 'Cancellations are not permitted within 24 hours of the inspection. You can still reschedule.'
        : 'This booking can no longer be cancelled online.';
    return res.status(409).json({ error: msg, booking: publicBookingView(booking) });
  }
  if (policy.nonRefundable && !params.acknowledgeNoRefund) {
    return res.status(400).json({ error: 'Please confirm you understand this booking is non-refundable.' });
  }
  const reason = String(params.reason || '').trim().slice(0, 500) || null;

  // Claim it first so a double click cannot cancel (or refund) twice.
  const claimed = await claimBookingStatus(ref, ACTIVE_STATUSES, {
    status: 'cancelling',
    cancelled_by: 'customer',
    cancellation_reason: reason,
  });
  if (!claimed) {
    return res.status(409).json({ error: 'This booking was just changed. Please refresh the page.' });
  }

  // Remove it from Google Calendar. A failure does not stop the cancellation; Andy is told.
  let calendarNote = null;
  if (booking.google_event_id) {
    try {
      await deleteBookingEvent(booking.google_event_id);
    } catch (err) {
      calendarNote = `Could not remove it automatically (${errorMessageOf(err)}). Please delete it by hand.`;
      await logPaymentEvent({ source: 'calendar', event: 'calendar.event_delete_failed', level: 'error', bookingReference: ref, message: errorMessageOf(err) });
    }
  }

  const payment = paidPayment(booking);
  const refundAmountAed = policy.refundAmountAed;
  let refund = { refundStatus: 'none' };
  if (refundAmountAed > 0) {
    refund = await issueRefund({ ref, payment, amountAed: refundAmountAed });
  }

  const nowIso = new Date().toISOString();
  const patch = {
    status: 'cancelled',
    cancelled_at: nowIso,
    cancelled_by: 'customer',
    cancellation_reason: reason,
    refund_status: refund.refundStatus,
    refund_amount_aed: refundAmountAed,
    ziina_refund_id: refund.refundId || null,
    refunded_at: refund.refundStatus === 'refunded' || refund.refundStatus === 'processing' ? nowIso : null,
  };
  let updated = null;
  try {
    updated = (await updateBookingByReference(ref, patch)).data;
    if (payment?.ziina_payment_intent_id && refundAmountAed > 0) {
      const paymentStatus = refund.refundStatus === 'manual_required' ? 'refund_pending' : 'refunded';
      await updatePaymentByIntentId(payment.ziina_payment_intent_id, { status: paymentStatus });
    }
    if (booking.report_id) {
      await supabaseFetch(`reports?id=eq.${encodeURIComponent(booking.report_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled' }),
      }).catch(() => null);
    }
  } catch (err) {
    await logPaymentEvent({
      source: 'manage',
      event: 'manage.cancel_db_failed',
      level: 'error',
      bookingReference: ref,
      message: errorMessageOf(err),
      details: { refund_status: refund.refundStatus },
    });
  }

  const merged = { ...booking, ...(updated || patch) };
  const manual = refund.refundStatus === 'manual_required';
  const emailResult = await sendCustomerAndAdmin({
    booking: merged,
    subject: `Vantage North Booking Cancelled — ${ref}`,
    html: cancelEmailHtml({ booking: merged, refundAmountAed, refundStatus: refund.refundStatus }),
    adminSubject: manual
      ? `[ACTION REQUIRED: Refund ${refundAmountAed} AED] ${ref} cancelled`
      : `[Cancelled] ${ref}${refundAmountAed > 0 ? ` — ${refundAmountAed} AED refunded` : ' — no refund'}`,
    adminHtml: adminNoticeHtml({
      title: manual ? 'Client cancelled: please refund in the Ziina dashboard' : 'Client cancelled their inspection',
      lines: [
        ['Booking Reference', ref, true],
        ['Client', `${booking.clients?.name || ''} (${booking.clients?.email || ''})`],
        ['Was Scheduled', booking.scheduled_start ? `${formatDubaiTime(booking.scheduled_start)} (Dubai)` : 'None'],
        ['Reason', reason || 'None given'],
        ['Refund Due', `${refundAmountAed} AED`, true],
        ['Refund Status', refund.refundStatus],
        manual ? ['Why Not Automatic', refund.reason || ''] : null,
        payment?.ziina_payment_intent_id ? ['Ziina Payment ID', payment.ziina_payment_intent_id] : null,
        calendarNote ? ['Google Calendar', calendarNote, true] : null,
      ],
    }),
  });

  await logPaymentEvent({
    source: 'manage',
    event: 'manage.cancelled',
    level: manual ? 'warn' : 'info',
    bookingReference: ref,
    intentId: payment?.ziina_payment_intent_id || null,
    message: manual ? `Refund of ${refundAmountAed} AED needs to be made by hand: ${refund.reason || ''}` : null,
    details: {
      refund_status: refund.refundStatus,
      refund_amount_aed: refundAmountAed,
      non_refundable: policy.nonRefundable,
      email_sent: Boolean(emailResult?.sent),
    },
  });

  return res.status(200).json({
    cancelled: true,
    refundAmountAed,
    refundStatus: refund.refundStatus,
    booking: publicBookingView(merged),
    emailSent: Boolean(emailResult?.sent),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isSupabaseConfigured()) {
    return res.status(500).json({ error: 'Booking service is not configured' });
  }
  let params;
  try {
    params = readParams(req);
  } catch {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    const auth = await loadAuthorized(params);
    if (auth.error) {
      return res.status(auth.status).json({ error: auth.error, needsEmail: Boolean(auth.needsEmail) });
    }
    const action = String(params.action || (req.method === 'GET' ? 'lookup' : '')).toLowerCase();
    if (req.method === 'GET' && action === 'lookup') return handleLookup(res, auth);
    if (req.method === 'GET' && action === 'slots') return handleSlots(res, auth);
    if (req.method === 'POST' && action === 'reschedule') return handleReschedule(res, auth, params);
    if (req.method === 'POST' && action === 'cancel') return handleCancel(res, auth, params);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Error in /api/manage-booking:', err);
    await logPaymentEvent({
      source: 'manage',
      event: 'manage.exception',
      level: 'error',
      bookingReference: normalizeRef(params?.ref) || null,
      message: errorMessageOf(err),
    });
    return res.status(500).json({ error: 'Something went wrong. Please try again or WhatsApp us.' });
  }
};

module.exports.refundIdFor = refundIdFor;
