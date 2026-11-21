const {
  verifyBookingToken,
  getCheckoutHoldByRef,
  getBookingByReference,
  isSupabaseConfigured,
} = require('./_lib/supabase');
const { finalizeBooking } = require('./_lib/confirm-core');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { bookingReference, paymentIntentId, token } = body;

    if (!bookingReference) {
      return res.status(400).json({ error: 'bookingReference is required' });
    }

    const hold = await getCheckoutHoldByRef(bookingReference);
    const tokenData = (token ? verifyBookingToken(token) : null) || hold?.payload || null;

    // Fast path: if webhook already confirmed it in Supabase, return immediately
    if (isSupabaseConfigured()) {
      const dbRes = await getBookingByReference(bookingReference);
      const existing = dbRes.data;
      if (existing && (existing.status === 'confirmed' || existing.status === 'needs_reschedule')) {
        return res.status(200).json({
          alreadyConfirmed: true,
          booking: {
            bookingReference: existing.booking_reference,
            status: existing.status,
            propertyType: tokenData?.propertyType || 'Property',
            bedroomTier: tokenData?.bedroomTier || '',
            packageLabel: tokenData?.packageLabel || 'Initial Inspection',
            priceAed: tokenData?.priceAed || existing.payments?.[0]?.amount_aed || 0,
            pricingBreakdown: tokenData?.pricingBreakdown || null,
            scheduledStart: existing.scheduled_start,
            scheduledEnd: existing.scheduled_end,
            fullName: existing.clients?.name || tokenData?.fullName,
            email: existing.clients?.email || tokenData?.email,
            projectName: tokenData?.projectName || 'Dubai Property',
            areaCommunity: tokenData?.areaCommunity || 'Dubai',
            unitNumber: tokenData?.unitNumber || 'TBD',
            inspectionPurpose: tokenData?.inspectionPurpose || 'Handover',
            calBookingUid: existing.cal_booking_uid || null,
            calCollision: existing.status === 'needs_reschedule',
            intentId: existing.payments?.[0]?.ziina_payment_intent_id || paymentIntentId || hold?.ziina_payment_intent_id,
          },
          isTest: Boolean(existing.payments?.[0]?.is_test),
          supabaseSynced: true,
        });
      }
    }

    if (!tokenData) {
      return res.status(404).json({ error: 'Invalid or missing booking token' });
    }

    const resolvedIntentId = paymentIntentId || hold?.ziina_payment_intent_id;
    if (!resolvedIntentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId to verify payment' });
    }

    const ziinaKey = process.env.ZIINA_API_KEY;
    if (!ziinaKey) {
      return res.status(500).json({ error: 'ZIINA_API_KEY is not configured' });
    }

    const ziinaRes = await fetch(`https://api-v2.ziina.com/api/payment_intent/${encodeURIComponent(resolvedIntentId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ziinaKey}` },
    });
    const ziinaData = await ziinaRes.json();
    if (!ziinaRes.ok) {
      return res.status(ziinaRes.status).json({ error: 'Failed to verify Ziina payment', details: ziinaData });
    }
    if (ziinaData.status !== 'completed') {
      return res.status(402).json({
        error: `Payment is not completed yet (status: ${ziinaData.status})`,
        paymentStatus: ziinaData.status,
      });
    }

    const result = await finalizeBooking({
      bookingReference,
      paymentIntentId: resolvedIntentId,
      tokenData,
      ziinaData,
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('Error in /api/confirm-booking:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
