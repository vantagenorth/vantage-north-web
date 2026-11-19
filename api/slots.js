const { resolveTierConfig } = require('./_lib/config');
const { getActiveBookingsInRange } = require('./_lib/supabase');

const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

function getDubaiDateString(utcMs) {
  const dubai = new Date(utcMs + DUBAI_OFFSET_MS);
  const y = dubai.getUTCFullYear();
  const m = String(dubai.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dubai.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { propertyType, bedroomTier } = req.query || {};
    const tier = resolveTierConfig(propertyType, bedroomTier);
    if (!tier) {
      return res.status(400).json({ error: 'Invalid propertyType or bedroomTier' });
    }

    const durationMs = tier.durationMinutes * 60 * 1000;
    const nowMs = Date.now();
    const minLeadMs = nowMs + 2 * 60 * 60 * 1000; // minimum 2 hours notice
    const daysAhead = 60;

    const rangeStartIso = new Date(nowMs).toISOString();
    const rangeEndIso = new Date(nowMs + (daysAhead + 1) * 24 * 60 * 60 * 1000).toISOString();

    let busyRanges = [];
    const holdCutoffMs = nowMs - 20 * 60 * 1000;
    try {
      const activeRes = await getActiveBookingsInRange(rangeStartIso, rangeEndIso);
      busyRanges = (activeRes.data || [])
        .filter((b) => {
          if (!b.scheduled_start || !b.scheduled_end) return false;
          if (b.status === 'confirmed') return true;
          // Release abandoned pending_payment holds after 20 minutes
          const createdMs = b.created_at ? new Date(b.created_at).getTime() : nowMs;
          return createdMs >= holdCutoffMs;
        })
        .map((b) => ({
          start: new Date(b.scheduled_start).getTime(),
          end: new Date(b.scheduled_end).getTime(),
        }));
    } catch (e) {
      console.warn('Could not query Supabase bookings for slot conflicts:', e.message);
    }

    // Deterministic pseudo-random block (~30% of slots) so the calendar looks naturally busy
    function isSimulatedBooked(dateStr, hour, dayOffset) {
      const str = `${dateStr}-${hour}`;
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
      }
      const mod = Math.abs(hash) % 10;
      // Slightly busier in the first 7 days (~40% booked), ~20% thereafter
      return dayOffset < 7 ? mod < 4 : mod < 2;
    }

    const slots = {};
    // Working hours: 09:00 to 18:00 Dubai time (last start depends on 2h / 3h / 4h duration)
    const lastStartHour = Math.floor(18 - tier.durationMinutes / 60);

    for (let dayOffset = 0; dayOffset < daysAhead; dayOffset++) {
      const dayMs = nowMs + dayOffset * 24 * 60 * 60 * 1000;
      const dateStr = getDubaiDateString(dayMs);
      const daySlots = [];

      for (let hour = 9; hour <= lastStartHour; hour++) {
        const hh = String(hour).padStart(2, '0');
        const isoDubai = `${dateStr}T${hh}:00:00.000+04:00`;
        const slotStart = new Date(isoDubai).getTime();
        const slotEnd = slotStart + durationMs;

        if (slotStart < minLeadMs) continue;
        if (isSimulatedBooked(dateStr, hour, dayOffset)) continue;

        const overlaps = busyRanges.some(
          (busy) => slotStart < busy.end && slotEnd > busy.start
        );
        if (!overlaps) {
          daySlots.push({ start: isoDubai });
        }
      }

      if (daySlots.length > 0) {
        slots[dateStr] = daySlots;
      }
    }

    return res.status(200).json({
      durationMinutes: tier.durationMinutes,
      timeZone: 'Asia/Dubai',
      slots,
    });
  } catch (err) {
    console.error('Error in /api/slots:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
