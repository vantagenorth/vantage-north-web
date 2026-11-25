const { getActiveCheckoutHolds, getSlotHoldingBookings } = require('./supabase');

const SLOTS_DAYS_AHEAD = 60;

function calHeaders(version = '2024-08-13') {
  return {
    Authorization: `Bearer ${process.env.CAL_API_KEY}`,
    'cal-api-version': version,
    'Content-Type': 'application/json',
    'User-Agent': 'VantageNorthBooking/1.0',
  };
}

/**
 * Open Cal.com slots for an event type, minus times held by someone who is
 * paying right now (checkout_holds). /book and the reschedule page both use
 * this, so they always show the same availability (including the times the
 * nightly calendar-fill blocks with schedule overrides).
 *
 * Returns { ok, status, error, slots: { 'YYYY-MM-DD': [{ start }] } }.
 */
async function fetchAvailableSlots({ eventTypeId, durationMinutes, bookingUidToReschedule = null, excludeRef = null, daysAhead = SLOTS_DAYS_AHEAD }) {
  const nowMs = Date.now();
  const startIso = new Date(nowMs).toISOString();
  const endIso = new Date(nowMs + daysAhead * 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    eventTypeId: String(eventTypeId),
    start: startIso,
    end: endIso,
    timeZone: 'Asia/Dubai',
  });
  if (bookingUidToReschedule) params.set('bookingUidToReschedule', bookingUidToReschedule);

  const [calRes, holdsRes, bookingsRes] = await Promise.all([
    fetch(`https://api.cal.com/v2/slots?${params.toString()}`, {
      method: 'GET',
      headers: calHeaders('2024-09-04'),
    }),
    getActiveCheckoutHolds(startIso, endIso),
    // Bookings made with the Google Calendar system are not in Cal.com, so leave
    // their times out here too while both systems run side by side.
    getSlotHoldingBookings(startIso, endIso).catch(() => ({ data: [] })),
  ]);

  const calJson = await calRes.json().catch(() => ({}));
  if (!calRes.ok || calJson.status === 'error') {
    return {
      ok: false,
      status: calRes.status || 502,
      error: calJson?.error?.message || 'Failed to fetch availability from Cal.com',
      slots: {},
    };
  }

  const activeHolds = [
    ...(holdsRes.data || []),
    ...(bookingsRes.data || []).filter((b) => !excludeRef || b.booking_reference !== excludeRef),
  ].map((h) => ({
    start: new Date(h.scheduled_start).getTime(),
    end: new Date(h.scheduled_end).getTime(),
  }));
  const durationMs = durationMinutes * 60 * 1000;
  const slots = {};
  for (const [dateKey, daySlots] of Object.entries(calJson.data || {})) {
    const kept = (daySlots || []).filter((s) => {
      const sStart = new Date(s.start).getTime();
      const sEnd = sStart + durationMs;
      return !activeHolds.some((h) => sStart < h.end && sEnd > h.start);
    });
    if (kept.length > 0) slots[dateKey] = kept;
  }
  return { ok: true, status: 200, slots };
}

module.exports = {
  calHeaders,
  fetchAvailableSlots,
};
