// Google Calendar access for the booking calendar.
//
// Andy signs in once at https://vantagenorth.ae/google-calendar/connect (an "Internal"
// OAuth app in his Google Workspace, so the sign-in does not expire weekly). The
// refresh token is kept in Supabase (google_calendar_auth, service role only).
//
// Bookings are written to his calendar with no attendees and sendUpdates=none, so
// Google never emails the client. Resend stays the only sender.
//
// Vercel environment variables:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  OAuth client (Web application)
//   GOOGLE_CALENDAR_ID                      the calendar to use, e.g. andy@vantagenorth.ae.
//                                           Only this Google account can connect.
const crypto = require('crypto');
const { getGoogleCalendarAuth, saveGoogleCalendarAuth, getSigningSecret } = require('./supabase');

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
const API = 'https://www.googleapis.com/calendar/v3';
const TIME_ZONE = 'Asia/Dubai';

let cachedToken = null; // { token, expiresAt }

class GoogleCalendarError extends Error {
  constructor(message, { status = null, notConnected = false } = {}) {
    super(message);
    this.name = 'GoogleCalendarError';
    this.status = status;
    this.notConnected = notConnected;
  }
}

function calendarId() {
  return String(process.env.GOOGLE_CALENDAR_ID || '').trim();
}

function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && calendarId());
}

function redirectUri(siteUrl) {
  return `${siteUrl.replace(/\/+$/, '')}/google-calendar/callback`;
}

// ---------- sign-in ----------

function signState(nowMs = Date.now()) {
  const ts = String(nowMs);
  const sig = crypto.createHmac('sha256', getSigningSecret()).update(`gcal-state:${ts}`).digest('base64url').slice(0, 22);
  return `${ts}.${sig}`;
}

function verifyState(state, nowMs = Date.now()) {
  const [ts, sig] = String(state || '').split('.');
  if (!ts || !sig) return false;
  const expected = signState(Number(ts)).split('.')[1];
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return nowMs - Number(ts) < 15 * 60 * 1000;
}

function buildConnectUrl(siteUrl) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(siteUrl),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    login_hint: calendarId(),
    state: signState(),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload.email_verified === false ? null : String(payload.email || '').toLowerCase();
  } catch {
    return null;
  }
}

// Swaps the code from Google's redirect for tokens and saves the refresh token.
// Only the account named in GOOGLE_CALENDAR_ID is accepted.
async function completeConnect({ code, siteUrl }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(siteUrl),
      grant_type: 'authorization_code',
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GoogleCalendarError(`Google sign-in failed: ${json.error_description || json.error || res.status}`, { status: res.status });
  }
  const email = emailFromIdToken(json.id_token);
  if (!email || email !== calendarId().toLowerCase()) {
    throw new GoogleCalendarError(`Please sign in as ${calendarId()} (you signed in as ${email || 'an unknown account'}).`);
  }
  if (!json.refresh_token) {
    throw new GoogleCalendarError('Google did not return a long-lasting sign-in. Please try again.');
  }
  const granted = String(json.scope || '');
  if (!granted.includes('calendar.events')) {
    throw new GoogleCalendarError('Calendar access was not ticked on the Google screen. Please try again and allow it.');
  }
  await saveGoogleCalendarAuth({ accountEmail: email, refreshToken: json.refresh_token, scope: granted });
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3000) * 1000 };
  return { email };
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt - 60000 > Date.now()) return cachedToken.token;
  if (!isGoogleConfigured()) {
    throw new GoogleCalendarError('Google Calendar is not set up (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALENDAR_ID).', { notConnected: true });
  }
  const auth = await getGoogleCalendarAuth();
  if (!auth?.refresh_token) {
    throw new GoogleCalendarError('Google Calendar is not connected yet.', { notConnected: true });
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: auth.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new GoogleCalendarError(`Google Calendar sign-in stopped working (${json.error || res.status}). Reconnect it.`, {
      status: res.status,
      notConnected: json.error === 'invalid_grant',
    });
  }
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3000) * 1000 };
  return cachedToken.token;
}

async function gcal(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API}/calendars/${encodeURIComponent(calendarId())}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GoogleCalendarError(`Google Calendar ${method} failed (${res.status}): ${json?.error?.message || 'unknown error'}`, { status: res.status });
  }
  return json;
}

// ---------- reading busy times ----------

function isDeclinedBySelf(ev) {
  return (ev.attendees || []).some((a) => a.self && a.responseStatus === 'declined');
}

// Busy times on the calendar between two instants.
// - All-day events (holidays, days off) block the whole day, even when Google marks them "Free".
// - Timed events block their hours unless marked "Free" or declined.
// - Events this site created (private property vnRef) are skipped: Supabase is the record
//   for bookings, so a cancelled booking never keeps blocking through a leftover event.
// Returns { allDayDates: Set('YYYY-MM-DD'), intervals: [{ start, end }] (ms) }.
async function listBusy(startIso, endIso) {
  const allDayDates = new Set();
  const intervals = [];
  let pageToken = null;
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({
      timeMin: startIso,
      timeMax: endIso,
      singleEvents: 'true',
      maxResults: '2500',
      timeZone: TIME_ZONE,
      fields: 'nextPageToken,items(id,status,transparency,start,end,extendedProperties,attendees(self,responseStatus))',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const json = await gcal(`/events?${params.toString()}`);
    for (const ev of json.items || []) {
      if (ev.status === 'cancelled' || isDeclinedBySelf(ev)) continue;
      if (ev.extendedProperties?.private?.vnRef) continue;
      if (ev.start?.date) {
        // All-day: end.date is exclusive.
        let d = ev.start.date;
        const end = ev.end?.date || d;
        for (let i = 0; i < 400 && (d < end || i === 0); i += 1) {
          allDayDates.add(d);
          const next = new Date(`${d}T00:00:00Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          d = next.toISOString().slice(0, 10);
        }
        continue;
      }
      if (ev.transparency === 'transparent') continue;
      const s = new Date(ev.start?.dateTime).getTime();
      const e = new Date(ev.end?.dateTime).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) intervals.push({ start: s, end: e });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return { allDayDates, intervals };
}

// ---------- writing bookings ----------

function eventBody(booking) {
  const lines = [
    `Ref: ${booking.ref}`,
    booking.clientName ? `Client: ${booking.clientName}` : null,
    booking.clientEmail ? `Email: ${booking.clientEmail}` : null,
    booking.clientPhone ? `Phone: ${booking.clientPhone}` : null,
    booking.details || null,
    'Booked on vantagenorth.ae. Change or cancel it there, not here.',
  ].filter(Boolean);
  return {
    summary: booking.title || `Inspection ${booking.ref}`,
    location: booking.location || undefined,
    description: lines.join('\n'),
    start: { dateTime: new Date(booking.start).toISOString(), timeZone: TIME_ZONE },
    end: { dateTime: new Date(booking.end).toISOString(), timeZone: TIME_ZONE },
    transparency: 'opaque',
    reminders: { useDefault: true },
    extendedProperties: { private: { vnRef: booking.ref } },
  };
}

// No attendees and sendUpdates=none: Google sends nothing to anyone.
async function createBookingEvent(booking) {
  const ev = await gcal('/events?sendUpdates=none', { method: 'POST', body: eventBody(booking) });
  return ev.id;
}

async function moveBookingEvent(eventId, { start, end }) {
  await gcal(`/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
    method: 'PATCH',
    body: {
      start: { dateTime: new Date(start).toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: new Date(end).toISOString(), timeZone: TIME_ZONE },
    },
  });
}

async function deleteBookingEvent(eventId) {
  try {
    await gcal(`/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'DELETE' });
  } catch (err) {
    // Already gone is fine.
    if (err.status === 404 || err.status === 410) return;
    throw err;
  }
}

module.exports = {
  GoogleCalendarError,
  isGoogleConfigured,
  calendarId,
  buildConnectUrl,
  verifyState,
  completeConnect,
  getAccessToken,
  listBusy,
  createBookingEvent,
  moveBookingEvent,
  deleteBookingEvent,
  _resetTokenCache: () => {
    cachedToken = null;
  },
};
