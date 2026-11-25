const { resolveTierConfig } = require('./_lib/config');
const { fetchSlots } = require('./_lib/availability');
const { logPaymentEvent, errorMessageOf } = require('./_lib/payment-log');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { propertyType, bedroomTier, bedrooms } = req.query || {};
    const tier = resolveTierConfig(propertyType, bedrooms ?? bedroomTier);
    if (!tier) {
      return res.status(400).json({ error: 'Invalid propertyType or bedroomTier' });
    }

    const result = await fetchSlots({ durationMinutes: tier.durationMinutes });
    if (!result.ok) {
      // Only failures are logged here; successful slot lookups are too frequent.
      await logPaymentEvent({
        source: 'calendar',
        event: 'calendar.slots_failed',
        level: 'error',
        httpStatus: result.status,
        message: result.detail || result.error,
        details: { duration_minutes: tier.durationMinutes },
      });
      return res.status(result.status).json({ error: result.error });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      durationMinutes: tier.durationMinutes,
      timeZone: 'Asia/Dubai',
      slots: result.slots,
    });
  } catch (err) {
    console.error('Error in /api/slots:', err);
    await logPaymentEvent({
      source: 'calendar',
      event: 'calendar.slots_exception',
      level: 'error',
      message: errorMessageOf(err),
    });
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
