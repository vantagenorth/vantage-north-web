const { resolveTierConfig } = require('./_lib/config');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { propertyType, bedroomTier, start, end } = req.query || {};
    const tier = resolveTierConfig(propertyType, bedroomTier);
    if (!tier) {
      return res.status(400).json({ error: 'Invalid propertyType or bedroomTier' });
    }

    const calApiKey = process.env.CAL_API_KEY;
    if (!calApiKey) {
      return res.status(500).json({ error: 'CAL_API_KEY is not configured on the server' });
    }

    const startDate = start ? new Date(start) : new Date();
    const endDate = end ? new Date(end) : new Date(startDate.getTime() + 14 * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      eventTypeId: String(tier.calEventTypeId),
      start: startDate.toISOString(),
      end: endDate.toISOString(),
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

    const data = await calRes.json();
    if (!calRes.ok) {
      return res.status(calRes.status).json({
        error: 'Failed to fetch Cal.com slots',
        details: data,
      });
    }

    return res.status(200).json({
      eventTypeId: tier.calEventTypeId,
      durationMinutes: tier.durationMinutes,
      timeZone: 'Asia/Dubai',
      slots: data.data || {},
    });
  } catch (err) {
    console.error('Error in /api/slots:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
