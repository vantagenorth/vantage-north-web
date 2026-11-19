const { resolveTierConfig } = require('./_lib/config');

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

    const calApiKey = process.env.CAL_API_KEY;
    if (!calApiKey) {
      return res.status(500).json({ error: 'CAL_API_KEY is not configured' });
    }

    const nowMs = Date.now();
    const daysAhead = 60;
    const startIso = new Date(nowMs).toISOString();
    const endIso = new Date(nowMs + daysAhead * 24 * 60 * 60 * 1000).toISOString();

    const params = new URLSearchParams({
      eventTypeId: String(tier.calEventTypeId),
      start: startIso,
      end: endIso,
      timeZone: 'Asia/Dubai',
    });

    const calRes = await fetch(`https://api.cal.com/v2/slots?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${calApiKey}`,
        'cal-api-version': '2024-09-04',
        'User-Agent': 'VantageNorthBooking/1.0',
      },
    });

    const calJson = await calRes.json();
    if (!calRes.ok || calJson.status === 'error') {
      return res.status(calRes.status || 502).json({
        error: calJson?.error?.message || 'Failed to fetch availability from Cal.com',
      });
    }

    return res.status(200).json({
      durationMinutes: tier.durationMinutes,
      timeZone: 'Asia/Dubai',
      slots: calJson.data || {},
    });
  } catch (err) {
    console.error('Error in /api/slots:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
