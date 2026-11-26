// Booking calendar housekeeping. One function (Vercel Hobby has a 12-function limit):
//
//   /google-calendar/connect     Andy signs in to Google so bookings can use his calendar.
//   /google-calendar/callback    Google sends him back here; the sign-in is saved.
//   /api/calendar?action=status  { configured, connected }
//   /api/calendar (daily cron)   Checks the Google sign-in still works and emails
//                                ADMIN_NOTIFICATION_EMAIL if not.
//
// Open times (including the "look busy" blocks) are worked out live in
// api/_lib/availability.js.

const crypto = require('crypto');
const { logPaymentEvent, errorMessageOf } = require('./_lib/payment-log');
const google = require('./_lib/google-calendar');
const { getGoogleCalendarAuth } = require('./_lib/supabase');
const { getSiteUrl } = require('./_lib/config');

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = String(req.headers.authorization || '');
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function page(res, status, title, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="font-family:Helvetica,Arial,sans-serif;background:#FAFAFA;color:#000;padding:48px 16px;">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E5E5E5;border-radius:12px;padding:28px;">
<h1 style="font-size:20px;margin:0 0 12px;">${title}</h1><p style="font-size:15px;line-height:1.6;color:#2B2B2B;margin:0;">${body}</p></div></body></html>`);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function handleConnect(req, res) {
  if (!google.isGoogleConfigured()) {
    return page(res, 500, 'Google Calendar is not set up yet', 'Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALENDAR_ID in Vercel, redeploy, then open this page again.');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', google.buildConnectUrl(getSiteUrl(req)));
  return res.status(302).end();
}

async function handleCallback(req, res) {
  const q = req.query || {};
  if (q.error) {
    return page(res, 400, 'Google Calendar was not connected', `Google said: ${escapeHtml(q.error)}. You can <a href="/google-calendar/connect">try again</a>.`);
  }
  if (!google.verifyState(q.state)) {
    return page(res, 400, 'That link has expired', 'Please <a href="/google-calendar/connect">start again</a>.');
  }
  try {
    const { email } = await google.completeConnect({ code: String(q.code || ''), siteUrl: getSiteUrl(req) });
    const now = new Date();
    await google.listBusy(now.toISOString(), new Date(now.getTime() + 86400000).toISOString());
    await logPaymentEvent({ source: 'calendar', event: 'calendar.connected', details: { account: email } });
    return page(res, 200, 'Google Calendar connected', `Bookings will now use ${escapeHtml(email)}. You can close this page.`);
  } catch (err) {
    await logPaymentEvent({ source: 'calendar', event: 'calendar.connect_failed', level: 'error', message: errorMessageOf(err) });
    return page(res, 400, 'Google Calendar was not connected', `${escapeHtml(errorMessageOf(err))} <a href="/google-calendar/connect">Try again</a>.`);
  }
}

async function handleStatus(res) {
  res.setHeader('Cache-Control', 'no-store');
  let connected = false;
  try {
    connected = Boolean((await getGoogleCalendarAuth())?.refresh_token);
  } catch {
    connected = false;
  }
  return res.status(200).json({ configured: google.isGoogleConfigured(), connected, live: true });
}

// Daily: make sure the Google sign-in still works, so the booking page never goes blank unnoticed.
async function googleHealthCheck(res) {
  try {
    const now = new Date();
    await google.listBusy(now.toISOString(), new Date(now.getTime() + 86400000).toISOString());
    return res.status(200).json({ ok: true });
  } catch (err) {
    const message = errorMessageOf(err);
    await logPaymentEvent({ source: 'calendar', event: 'calendar.health_failed', level: 'error', message });
    const admin = process.env.ADMIN_NOTIFICATION_EMAIL;
    if (admin) {
      // Required lazily: confirm-core pulls in a lot that the cron does not otherwise need.
      const { sendResendEmail } = require('./_lib/confirm-core');
      await sendResendEmail({
        to: admin,
        subject: '[ACTION REQUIRED] Booking calendar cannot reach Google Calendar',
        html: `<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">The booking page cannot read your Google Calendar, so clients cannot see open times.</p>
<p style="font-family:Arial,sans-serif;font-size:14px;">Error: ${escapeHtml(message)}</p>
<p style="font-family:Arial,sans-serif;font-size:14px;">Fix: open <a href="https://vantagenorth.ae/google-calendar/connect">vantagenorth.ae/google-calendar/connect</a> and sign in as ${escapeHtml(google.calendarId())}.</p>`,
      }).catch(() => null);
    }
    return res.status(500).json({ ok: false, error: message });
  }
}

async function handler(req, res) {
  const action = String((req.query || {}).action || '').toLowerCase();
  if (action === 'connect') return handleConnect(req, res);
  if (action === 'callback') return handleCallback(req, res);
  if (action === 'status') return handleStatus(res);

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return googleHealthCheck(res);
}

module.exports = handler;
