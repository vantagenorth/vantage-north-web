const { calculateQuote, getSiteUrl } = require('./_lib/config');
const {
  signBookingToken,
  getActiveCheckoutHolds,
  createCheckoutHold,
} = require('./_lib/supabase');
const { logPaymentEvent, ziinaSummary } = require('./_lib/payment-log');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

    const expectedKey = process.env.TEST_BOOKING_KEY;
    if (!expectedKey || !body.testKey || body.testKey !== expectedKey) {
      return res.status(403).json({ error: 'Test booking is locked. Valid test access key required.' });
    }

    const {
      amountAed: rawAmountAed = 2,
      propertyType = 'Apartment',
      bedrooms = 2,
      bathrooms = 2,
      packageType = 'initial',
      scheduledStart,
      fullName = 'Test Client',
      email = 'hello@vantagenorth.ae',
      phone = '+971 58 556 5311',
      projectName = 'Test Tower Residence',
      areaCommunity = 'Dubai Marina',
      unitNumber = 'Test-1402',
      developer = 'Test Developer',
      dewaConnected = true,
      inspectionPurpose = 'Handover',
      accessInstructions = 'Test NOC ready at security desk',
      agentName = 'Test Agent',
      agentAgency = 'Test Real Estate',
      agentEmail = 'hello@vantagenorth.ae',
      agentPhone = '+971 50 000 0000',
      notes = 'Test inspection booking via /booking-test',
    } = body;

    if (!scheduledStart) {
      return res.status(400).json({ error: 'Please select an available Cal.com time slot.' });
    }

    const quote = calculateQuote({ propertyType, bedrooms, bathrooms, packageType });
    if (quote.error || quote.isLuxuryQuote) {
      return res.status(400).json({ error: quote.error || 'Invalid test property configuration' });
    }

    const ziinaKey = process.env.ZIINA_API_KEY;
    if (!ziinaKey) {
      return res.status(500).json({ error: 'ZIINA_API_KEY is not configured on the server' });
    }

    const startDt = new Date(scheduledStart);
    if (Number.isNaN(startDt.getTime())) {
      return res.status(400).json({ error: 'Invalid scheduledStart datetime' });
    }
    const endDt = new Date(startDt.getTime() + quote.durationMinutes * 60 * 1000);

    const holdsRes = await getActiveCheckoutHolds(startDt.toISOString(), endDt.toISOString());
    if ((holdsRes.data || []).length > 0) {
      return res.status(409).json({
        error: 'This time slot is currently reserved. Please select another slot.',
      });
    }

    const parsedAed = Number(rawAmountAed);
    const amountAed = Number.isFinite(parsedAed) ? Math.min(25, Math.max(2, Math.round(parsedAed))) : 2;
    const amountFils = amountAed * 100;

    const bookingReference = `VN-TEST-${Date.now().toString(36).toUpperCase()}`;

    const bookingPayload = {
      bookingReference,
      propertyType: quote.propertyType,
      bedrooms: quote.bedrooms,
      bathrooms: quote.bathrooms,
      bedroomTier: quote.bedroomTier,
      tierLabel: quote.tierLabel,
      packageType: quote.packageType,
      packageLabel: `${quote.packageLabel} (Test Booking)`,
      priceAed: amountAed,
      amountFils,
      pricingBreakdown: [
        { label: `Test Booking (${quote.tierLabel})`, amountAed },
      ],
      calEventTypeId: quote.calEventTypeId,
      durationMinutes: quote.durationMinutes,
      kindOfApartment: quote.kindOfApartment,
      scheduledStart: startDt.toISOString(),
      scheduledEnd: endDt.toISOString(),
      fullName: String(fullName).trim(),
      email: String(email).trim().toLowerCase(),
      phone: String(phone).trim(),
      projectName: String(projectName).trim(),
      areaCommunity: String(areaCommunity).trim(),
      unitNumber: String(unitNumber).trim(),
      address: null,
      developer: String(developer).trim(),
      dewaConnected: Boolean(dewaConnected),
      inspectionPurpose,
      accessInstructions: String(accessInstructions).trim(),
      agentName: agentName ? String(agentName).trim() : null,
      agentAgency: agentAgency ? String(agentAgency).trim() : null,
      agentEmail: agentEmail ? String(agentEmail).trim() : null,
      agentPhone: agentPhone ? String(agentPhone).trim() : null,
      notes: notes ? String(notes).trim() : null,
      termsAcceptedAt: new Date().toISOString(),
      isTestBooking: true,
    };

    const token = signBookingToken(bookingPayload);
    const siteUrl = getSiteUrl(req);
    const successUrl = `${siteUrl}/booking-confirmation?booking_ref=${encodeURIComponent(bookingReference)}`;
    const cancelUrl = `${siteUrl}/booking-test?cancelled=1&booking_ref=${encodeURIComponent(bookingReference)}`;
    const isTest = process.env.ZIINA_TEST_MODE === 'true';

    const ziinaMessage = `Vantage North Test ${bookingReference}`.slice(0, 60);
    const ziinaRes = await fetch('https://api-v2.ziina.com/api/payment_intent', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ziinaKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountFils,
        currency_code: 'AED',
        message: ziinaMessage,
        success_url: successUrl,
        cancel_url: cancelUrl,
        test: isTest,
      }),
    });

    const ziinaData = await ziinaRes.json().catch(() => ({}));
    if (!ziinaRes.ok || !ziinaData.redirect_url) {
      await logPaymentEvent({
        source: 'test_checkout',
        event: 'ziina.intent_create_failed',
        level: 'error',
        bookingReference,
        intentId: ziinaData?.id,
        httpStatus: ziinaRes.status,
        ziinaStatus: ziinaData?.status,
        message: ziinaData?.message || 'Ziina did not return a checkout URL',
        details: { ziina: ziinaSummary(ziinaData), is_test_booking: true },
      });
      return res.status(ziinaRes.status || 502).json({
        error: ziinaData?.message || 'Failed to create Ziina payment intent',
        details: ziinaData,
      });
    }

    await logPaymentEvent({
      source: 'test_checkout',
      event: 'ziina.intent_created',
      bookingReference,
      intentId: ziinaData.id,
      httpStatus: ziinaRes.status,
      ziinaStatus: ziinaData.status,
      details: { ziina: ziinaSummary(ziinaData), is_test_booking: true },
    });

    const holdRes = await createCheckoutHold({
      booking_reference: bookingReference,
      ziina_payment_intent_id: ziinaData.id,
      scheduled_start: startDt.toISOString(),
      scheduled_end: endDt.toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: 'pending',
      payload: bookingPayload,
    });
    if (!holdRes.available) {
      await logPaymentEvent({
        source: 'test_checkout',
        event: 'hold.save_failed',
        level: 'error',
        bookingReference,
        intentId: ziinaData.id,
        message: holdRes.error || 'Supabase not configured; checkout hold not saved',
        details: { is_test_booking: true },
      });
    }

    return res.status(200).json({
      redirectUrl: ziinaData.redirect_url,
      // The test page always uses the embedded form on /pay, so it can be
      // tried before turning it on for customers (ZIINA_EMBEDDED_CHECKOUT).
      embeddedUrl: ziinaData.embedded_url || null,
      paymentIntentId: ziinaData.id,
      bookingReference,
      amountAed,
      token,
      test: isTest,
    });
  } catch (err) {
    console.error('Error in /api/test-checkout:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
