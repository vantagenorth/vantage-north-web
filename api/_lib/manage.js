// Rules and links for the client's self-service "Manage booking" page (/manage).
const { signBookingToken, verifyBookingToken } = require('./supabase');

const HOUR_MS = 60 * 60 * 1000;
// Terms 9.4: cancellations are allowed up to 24 hours before the inspection.
const CANCEL_CUTOFF_MS = 24 * HOUR_MS;
// Terms: rescheduling is free until the inspector is dispatched. Online, we stop
// 2 hours before the start; after that the client contacts us on WhatsApp.
const RESCHEDULE_CUTOFF_MS = 2 * HOUR_MS;
// Policy 2: a booking moved within 24 hours of its original start becomes
// non-refundable if it is cancelled later. We note that on the booking.
const LATE_RESCHEDULE_NOTE = 'Rescheduled within 24h of original start: non-refundable if cancelled.';

const ACTIVE_STATUSES = ['confirmed', 'needs_reschedule'];

function siteBaseUrl() {
  return (process.env.SITE_URL || 'https://vantagenorth.ae').replace(/\/+$/, '');
}

function manageBookingToken(bookingReference) {
  return signBookingToken({ m: bookingReference });
}

function manageBookingUrl(bookingReference) {
  return `${siteBaseUrl()}/manage?t=${encodeURIComponent(manageBookingToken(bookingReference))}`;
}

function referenceFromManageToken(token) {
  const data = verifyBookingToken(token);
  return data && typeof data.m === 'string' ? data.m : null;
}

function bookingAllowances(booking, nowMs = Date.now()) {
  const status = String(booking?.status || '').toLowerCase();
  const startMs = booking?.scheduled_start ? new Date(booking.scheduled_start).getTime() : NaN;
  const active = ACTIVE_STATUSES.includes(status);
  const hasCal = Boolean(booking?.cal_booking_uid);
  const msToStart = Number.isFinite(startMs) ? startMs - nowMs : NaN;
  return {
    active,
    canReschedule: active && hasCal && Number.isFinite(msToStart) && msToStart > RESCHEDULE_CUTOFF_MS,
    canCancel: active && hasCal && Number.isFinite(msToStart) && msToStart >= CANCEL_CUTOFF_MS,
    lateRescheduled: String(booking?.notes || '').includes(LATE_RESCHEDULE_NOTE),
    withinCancelWindow: Number.isFinite(msToStart) && msToStart < CANCEL_CUTOFF_MS,
  };
}

module.exports = {
  CANCEL_CUTOFF_MS,
  RESCHEDULE_CUTOFF_MS,
  LATE_RESCHEDULE_NOTE,
  manageBookingToken,
  manageBookingUrl,
  referenceFromManageToken,
  bookingAllowances,
};
