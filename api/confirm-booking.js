const {
  verifyBookingToken,
  getCheckoutHoldByRef,
  getBookingByReference,
  isSupabaseConfigured,
} = require('./_lib/supabase');
const { finalizeBooking } = require('./_lib/confirm-core');
const { logPaymentEvent, ziinaSummary, errorMessageOf } = require('./_lib/payment-log');
const { buildManageLinks } = require('./_lib/manage');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let bookingReference = null;
  let resolvedIntentId = null;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { paymentIntentId, token } = body;
    bookingReference = body.bookingReference || null;

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
            slotTaken: existing.status === 'needs_reschedule',
            manageLinks: buildManageLinks(existing.booking_reference),
            intentId: existing.payments?.[0]?.ziina_payment_intent_id || paymentIntentId || hold?.ziina_payment_intent_id,
          },
          isTest: Boolean(existing.payments?.[0]?.is_test),
          supabaseSynced: true,
        });
      }
    }

    if (!tokenData) {
      await logPaymentEvent({
        source: 'confirm',
        event: 'confirm.missing_booking_data',
        level: 'error',
        bookingReference,
        intentId: paymentIntentId || hold?.ziina_payment_intent_id,
        httpStatus: 404,
        message: 'No valid booking token and no checkout hold payload',
        details: { had_token: Boolean(token), had_hold: Boolean(hold) },
      });
      return res.status(404).json({ error: 'Invalid or missing booking token' });
    }

    resolvedIntentId = paymentIntentId || hold?.ziina_payment_intent_id || null;
    if (!resolvedIntentId) {
      await logPaymentEvent({
        source: 'confirm',
        event: 'confirm.missing_intent_id',
        level: 'error',
        bookingReference,
        httpStatus: 400,
      });
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
    const ziinaData = await ziinaRes.json().catch(() => ({}));
    if (!ziinaRes.ok) {
      await logPaymentEvent({
        source: 'confirm',
        event: 'ziina.verify_failed',
        level: 'error',
        bookingReference,
        intentId: resolvedIntentId,
        httpStatus: ziinaRes.status,
        message: ziinaData?.message || 'Ziina payment intent lookup failed',
        details: { ziina: ziinaSummary(ziinaData) },
      });
      return res.status(ziinaRes.status).json({ error: 'Failed to verify Ziina payment', details: ziinaData });
    }
    await logPaymentEvent({
      source: 'confirm',
      event: 'ziina.verified',
      bookingReference,
      intentId: resolvedIntentId,
      httpStatus: ziinaRes.status,
      ziinaStatus: ziinaData.status,
      details: { ziina: ziinaSummary(ziinaData), hold_status: hold?.status || null },
    });
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
      trigger: 'redirect',
    });

    if (result?.booking?.bookingReference) {
      result.booking.manageLinks = buildManageLinks(result.booking.bookingReference);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('Error in /api/confirm-booking:', err);
    await logPaymentEvent({
      source: 'confirm',
      event: 'confirm.exception',
      level: 'error',
      bookingReference,
      intentId: resolvedIntentId,
      message: errorMessageOf(err),
    });
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
