// Open inspection times, worked out on our side (Supabase + Google Calendar)
// instead of by Cal.com.
//
// A time is open when it is inside working hours and none of these overlap it:
//   - a booking in Supabase that holds its slot (confirmed / cancelling)
//   - someone paying for that time right now (checkout_holds)
//   - anything busy in Andy's Google Calendar; an all-day event blocks the whole day
//   - the "look busy" block for that day (see fillBlockFor)
//
// Which system is used:
//   BOOKING_CALENDAR=google  (Vercel env) switches the live site to this.
//   Otherwise Cal.com is used, except for requests that ask for scheduler=google
//   (the /booking-test page), so the new system can be tested before switching.
const crypto = require('crypto');
const { getActiveCheckoutHolds, getSlotHoldingBookings } = require('./supabase');
const { listBusy } = require('./google-calendar');

const TIME_ZONE = 'Asia/Dubai';
const DUBAI_OFFSET = '+04:00'; // the UAE has no daylight saving
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

// Working hours by weekday (0 = Sunday). Same as the Cal.com "Working Hours" schedule.
const WORKING_HOURS = {
  1: { start: '10:00', end: '16:00' },
  2: { start: '10:00', end: '16:00' },
  3: { start: '10:00', end: '16:00' },
  4: { start: '10:00', end: '16:00' },
  5: { start: '10:00', end: '16:00' },
};
const MIN_NOTICE_MINUTES = 120; // same as Cal.com's minimum booking notice
const DAYS_AHEAD = 60;

// "Look busy" blocking (was the nightly Cal.com calendar-fill job). Same rules and the same
// hash, so the days blocked today stay blocked after the switch.
const FILL_SLOT_MINUTES = 120;
const FILL_LONGEST_MINUTES = 240;
const FILL_KEEP_OPEN_WORKING_DAYS = 2;
const FILL_LOOKAHEAD_DAYS = 21;
const FILL_DEFAULT_SHARE = 0.3;
const FILL_SALT = 'vn-calendar-fill-v1';

function googleIsDefault() {
  return String(process.env.BOOKING_CALENDAR || '').toLowerCase() === 'google';
}

// True when this request should use Supabase + Google Calendar.
function useGoogleScheduler(requested) {
  return googleIsDefault() || String(requested || '').toLowerCase() === 'google';
}

function fillShare() {
  const raw = process.env.CALENDAR_BLOCK_SHARE;
  const n = raw === undefined || raw === '' ? FILL_DEFAULT_SHARE : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(0.33, n)) : FILL_DEFAULT_SHARE;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function dubaiDateOf(ms) {
  return new Date(ms + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function workingRange(dateStr) {
  const wh = WORKING_HOURS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
  return wh ? { start: toMinutes(wh.start), end: toMinutes(wh.end) } : null;
}

// Instant (ms) for a Dubai date + minutes after midnight.
function dubaiInstant(dateStr, minutes) {
  return Date.parse(`${dateStr}T00:00:00${DUBAI_OFFSET}`) + minutes * 60000;
}

// Cal.com's slot format, which book.html and reschedule.html already read.
function slotIso(dateStr, minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${dateStr}T${h}:${m}:00.000${DUBAI_OFFSET}`;
}

function hashUnit(text) {
  const hex = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 0x100000000;
}

// The 2-hour block that makes a day look partly booked, or null.
// Never inside the next 2 working days, never past 3 weeks, only the first or last
// 2 hours, and only when the rest of the day still fits a 4-hour inspection.
function fillBlockFor(dateStr, nowMs, share = fillShare()) {
  if (!(share > 0)) return null;
  const range = workingRange(dateStr);
  if (!range) return null;
  const today = dubaiDateOf(nowMs);
  if (dateStr <= today || dateStr > addDays(today, FILL_LOOKAHEAD_DAYS)) return null;
  let workingSeen = 0;
  for (let d = addDays(today, 1); d < dateStr; d = addDays(d, 1)) {
    if (workingRange(d)) workingSeen += 1;
    if (workingSeen >= FILL_KEEP_OPEN_WORKING_DAYS) break;
  }
  if (workingSeen < FILL_KEEP_OPEN_WORKING_DAYS) return null;
  if (range.end - range.start - FILL_SLOT_MINUTES < FILL_LONGEST_MINUTES) return null;
  const dayChance = Math.max(0, Math.min(1, share * (360 / FILL_SLOT_MINUTES)));
  if (hashUnit(`${FILL_SALT}:${dateStr}`) >= dayChance) return null;
  const first = hashUnit(`${FILL_SALT}:side:${dateStr}`) < 0.5;
  return first
    ? { start: range.start, end: range.start + FILL_SLOT_MINUTES }
    : { start: range.end - FILL_SLOT_MINUTES, end: range.end };
}

// Pure step: open slots from working hours and busy times. Exported for tests.
function buildSlots({ nowMs, durationMinutes, daysAhead = DAYS_AHEAD, busyIntervals = [], allDayDates = new Set(), share = fillShare() }) {
  const slots = {};
  const earliest = nowMs + MIN_NOTICE_MINUTES * 60000;
  const today = dubaiDateOf(nowMs);
  for (let i = 0; i <= daysAhead; i += 1) {
    const date = addDays(today, i);
    const range = workingRange(date);
    if (!range || allDayDates.has(date)) continue;
    // Working window for the day, shortened by the look-busy block (it is always at an edge).
    let winStart = range.start;
    let winEnd = range.end;
    const block = fillBlockFor(date, nowMs, share);
    if (block) {
      if (block.start === range.start) winStart = block.end;
      else winEnd = block.start;
    }
    const day = [];
    for (let m = winStart; m + durationMinutes <= winEnd; m += durationMinutes) {
      const s = dubaiInstant(date, m);
      const e = s + durationMinutes * 60000;
      if (s < earliest) continue;
      if (busyIntervals.some((b) => s < b.end && e > b.start)) continue;
      day.push({ start: slotIso(date, m) });
    }
    if (day.length) slots[date] = day;
  }
  return slots;
}

// Open slots from Supabase + Google Calendar.
// excludeRef leaves out one booking (the one being rescheduled).
// Returns { ok, status, error, slots }.
async function fetchGoogleSlots({ durationMinutes, excludeRef = null, nowMs = Date.now(), daysAhead = DAYS_AHEAD }) {
  const startIso = new Date(nowMs).toISOString();
  const endIso = new Date(nowMs + (daysAhead + 1) * 86400000).toISOString();
  let bookings;
  let holds;
  let busy;
  try {
    [bookings, holds, busy] = await Promise.all([
      getSlotHoldingBookings(startIso, endIso),
      getActiveCheckoutHolds(startIso, endIso),
      listBusy(startIso, endIso),
    ]);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err.notConnected ? 'Booking calendar is not connected' : 'Could not load availability',
      detail: err.message,
      slots: {},
    };
  }
  if (!bookings.available || !holds.available) {
    return { ok: false, status: 502, error: 'Could not load availability', detail: 'Supabase unavailable', slots: {} };
  }
  const allDayDates = busy.allDayDates;
  const toInterval = (r) => ({ start: new Date(r.scheduled_start).getTime(), end: new Date(r.scheduled_end).getTime() });
  const busyIntervals = [
    ...bookings.data.filter((b) => b.booking_reference !== excludeRef).map(toInterval),
    ...holds.data.filter((h) => h.booking_reference !== excludeRef).map(toInterval),
    ...busy.intervals,
  ].filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end));
  const slots = buildSlots({ nowMs, durationMinutes, daysAhead, busyIntervals, allDayDates });
  return { ok: true, status: 200, slots };
}

// True if startIso is one of the open slots right now.
async function isGoogleSlotOpen({ startIso, durationMinutes, excludeRef = null }) {
  const result = await fetchGoogleSlots({ durationMinutes, excludeRef });
  if (!result.ok) return { ok: false, open: false, error: result.error, detail: result.detail };
  const want = new Date(startIso).getTime();
  const open = Object.values(result.slots).flat().some((s) => new Date(s.start).getTime() === want);
  return { ok: true, open };
}

module.exports = {
  TIME_ZONE,
  WORKING_HOURS,
  MIN_NOTICE_MINUTES,
  googleIsDefault,
  useGoogleScheduler,
  fillBlockFor,
  buildSlots,
  fetchGoogleSlots,
  isGoogleSlotOpen,
  dubaiDateOf,
};
