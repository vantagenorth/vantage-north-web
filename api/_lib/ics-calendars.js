// Extra busy times from published (public) calendar links, e.g. an iCloud "Travel"
// calendar shared as a public webcal:// link.
//
// Vercel env: ICLOUD_CALENDAR_URLS  one or more links, comma-separated. webcal:// is
// fine. Keep the links out of the code: anyone with one can read that calendar.
//
// Same rules as Google: all-day events close the whole day, timed events close their
// hours unless marked free (TRANSP:TRANSPARENT), cancelled events are ignored.
// Weekly/daily repeats (RRULE) are expanded for the booking window; other repeat
// rules are read as their first occurrence only.
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { at, events }

function calendarUrls() {
  return String(process.env.ICLOUD_CALENDAR_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => u.replace(/^webcals?:\/\//i, 'https://'));
}

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const left = line.slice(0, i);
  const value = line.slice(i + 1).trim();
  const [name, ...paramParts] = left.split(';');
  const params = {};
  for (const p of paramParts) {
    const [k, v] = p.split('=');
    if (k) params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

// Offset (ms) of a time zone at a given instant, e.g. Asia/Dubai -> +4h.
function tzOffsetMs(timeZone, utcMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - utcMs;
  } catch {
    return 4 * 3600000; // unknown zone: assume Dubai
  }
}

// Returns { allDay: true, date: 'YYYY-MM-DD' } or { allDay: false, ms }.
function parseIcsDate(prop) {
  const v = prop.value;
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    return { allDay: true, date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) return { allDay: false, ms: naive };
  const tz = prop.params.TZID || 'Asia/Dubai';
  // Two passes handle the rare daylight-saving edge.
  let ms = naive - tzOffsetMs(tz, naive);
  ms = naive - tzOffsetMs(tz, ms);
  return { allDay: false, ms };
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text).split('\n')) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'DTSTART') cur.start = parseIcsDate(p);
    else if (p.name === 'DTEND') cur.end = parseIcsDate(p);
    else if (p.name === 'DURATION') cur.duration = p.value;
    else if (p.name === 'TRANSP') cur.transparent = p.value.toUpperCase() === 'TRANSPARENT';
    else if (p.name === 'STATUS') cur.cancelled = p.value.toUpperCase() === 'CANCELLED';
    else if (p.name === 'RRULE') cur.rrule = p.value;
  }
  return events.filter((e) => e.start && !e.cancelled);
}

function durationMs(text) {
  const m = String(text || '').match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, w, d, h, mi, s] = m.map((x) => Number(x) || 0);
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

// Occurrence start offsets for simple DAILY/WEEKLY repeats inside [fromMs, toMs].
function occurrences(ev, firstMs, fromMs, toMs) {
  if (!ev.rrule) return [firstMs];
  const rule = Object.fromEntries(ev.rrule.split(';').map((kv) => kv.split('=')));
  const freq = String(rule.FREQ || '').toUpperCase();
  const step = (Number(rule.INTERVAL) || 1) * (freq === 'DAILY' ? 1 : freq === 'WEEKLY' ? 7 : 0) * 86400000;
  if (!step || rule.BYDAY && freq === 'WEEKLY' && rule.BYDAY.includes(',')) return [firstMs];
  const until = rule.UNTIL ? parseIcsDate({ value: rule.UNTIL, params: {} }) : null;
  const untilMs = until ? (until.allDay ? Date.parse(`${until.date}T23:59:59Z`) : until.ms) : Infinity;
  const count = Number(rule.COUNT) || Infinity;
  const out = [];
  for (let i = 0, t = firstMs; i < count && t <= toMs && t <= untilMs && out.length < 500; i += 1, t += step) {
    if (t >= fromMs - 40 * 86400000) out.push(t);
  }
  return out;
}

// Busy times between two instants from every configured link.
// Returns { allDayDates: Set, intervals: [{start,end}], errors: [string] }.
async function listIcsBusy(startIso, endIso) {
  const allDayDates = new Set();
  const intervals = [];
  const errors = [];
  const fromMs = Date.parse(startIso);
  const toMs = Date.parse(endIso);
  for (const url of calendarUrls()) {
    let events;
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      events = hit.events;
    } else {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'text/calendar, */*', 'User-Agent': 'Mozilla/5.0 (compatible; VantageNorthBooking/1.0)' },
          redirect: 'follow',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        if (!body.includes('BEGIN:VCALENDAR')) throw new Error(`Not a calendar (${res.headers.get('content-type') || 'unknown type'})`);
        events = parseIcs(body);
        cache.set(url, { at: Date.now(), events });
      } catch (err) {
        errors.push(err.message);
        if (!hit) continue;
        events = hit.events; // keep using the last copy we had
      }
    }
    for (const ev of events) {
      if (ev.start.allDay) {
        const endDate = ev.end?.allDay ? ev.end.date : addDays(ev.start.date, 1);
        const span = Math.max(1, Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${ev.start.date}T00:00:00Z`)) / 86400000));
        const firstMs = Date.parse(`${ev.start.date}T00:00:00Z`);
        for (const occ of occurrences(ev, firstMs, fromMs, toMs)) {
          for (let i = 0; i < span && i < 400; i += 1) {
            const d = new Date(occ + i * 86400000).toISOString().slice(0, 10);
            allDayDates.add(d);
          }
        }
        continue;
      }
      if (ev.transparent) continue;
      const len = ev.end && !ev.end.allDay ? ev.end.ms - ev.start.ms : durationMs(ev.duration);
      if (!(len > 0)) continue;
      for (const s of occurrences(ev, ev.start.ms, fromMs, toMs)) {
        if (s + len > fromMs && s < toMs) intervals.push({ start: s, end: s + len });
      }
    }
  }
  return { allDayDates, intervals, errors };
}

// Counts only (no dates or titles), for /api/calendar?action=status.
async function icsStatus() {
  const urls = calendarUrls();
  if (!urls.length) return { links: 0 };
  cache.clear();
  const now = Date.now();
  const r = await listIcsBusy(new Date(now).toISOString(), new Date(now + 61 * 86400000).toISOString());
  const events = urls.reduce((n, u) => n + (cache.get(u)?.events.length || 0), 0);
  return {
    links: urls.length,
    ok: r.errors.length === 0,
    errors: r.errors,
    eventsInFeed: events,
    allDayDaysNext60: r.allDayDates.size,
    timedBlocksNext60: r.intervals.length,
  };
}

module.exports = { listIcsBusy, icsStatus, parseIcs, calendarUrls, _clearCache: () => cache.clear() };
