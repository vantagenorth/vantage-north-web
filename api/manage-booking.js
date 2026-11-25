// Client self-service: look up, reschedule or cancel a booking from /manage.
// Access is by the signed link in the confirmation email (?t=...), or by the
// booking reference plus the email address it was booked with.
//
// Cancelling never refunds anything automatically. The booking is marked
// cancelled, the payment row is left as it is, and the team is emailed that a
// refund may be owed.
const { isSupabaseConfigured, supabaseFetch, updateBookingByReference } = require('./_lib/supabase');
const { getOpenSlots, rescheduleCalBooking, cancelCalBooking } = require('./_lib/cal');
const {
  LATE_RESCHEDULE_NOTE,
  CANCEL_CUTOFF_MS,
  referenceFromManageToken,
  manageBookingToken,
  bookingAllowances,
} = require('./_lib/manage');
const { sendResendEmail } = require('./_lib/confirm-core');
const { logPaymentEvent, errorMessageOf } = require('./_lib/payment-log');

const NOT_FOUND = "We couldn't find a booking with those details. Please check the reference and email, or WhatsApp us on +971 58 556 5311.";

function dubaiDate(iso) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date(iso));
}

function formatDubai(iso) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dubai',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadBooking(bookingReference) {
  const res = await supabaseFetch(
    `bookings?booking_reference=eq.${encodeURIComponent(bookingReference)}` +
      '&select=id,booking_reference,status,scheduled_start,scheduled_end,cal_booking_uid,cal_booking_id,cal_event_type_id,notes,' +
      'clients(name,email),units(unit_no),payments(status,amount_aed,is_test)&limit=1',
    { method: 'GET' }
  );
  return Array.isArray(res.data) ? res.data[0] || null : null;
}

// Returns the booking only if the caller proved they own it.
async function authorise(input) {
  let reference = null;
  if (input.t) {
    reference = referenceFromManageToken(String(input.t));
    if (!reference) return null;
    return loadBooking(reference);
  }
  reference = String(input.ref || '').trim().toUpperCase();
  const email = String(input.email || '').trim().toLowerCase();
  if (!reference || !email) return null;
  const booking = await loadBooking(reference);
  const bookedEmail = String(booking?.clients?.email || '').trim().toLowerCase();
  if (!booking || !bookedEmail || bookedEmail !== email) return null;
  return booking;
}

function durationMinutesOf(booking) {
  const start = new Date(booking.scheduled_start).getTime();
  const end = new Date(booking.scheduled_end).getTime();
  const mins = Math.round((end - start) / 60000);
  return Number.isFinite(mins) && mins > 0 ? mins : 180;
}

function publicView(booking) {
  const allow = bookingAllowances(booking);
  return {
    bookingReference: booking.booking_reference,
    status: booking.status,
    clientName: booking.clients?.name || null,
    unitNumber: booking.units?.unit_no || null,
    scheduledStart: booking.scheduled_start,
    scheduledEnd: booking.scheduled_end,
    scheduledLabel: booking.scheduled_start ? formatDubai(booking.scheduled_start) : null,
    durationMinutes: booking.scheduled_start && booking.scheduled_end ? durationMinutesOf(booking) : null,
    canReschedule: allow.canReschedule,
    canCancel: allow.canCancel,
    lateRescheduled: allow.lateRescheduled,
    // Lets the page keep working after the client typed ref + email once.
    token: manageBookingToken(booking.booking_reference),
  };
}

async function notifyTeam(subject, lines) {
  const to = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!to) return;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">${lines
    .map((l) => `<p style="margin:0 0 8px">${l}</p>`)
    .join('')}</div>`;
  try {
    await sendResendEmail({ to, subject, html });
  } catch (err) {
    console.warn('manage-booking team email failed:', err.message);
  }
}

async function handleReschedule(booking, body) {
  const allow = bookingAllowances(booking);
  if (!allow.canReschedule) {
    return {
      status: 409,
      json: { error: 'This booking can no longer be moved online. Please WhatsApp us on +971 58 556 5311 and we will help.' },
    };
  }
  const start = String(body.start || '');
  const startMs = new Date(start).getTime();
  if (!start || !Number.isFinite(startMs) || startMs <= Date.now()) {
    return { status: 400, json: { error: 'Please pick a new time.' } };
  }

  const oldStart = booking.scheduled_start;
  const oldUid = booking.cal_booking_uid;
  let calData;
  try {
    calData = await rescheduleCalBooking(oldUid, { start: new Date(startMs).toISOString(), reason: 'Rescheduled by client online' });
  } catch (err) {
    await logPaymentEvent({
      source: 'manage',
      event: 'manage.reschedule_failed',
      level: 'warn',
      bookingReference: booking.booking_reference,
      httpStatus: err.status || null,
      message: errorMessageOf(err),
      details: { cal_booking_uid: oldUid, requested_start: start },
    });
    return {
      status: 409,
      json: { error: 'That time is no longer available. Please pick another one.' },
    };
  }

  const newStart = calData?.start || new Date(startMs).toISOString();
  const newEnd = calData?.end || new Date(startMs + durationMinutesOf(booking) * 60000).toISOString();
  const lateMove = oldStart && new Date(oldStart).getTime() - Date.now() < CANCEL_CUTOFF_MS;
  const notes = lateMove && !String(booking.notes || '').includes(LATE_RESCHEDULE_NOTE)
    ? [booking.notes, LATE_RESCHEDULE_NOTE].filter(Boolean).join('\n')
    : booking.notes;

  const patch = {
    status: 'confirmed',
    scheduled_start: newStart,
    scheduled_end: newEnd,
    scheduled_date: dubaiDate(newStart),
    ...(calData?.uid ? { cal_booking_uid: calData.uid } : {}),
    ...(calData?.id ? { cal_booking_id: calData.id } : {}),
    ...(notes !== booking.notes ? { notes } : {}),
  };
  const updated = await updateBookingByReference(booking.booking_reference, patch);

  await logPaymentEvent({
    source: 'manage',
    event: 'manage.rescheduled',
    bookingReference: booking.booking_reference,
    details: {
      old_start: oldStart,
      new_start: newStart,
      old_cal_booking_uid: oldUid,
      cal_booking_uid: calData?.uid || null,
      late_move: Boolean(lateMove),
    },
  });
  await notifyTeam(`Booking moved: ${booking.booking_reference}`, [
    `<strong>${escapeHtml(booking.clients?.name || 'A client')}</strong> moved booking <strong>${escapeHtml(booking.booking_reference)}</strong> online.`,
    `From: ${escapeHtml(formatDubai(oldStart))}<br>To: <strong>${escapeHtml(formatDubai(newStart))}</strong> (Dubai)`,
    lateMove ? 'This was within 24 hours of the original time, so it is non-refundable if cancelled later.' : '',
  ].filter(Boolean));

  return { status: 200, json: { ok: true, booking: publicView(updated.data || { ...booking, ...patch }) } };
}

async function handleCancel(booking, body) {
  const allow = bookingAllowances(booking);
  if (!allow.canCancel) {
    return {
      status: 409,
      json: {
        error: allow.withinCancelWindow
          ? 'Cancellations are not possible within 24 hours of the inspection. You can still move it to another time.'
          : 'This booking can no longer be cancelled online. Please WhatsApp us on +971 58 556 5311.',
      },
    };
  }
  const reason = String(body.reason || '').trim().slice(0, 500) || 'Cancelled by client online';
  try {
    await cancelCalBooking(booking.cal_booking_uid, { reason });
  } catch (err) {
    await logPaymentEvent({
      source: 'manage',
      event: 'manage.cancel_failed',
      level: 'error',
      bookingReference: booking.booking_reference,
      httpStatus: err.status || null,
      message: errorMessageOf(err),
      details: { cal_booking_uid: booking.cal_booking_uid },
    });
    return {
      status: 502,
      json: { error: 'We could not cancel this right now. Please try again, or WhatsApp us on +971 58 556 5311.' },
    };
  }

  // Payment rows are deliberately left untouched: refunds are handled by hand.
  const updated = await updateBookingByReference(booking.booking_reference, { status: 'cancelled' });
  const paid = (booking.payments || []).find((p) => String(p.status || '').toLowerCase() === 'paid');
  await logPaymentEvent({
    source: 'manage',
    event: 'manage.cancelled',
    bookingReference: booking.booking_reference,
    details: {
      cal_booking_uid: booking.cal_booking_uid,
      reason,
      refund_may_be_owed: Boolean(paid) && !allow.lateRescheduled,
      late_rescheduled: allow.lateRescheduled,
    },
  });
  await notifyTeam(`Booking cancelled: ${booking.booking_reference}${paid ? ' (refund may be owed)' : ''}`, [
    `<strong>${escapeHtml(booking.clients?.name || 'A client')}</strong> cancelled booking <strong>${escapeHtml(booking.booking_reference)}</strong> online.`,
    `It was for ${escapeHtml(formatDubai(booking.scheduled_start))} (Dubai).`,
    `Reason: ${escapeHtml(reason)}`,
    paid
      ? allow.lateRescheduled
        ? `Paid ${escapeHtml(paid.amount_aed)} AED. It was moved within 24 hours of its original time, so under the policy no refund is due. Nothing has been refunded.`
        : `Paid ${escapeHtml(paid.amount_aed)} AED. A full refund is due under the policy. Nothing has been refunded automatically: refund it in Ziina, then set the payment to Refunded in the app.`
      : 'No paid payment is on record for this booking.',
  ]);

  return { status: 200, json: { ok: true, booking: publicView(updated.data || { ...booking, status: 'cancelled' }) } };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isSupabaseConfigured()) {
    return res.status(503).json({ error: 'Booking service is not available right now.' });
  }

  try {
    if (req.method === 'GET') {
      const booking = await authorise(req.query || {});
      if (!booking) return res.status(404).json({ error: NOT_FOUND });
      const view = publicView(booking);
      if (String(req.query.slots || '') === '1') {
        if (!view.canReschedule || !booking.cal_event_type_id) {
          return res.status(409).json({ error: 'This booking can no longer be moved online.' });
        }
        const slots = await getOpenSlots({
          eventTypeId: booking.cal_event_type_id,
          durationMinutes: durationMinutesOf(booking),
        });
        return res.status(200).json({ timeZone: 'Asia/Dubai', slots });
      }
      return res.status(200).json({ booking: view });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const booking = await authorise(body);
      if (!booking) return res.status(404).json({ error: NOT_FOUND });
      let result;
      if (body.action === 'reschedule') result = await handleReschedule(booking, body);
      else if (body.action === 'cancel') result = await handleCancel(booking, body);
      else result = { status: 400, json: { error: 'Unknown action' } };
      return res.status(result.status).json(result.json);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error in /api/manage-booking:', err);
    await logPaymentEvent({
      source: 'manage',
      event: 'manage.exception',
      level: 'error',
      message: errorMessageOf(err),
    });
    return res.status(500).json({ error: 'Something went wrong. Please try again, or WhatsApp us on +971 58 556 5311.' });
  }
};
