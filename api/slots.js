const { resolveTierConfig } = require('./_lib/config');
const { fetchAvailableSlots } = require('./_lib/cal');
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

    if (!process.env.CAL_API_KEY) {
      return res.status(500).json({ error: 'CAL_API_KEY is not configured' });
    }

    const result = await fetchAvailableSlots({
      eventTypeId: tier.calEventTypeId,
      durationMinutes: tier.durationMinutes,
    });
    if (!result.ok) {
      // Only failures are logged here; successful slot lookups are too frequent.
      await logPaymentEvent({
        source: 'cal',
        event: 'cal.slots_failed',
        level: 'error',
        httpStatus: result.status,
        message: result.error,
        details: { event_type_id: tier.calEventTypeId },
      });
      return res.status(result.status).json({ error: result.error });
    }

    return res.status(200).json({
      durationMinutes: tier.durationMinutes,
      timeZone: 'Asia/Dubai',
      slots: result.slots,
    });
  } catch (err) {
    console.error('Error in /api/slots:', err);
    await logPaymentEvent({
      source: 'cal',
      event: 'cal.slots_exception',
      level: 'error',
      message: errorMessageOf(err),
    });
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
