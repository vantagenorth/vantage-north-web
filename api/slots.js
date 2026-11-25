const { resolveTierConfig } = require('./_lib/config');
const { fetchAvailableSlots } = require('./_lib/cal');
const { useGoogleScheduler, fetchGoogleSlots } = require('./_lib/availability');
const { logPaymentEvent, errorMessageOf } = require('./_lib/payment-log');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { propertyType, bedroomTier, bedrooms, scheduler } = req.query || {};
    const tier = resolveTierConfig(propertyType, bedrooms ?? bedroomTier);
    if (!tier) {
      return res.status(400).json({ error: 'Invalid propertyType or bedroomTier' });
    }

    const google = useGoogleScheduler(scheduler);
    if (!google && !process.env.CAL_API_KEY) {
      return res.status(500).json({ error: 'CAL_API_KEY is not configured' });
    }

    const result = google
      ? await fetchGoogleSlots({ durationMinutes: tier.durationMinutes })
      : await fetchAvailableSlots({
          eventTypeId: tier.calEventTypeId,
          durationMinutes: tier.durationMinutes,
        });
    if (!result.ok) {
      // Only failures are logged here; successful slot lookups are too frequent.
      await logPaymentEvent({
        source: google ? 'calendar' : 'cal',
        event: google ? 'calendar.slots_failed' : 'cal.slots_failed',
        level: 'error',
        httpStatus: result.status,
        message: result.detail || result.error,
        details: google ? { duration_minutes: tier.durationMinutes } : { event_type_id: tier.calEventTypeId },
      });
      return res.status(result.status).json({ error: result.error });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      scheduler: google ? 'google' : 'cal',
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
