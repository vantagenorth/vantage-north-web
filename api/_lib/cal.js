// Small Cal.com API v2 helpers shared by the slot picker and the manage-booking page.
const { getActiveCheckoutHolds } = require('./supabase');

const CAL_BASE = 'https://api.cal.com';

async function calFetch(path, { method = 'GET', body, apiVersion = '2024-08-13' } = {}) {
  const calApiKey = process.env.CAL_API_KEY;
  if (!calApiKey) {
    const err = new Error('CAL_API_KEY is not configured');
    err.status = 500;
    throw err;
  }
  const res = await fetch(`${CAL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${calApiKey}`,
      'cal-api-version': apiVersion,
      'Content-Type': 'application/json',
      'User-Agent': 'VantageNorthBooking/1.0',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === 'error') {
    const err = new Error(json?.error?.message || `Cal.com request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

/**
 * Open slots for one Cal.com event type over the next `daysAhead` days, in
 * Dubai time, with slots overlapping an active checkout hold removed.
 */
async function getOpenSlots({ eventTypeId, durationMinutes, daysAhead = 60 }) {
  const nowMs = Date.now();
  const startIso = new Date(nowMs).toISOString();
  const endIso = new Date(nowMs + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    eventTypeId: String(eventTypeId),
    start: startIso,
    end: endIso,
    timeZone: 'Asia/Dubai',
  });

  const [rawSlots, holdsRes] = await Promise.all([
    calFetch(`/v2/slots?${params.toString()}`, { apiVersion: '2024-09-04' }),
    getActiveCheckoutHolds(startIso, endIso),
  ]);

  const activeHolds = (holdsRes.data || []).map((h) => ({
    start: new Date(h.scheduled_start).getTime(),
    end: new Date(h.scheduled_end).getTime(),
  }));
  const durationMs = durationMinutes * 60 * 1000;
  const filtered = {};
  for (const [dateKey, daySlots] of Object.entries(rawSlots || {})) {
    const kept = (daySlots || []).filter((s) => {
      const sStart = new Date(s.start).getTime();
      const sEnd = sStart + durationMs;
      return !activeHolds.some((h) => sStart < h.end && sEnd > h.start);
    });
    if (kept.length > 0) filtered[dateKey] = kept;
  }
  return filtered;
}

function getCalBooking(uid) {
  return calFetch(`/v2/bookings/${encodeURIComponent(uid)}`);
}

function rescheduleCalBooking(uid, { start, reason }) {
  return calFetch(`/v2/bookings/${encodeURIComponent(uid)}/reschedule`, {
    method: 'POST',
    body: { start, ...(reason ? { reschedulingReason: reason } : {}) },
  });
}

function cancelCalBooking(uid, { reason }) {
  return calFetch(`/v2/bookings/${encodeURIComponent(uid)}/cancel`, {
    method: 'POST',
    body: { cancellationReason: reason || 'Cancelled by client' },
  });
}

module.exports = {
  calFetch,
  getOpenSlots,
  getCalBooking,
  rescheduleCalBooking,
  cancelCalBooking,
};
