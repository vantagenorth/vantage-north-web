// Shared rules and helpers for the self-service reschedule and cancel pages.
// Policy source: /terms, "Booking, Rescheduling & Cancellation Policy".
const crypto = require('crypto');
const { getSigningSecret } = require('./supabase');

const HOUR_MS = 60 * 60 * 1000;
const CANCEL_NOTICE_MS = 24 * HOUR_MS; // s.3: no cancellations inside 24 hours
const LATE_RESCHEDULE_MS = 24 * HOUR_MS; // s.2: rescheduled inside 24h => non-refundable later
// s.2 allows rescheduling until the inspector is dispatched. The page stops self-service
// this long before the start and points people to WhatsApp instead.
function rescheduleCutoffMs() {
  const mins = Number(process.env.MANAGE_RESCHEDULE_CUTOFF_MINUTES);
  return (Number.isFinite(mins) && mins >= 0 ? mins : 120) * 60 * 1000;
}

const ACTIVE_STATUSES = ['confirmed', 'needs_reschedule'];
const WHATSAPP_URL = 'https://wa.me/971585565311';

function normalizeRef(ref) {
  return String(ref || '').trim().toUpperCase();
}

function isValidRef(ref) {
  return /^VN-[A-Z0-9-]{4,40}$/.test(normalizeRef(ref));
}

// Short HMAC of the reference. It goes in the email/confirmation links as ?t=, so
// knowing (or guessing) a booking reference is not enough to change a booking.
function manageToken(ref) {
  return crypto
    .createHmac('sha256', getSigningSecret())
    .update(`manage:${normalizeRef(ref)}`)
    .digest('base64url')
    .slice(0, 22);
}

function verifyManageToken(ref, token) {
  if (!token || typeof token !== 'string') return false;
  const expected = Buffer.from(manageToken(ref));
  const given = Buffer.from(token.trim());
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Set MANAGE_RESCHEDULE_BASE_URL=https://reschedule.vantagenorth.ae and
// MANAGE_CANCEL_BASE_URL=https://cancel.vantagenorth.ae in Vercel once their DNS
// records are live. Until then links use the same pages on the main domain.
function buildManageLinks(ref) {
  const clean = normalizeRef(ref);
  const t = manageToken(clean);
  const rescheduleBase = (process.env.MANAGE_RESCHEDULE_BASE_URL || 'https://vantagenorth.ae/reschedule').replace(/\/+$/, '');
  const cancelBase = (process.env.MANAGE_CANCEL_BASE_URL || 'https://vantagenorth.ae/cancel').replace(/\/+$/, '');
  return {
    rescheduleUrl: `${rescheduleBase}/${encodeURIComponent(clean)}?t=${t}`,
    cancelUrl: `${cancelBase}/${encodeURIComponent(clean)}?t=${t}`,
  };
}

function paidPayment(booking) {
  const payments = Array.isArray(booking?.payments) ? booking.payments : [];
  return (
    payments.find((p) => p.status === 'paid') ||
    payments.find((p) => p.status === 'refund_pending' || p.status === 'refunded') ||
    payments[0] ||
    null
  );
}

function amountPaidAed(booking) {
  const p = paidPayment(booking);
  const n = Number(p?.amount_aed ?? p?.total);
  return Number.isFinite(n) ? n : 0;
}

/**
 * What the customer may do right now, and why not when they can't.
 */
function evaluatePolicy(booking, nowMs = Date.now()) {
  const startMs = booking?.scheduled_start ? new Date(booking.scheduled_start).getTime() : null;
  const msToStart = startMs === null ? null : startMs - nowMs;
  const active = ACTIVE_STATUSES.includes(booking?.status);
  const payment = paidPayment(booking);
  const paid = payment?.status === 'paid';

  let canReschedule = active;
  let rescheduleBlockedReason = null;
  if (!active) {
    canReschedule = false;
    rescheduleBlockedReason = booking?.status === 'cancelled' ? 'cancelled' : 'inactive';
  } else if (msToStart !== null && msToStart <= rescheduleCutoffMs()) {
    canReschedule = false;
    rescheduleBlockedReason = msToStart <= 0 ? 'started' : 'too_close';
  } else if (!booking?.scheduled_start) {
    canReschedule = false;
    rescheduleBlockedReason = 'inactive';
  }

  let canCancel = active;
  let cancelBlockedReason = null;
  if (!active) {
    canCancel = false;
    cancelBlockedReason = booking?.status === 'cancelled' ? 'cancelled' : 'inactive';
  } else if (msToStart !== null && msToStart < CANCEL_NOTICE_MS) {
    canCancel = false;
    cancelBlockedReason = msToStart <= 0 ? 'started' : 'within_24h';
  }

  const nonRefundable = Boolean(booking?.non_refundable);
  const refundAmountAed = canCancel && paid && !nonRefundable ? amountPaidAed(booking) : 0;

  return {
    canReschedule,
    rescheduleBlockedReason,
    canCancel,
    cancelBlockedReason,
    nonRefundable,
    refundAmountAed,
    msToStart,
  };
}

// A reschedule made inside 24 hours of the start it moves away from makes the booking
// non-refundable if it is cancelled later (Policy s.2, "Subsequent Cancellation Rule").
function isLateReschedule(previousStartIso, nowMs = Date.now()) {
  if (!previousStartIso) return false;
  return new Date(previousStartIso).getTime() - nowMs < LATE_RESCHEDULE_MS;
}

function parsePackageLabel(notes) {
  const m = String(notes || '').match(/Package:\s*([^|(]+?)\s*\(/);
  return m ? m[1].trim() : 'Property Inspection';
}

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return '';
  const shown = user.length <= 2 ? user[0] : `${user.slice(0, 2)}`;
  return `${shown}${'•'.repeat(Math.max(1, Math.min(6, user.length - shown.length)))}@${domain}`;
}

// The subset of a booking the pages may show. No full email, phone, or payment ids.
function publicBookingView(booking, nowMs = Date.now()) {
  const policy = evaluatePolicy(booking, nowMs);
  const unit = booking?.units || null;
  const project = unit?.projects || null;
  const startMs = booking?.scheduled_start ? new Date(booking.scheduled_start).getTime() : null;
  const endMs = booking?.scheduled_end ? new Date(booking.scheduled_end).getTime() : null;
  const payment = paidPayment(booking);
  return {
    reference: booking.booking_reference,
    status: booking.status,
    firstName: String(booking?.clients?.name || '').split(/\s+/)[0] || '',
    emailHint: maskEmail(booking?.clients?.email),
    scheduledStart: booking.scheduled_start,
    scheduledEnd: booking.scheduled_end,
    durationMinutes: startMs && endMs ? Math.round((endMs - startMs) / 60000) : null,
    packageLabel: parsePackageLabel(booking.notes),
    propertyType: unit?.type || null,
    unitNumber: unit?.unit_no || null,
    projectName: project?.name || null,
    amountPaidAed: amountPaidAed(booking),
    isTest: Boolean(payment?.is_test) || /^VN-TEST-/.test(booking.booking_reference || ''),
    rescheduleCount: booking.reschedule_count || 0,
    cancelledAt: booking.cancelled_at || null,
    refundStatus: booking.refund_status || null,
    refundAmountAed: booking.refund_amount_aed != null ? Number(booking.refund_amount_aed) : null,
    ...policy,
    whatsappUrl: WHATSAPP_URL,
  };
}

function formatDubaiTime(iso) {
  try {
    return new Intl.DateTimeFormat('en-AE', {
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
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function emailShell(inner) {
  return `
  <div style="font-family: 'Helvetica Neue', Arial, sans-serif; background:#FAFAFA; padding:32px 16px; color:#000000;">
    <div style="max-width:600px; margin:0 auto; background:#FFFFFF; border:1px solid #E5E5E5; border-radius:12px; padding:32px;">
      <img src="https://vantagenorth.ae/logo/vantage_north_logo_email_footer.png" alt="Vantage North" style="height:28px; width:auto; display:block; margin-bottom:20px;">
      ${inner}
      <p style="font-size:13px; color:#646464; margin:20px 0 16px;">
        Questions? Reply to this email or WhatsApp us on <strong>+971 58 556 5311</strong>.
      </p>
      <p style="font-size:11px; color:#888888; margin:0;">
        Issued by <strong>Al Marsad Property Observer L.L.C S.O.C</strong> trading as <strong>Vantage North</strong> · Dubai, UAE
      </p>
    </div>
  </div>`;
}

function detailRows(rows) {
  return `
      <div style="background:#FAFAFA; border:1px solid #E5E5E5; border-radius:8px; padding:20px; margin-bottom:20px;">
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          ${rows
            .filter(Boolean)
            .map(
              ([label, value, strong]) =>
                `<tr><td style="padding:6px 0; color:#646464;">${escapeHtml(label)}</td><td style="padding:6px 0; text-align:right;${strong ? ' font-weight:600;' : ''}">${escapeHtml(value)}</td></tr>`
            )
            .join('')}
        </table>
      </div>`;
}

// Reschedule / Cancel buttons used in every customer email. Cancel is left out
// inside the 24-hour window, where only rescheduling is allowed.
function manageButtonsHtml(ref, scheduledStartIso, { showCancel = true } = {}) {
  const links = buildManageLinks(ref);
  const canCancel = scheduledStartIso
    ? new Date(scheduledStartIso).getTime() - Date.now() >= CANCEL_NOTICE_MS
    : true;
  return `
      <div style="margin:24px 0 0; padding-top:20px; border-top:1px solid #E5E5E5;">
        <a href="${links.rescheduleUrl}" style="display:inline-block; background:#000000; color:#FFFFFF; text-decoration:none; font-size:13px; font-weight:600; padding:11px 20px; border-radius:8px; margin-right:10px;">Reschedule</a>
        ${showCancel && canCancel ? `<a href="${links.cancelUrl}" style="display:inline-block; background:#FFFFFF; color:#2B2B2B; text-decoration:none; font-size:13px; font-weight:600; padding:10px 20px; border-radius:8px; border:1px solid #D4D4D4;">Cancel</a>` : ''}
        <p style="font-size:11px; color:#646464; margin:12px 0 0;">Cancellations are not permitted less than 24 hours prior to inspection — only rescheduling. <a href="https://vantagenorth.ae/terms#booking" style="color:#646464;">Policy</a></p>
      </div>`;
}

function rescheduleEmailHtml({ booking, previousStart, newStart, nonRefundable }) {
  const name = String(booking?.clients?.name || '').split(/\s+/)[0] || 'there';
  return emailShell(`
      <p style="font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#646464; margin:0 0 8px;">Vantage North — Booking Rescheduled</p>
      <h1 style="font-size:24px; margin:0 0 16px; font-weight:600;">Your inspection has a new time</h1>
      <p style="font-size:15px; line-height:1.6; color:#2B2B2B; margin:0 0 20px;">Hi ${escapeHtml(name)}, your inspection has been moved. Nothing else about your booking has changed.</p>
      ${detailRows([
        ['Booking Reference', booking.booking_reference, true],
        ['New Date & Time', `${formatDubaiTime(newStart)} (Dubai)`, true],
        previousStart ? ['Previous Time', `${formatDubaiTime(previousStart)} (Dubai)`] : null,
      ])}
      ${nonRefundable ? `<p style="font-size:13px; line-height:1.6; color:#92400E; background:#FEF3C7; border:1px solid #F59E0B; border-radius:8px; padding:12px 14px; margin:0 0 16px;">Because this change was made within 24 hours of your previous appointment, this booking is now non-refundable if it is cancelled later. You can still reschedule.</p>` : ''}
      <p style="font-size:13px; line-height:1.6; color:#646464; margin:0;">Please make sure DEWA (electricity &amp; water) and site access are arranged for the new time.</p>
      ${manageButtonsHtml(booking.booking_reference, newStart)}`);
}

function cancelEmailHtml({ booking, refundAmountAed, refundStatus }) {
  const name = String(booking?.clients?.name || '').split(/\s+/)[0] || 'there';
  let refundLine;
  if (refundAmountAed > 0 && refundStatus === 'refunded') {
    refundLine = `A full refund of <strong>${refundAmountAed.toLocaleString()} AED</strong> has been issued to your original payment method. It usually reaches you within 7 to 14 business days, depending on your bank.`;
  } else if (refundAmountAed > 0) {
    refundLine = `A full refund of <strong>${refundAmountAed.toLocaleString()} AED</strong> will be made to your original payment method. It usually reaches you within 7 to 14 business days, depending on your bank.`;
  } else if (!booking?.non_refundable) {
    refundLine = 'Nothing was paid for this booking, so there is nothing to refund.';
  } else {
    refundLine = 'This booking was not eligible for a refund under our Booking, Rescheduling &amp; Cancellation Policy.';
  }
  return emailShell(`
      <p style="font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#646464; margin:0 0 8px;">Vantage North — Booking Cancelled</p>
      <h1 style="font-size:24px; margin:0 0 16px; font-weight:600;">Your inspection has been cancelled</h1>
      <p style="font-size:15px; line-height:1.6; color:#2B2B2B; margin:0 0 20px;">Hi ${escapeHtml(name)}, we've cancelled your inspection as requested.</p>
      ${detailRows([
        ['Booking Reference', booking.booking_reference, true],
        ['Cancelled Appointment', `${formatDubaiTime(booking.scheduled_start)} (Dubai)`],
        ['Refund', refundAmountAed > 0 ? `${refundAmountAed.toLocaleString()} AED` : 'None', true],
      ])}
      <p style="font-size:14px; line-height:1.6; color:#2B2B2B; margin:0 0 16px;">${refundLine}</p>
      <p style="font-size:13px; line-height:1.6; color:#646464; margin:0;">Need an inspection after all? You can book again any time at <a href="https://vantagenorth.ae/book" style="color:#000000;">vantagenorth.ae/book</a>.</p>`);
}

function adminNoticeHtml({ title, lines }) {
  return emailShell(`
      <p style="font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#646464; margin:0 0 8px;">Vantage North — Booking Update</p>
      <h1 style="font-size:20px; margin:0 0 16px; font-weight:600;">${escapeHtml(title)}</h1>
      ${detailRows(lines)}`);
}

module.exports = {
  CANCEL_NOTICE_MS,
  ACTIVE_STATUSES,
  normalizeRef,
  isValidRef,
  manageToken,
  verifyManageToken,
  buildManageLinks,
  evaluatePolicy,
  isLateReschedule,
  publicBookingView,
  paidPayment,
  amountPaidAed,
  formatDubaiTime,
  manageButtonsHtml,
  rescheduleEmailHtml,
  cancelEmailHtml,
  adminNoticeHtml,
};
