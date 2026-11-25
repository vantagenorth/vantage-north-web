// Keeps part of the booking calendar blocked so it doesn't look empty.
//
// Runs once a day (Vercel cron in vercel.json). It never creates bookings,
// payments or client records. It only adds Cal.com date overrides to the
// default schedule, each one shortening a working day by its first or last
// 2-hour slot.
//
// Rules:
// - Days inside the next KEEP_OPEN_WORKING_DAYS working days are never
//   blocked, and blocks this job made earlier are removed once a day gets that
//   close, so real clients can always book soon.
// - Only the first or the last slot of a day is blocked, and only when the
//   rest of the day still fits the longest inspection (4 hours).
// - A day with a real Cal.com booking or an active checkout hold is left alone.
// - Which days get blocked is decided by a hash of the date, so the same day
//   gets the same answer on every run and blocks don't move around.
// - Overrides this job did not make (for example a day off set in Cal.com)
//   are kept and those days are left alone.
//
// Settings (Vercel environment variables, all optional):
//   CALENDAR_BLOCK_SHARE  share of 2-hour slots to block, 0 to 0.33 (default 0.3).
//                         Set it to 0 to remove every block this job made.
//
// Manual run: GET /api/calendar-fill?dryRun=1 with
// "Authorization: Bearer <CRON_SECRET>" shows the plan without changing anything.

const crypto = require('crypto');
const { getActiveCheckoutHolds } = require('./_lib/supabase');
const { logPaymentEvent, errorMessageOf } = require('./_lib/payment-log');

const TIME_ZONE = 'Asia/Dubai';
const SLOT_MINUTES = 120; // shortest inspection
const LONGEST_MINUTES = 240; // longest inspection must still fit after blocking
const KEEP_OPEN_WORKING_DAYS = 2;
const LOOKAHEAD_DAYS = 21;
const DEFAULT_SHARE = 0.3;
const SALT = 'vn-calendar-fill-v1';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = String(req.headers.authorization || '');
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// YYYY-MM-DD for "now" in Dubai.
function dubaiToday(nowMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(nowMs));
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayName(dateStr) {
  return DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

function hashUnit(text) {
  const hex = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 0x100000000;
}

// The single working range for a weekday, or null if the day is off or split.
function workingRange(availability, dateStr) {
  const day = weekdayName(dateStr);
  const ranges = (availability || []).filter((a) => (a.days || []).includes(day));
  if (ranges.length !== 1) return null;
  return { start: toMinutes(ranges[0].startTime), end: toMinutes(ranges[0].endTime) };
}

// The two override shapes this job uses for a day: first slot blocked, last slot blocked.
function blockShapes(range) {
  return {
    first: { startTime: toHHMM(range.start + SLOT_MINUTES), endTime: toHHMM(range.end) },
    last: { startTime: toHHMM(range.start), endTime: toHHMM(range.end - SLOT_MINUTES) },
  };
}

function isOurOverride(override, availability) {
  const range = workingRange(availability, override.date);
  if (!range) return false;
  const shapes = blockShapes(range);
  return [shapes.first, shapes.last].some(
    (s) => s.startTime === override.startTime && s.endTime === override.endTime
  );
}

// Pure planning step: works out the full overrides list to save.
function planOverrides({ schedule, nowMs, share, busyDates }) {
  const availability = schedule.availability || [];
  const existing = schedule.overrides || [];
  const today = dubaiToday(nowMs);
  const dayChance = Math.max(0, Math.min(1, share * (360 / SLOT_MINUTES)));

  // Working days from tomorrow onward, in order.
  const workingDays = [];
  for (let i = 1; i <= LOOKAHEAD_DAYS + 7; i += 1) {
    const date = addDays(today, i);
    if (workingRange(availability, date)) workingDays.push(date);
  }
  const keepOpen = new Set(workingDays.slice(0, KEEP_OPEN_WORKING_DAYS));
  const lastDate = addDays(today, LOOKAHEAD_DAYS);

  const ours = existing.filter((o) => isOurOverride(o, availability));
  const theirs = existing.filter((o) => !isOurOverride(o, availability));
  const theirDates = new Set(theirs.map((o) => o.date));
  const ourByDate = new Map(ours.map((o) => [o.date, o]));

  const next = [...theirs];
  const added = [];
  const removed = [];
  const kept = [];

  // Past blocks of ours are dropped; blocks beyond the window are kept as they are.
  for (const o of ours) {
    if (o.date > lastDate) {
      next.push(o);
      kept.push(o);
    }
  }

  for (const date of workingDays) {
    if (date > lastDate) break;
    const current = ourByDate.get(date);
    const range = workingRange(availability, date);
    const fits = range.end - range.start - SLOT_MINUTES >= LONGEST_MINUTES;
    const wanted =
      fits &&
      !keepOpen.has(date) &&
      !theirDates.has(date) &&
      hashUnit(`${SALT}:${date}`) < dayChance;

    if (current) {
      // Never pull a block from under a real booking, and keep it if still wanted.
      if (wanted || busyDates.has(date)) {
        next.push(current);
        kept.push(current);
      } else {
        removed.push(current);
      }
      continue;
    }
    if (!wanted || busyDates.has(date)) continue;
    const shapes = blockShapes(range);
    const shape = hashUnit(`${SALT}:side:${date}`) < 0.5 ? shapes.first : shapes.last;
    const o = { date, ...shape };
    next.push(o);
    added.push(o);
  }

  for (const o of ours) {
    if (o.date <= today && !removed.includes(o)) removed.push(o);
  }

  next.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { overrides: next, added, removed, kept };
}

function dubaiDateOf(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(iso));
}

async function calFetch(path, init = {}) {
  const res = await fetch(`https://api.cal.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'VantageNorthBooking/1.0',
      ...(init.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === 'error') {
    throw new Error(`Cal.com ${path} failed (${res.status}): ${json?.error?.message || 'unknown error'}`);
  }
  return json.data;
}

async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.CAL_API_KEY) {
    return res.status(500).json({ error: 'CAL_API_KEY is not configured' });
  }

  const dryRun = ['1', 'true'].includes(String((req.query || {}).dryRun || ''));
  const rawShare = process.env.CALENDAR_BLOCK_SHARE;
  const share = rawShare === undefined || rawShare === '' ? DEFAULT_SHARE : Number(rawShare);
  if (!Number.isFinite(share) || share < 0) {
    return res.status(500).json({ error: 'CALENDAR_BLOCK_SHARE must be a number from 0 to 0.33' });
  }

  try {
    const nowMs = Date.now();
    const startIso = new Date(nowMs).toISOString();
    const endIso = new Date(nowMs + (LOOKAHEAD_DAYS + 2) * 86400000).toISOString();

    const [schedule, bookings, holds] = await Promise.all([
      calFetch('/v2/schedules/default', { headers: { 'cal-api-version': '2024-06-11' } }),
      calFetch(
        `/v2/bookings?status=upcoming&take=250&afterStart=${encodeURIComponent(startIso)}&beforeEnd=${encodeURIComponent(endIso)}`,
        { headers: { 'cal-api-version': '2024-08-13' } }
      ),
      getActiveCheckoutHolds(startIso, endIso),
    ]);
    if (!schedule || !schedule.id) throw new Error('Cal.com returned no default schedule');
    if (!holds.available) throw new Error('Could not read checkout holds from Supabase');

    const busyDates = new Set();
    for (const b of Array.isArray(bookings) ? bookings : []) {
      if (b.start) busyDates.add(dubaiDateOf(b.start));
    }
    for (const h of holds.data) {
      if (h.scheduled_start) busyDates.add(dubaiDateOf(h.scheduled_start));
    }

    const plan = planOverrides({ schedule, nowMs, share, busyDates });
    const changed = plan.added.length > 0 || plan.removed.length > 0;

    if (changed && !dryRun) {
      await calFetch(`/v2/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'cal-api-version': '2024-06-11' },
        body: JSON.stringify({ overrides: plan.overrides }),
      });
    }

    return res.status(200).json({
      dryRun,
      share,
      scheduleId: schedule.id,
      changed: changed && !dryRun,
      added: plan.added,
      removed: plan.removed,
      kept: plan.kept,
      overrides: plan.overrides,
    });
  } catch (err) {
    console.error('Error in /api/calendar-fill:', err);
    await logPaymentEvent({
      source: 'cal',
      event: 'cal.calendar_fill_failed',
      level: 'error',
      message: errorMessageOf(err),
    });
    return res.status(500).json({ error: errorMessageOf(err) });
  }
}

module.exports = handler;
module.exports.planOverrides = planOverrides;
