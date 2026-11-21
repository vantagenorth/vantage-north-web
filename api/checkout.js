const { calculateQuote, getSiteUrl } = require('./_lib/config');
const {
  signBookingToken,
  getActiveCheckoutHolds,
  createCheckoutHold,
} = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

    const {
      propertyType,
      bedrooms,
      bathrooms,
      bedroomTier,
      buaSqft,
      packageType,
      scheduledStart,
      fullName,
      email,
      phone,
      projectName,
      areaCommunity,
      unitNumber,
      address,
      developer,
      dewaConnected = true,
      inspectionPurpose = 'Handover',
      accessInstructions,
      agentName,
      agentAgency,
      agentEmail,
      agentPhone,
      notes,
      termsAccepted,
    } = body;

    if (!termsAccepted) {
      return res.status(400).json({ error: 'You must accept the Vantage North Terms of Service.' });
    }
    if (!fullName || !email || !phone || !projectName || !areaCommunity || !unitNumber || !accessInstructions || !scheduledStart) {
      return res.status(400).json({ error: 'Please complete all required personal, unit, on-site access, and schedule fields.' });
    }

    const quote = calculateQuote({ propertyType, bedrooms, bathrooms, bedroomTier, buaSqft, packageType });
    if (quote.error) {
      return res.status(400).json({ error: quote.error });
    }
    if (quote.isLuxuryQuote) {
      return res.status(400).json({
        error: 'Luxury Homes require a custom quote.',
      });
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

    // Check temporary 15-minute checkout holds to prevent concurrent double-bookings
    const holdsRes = await getActiveCheckoutHolds(startDt.toISOString(), endDt.toISOString());
    if ((holdsRes.data || []).length > 0) {
      return res.status(409).json({
        error: 'This time slot is currently reserved by another customer completing checkout. Please select another slot.',
      });
    }

    const bookingReference = `VN-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;

    const bookingPayload = {
      bookingReference,
      propertyType: quote.propertyType,
      bedrooms: quote.bedrooms,
      bathrooms: quote.bathrooms,
      bedroomTier: quote.bedroomTier,
      tierLabel: quote.tierLabel,
      packageType: quote.packageType,
      packageLabel: quote.packageLabel,
      priceAed: quote.priceAed,
      amountFils: quote.amountFils,
      pricingBreakdown: quote.pricingBreakdown,
      calEventTypeId: quote.calEventTypeId,
      durationMinutes: quote.durationMinutes,
      kindOfApartment: quote.kindOfApartment,
      scheduledStart: startDt.toISOString(),
      scheduledEnd: endDt.toISOString(),
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.trim(),
      projectName: projectName.trim(),
      areaCommunity: areaCommunity.trim(),
      unitNumber: unitNumber.trim(),
      address: address ? address.trim() : null,
      developer: developer ? developer.trim() : 'Not specified',
      dewaConnected: Boolean(dewaConnected),
      inspectionPurpose,
      accessInstructions: accessInstructions ? accessInstructions.trim() : 'Will coordinate prior to inspection',
      agentName: agentName ? agentName.trim() : null,
      agentAgency: agentAgency ? agentAgency.trim() : null,
      agentEmail: agentEmail ? agentEmail.trim() : null,
      agentPhone: agentPhone ? agentPhone.trim() : null,
      notes: notes ? notes.trim() : null,
      termsAcceptedAt: new Date().toISOString(),
    };

    const token = signBookingToken(bookingPayload);
    const siteUrl = getSiteUrl(req);
    const successUrl = `${siteUrl}/booking-confirmation?booking_ref=${encodeURIComponent(bookingReference)}`;
    const cancelUrl = `${siteUrl}/book?cancelled=1&booking_ref=${encodeURIComponent(bookingReference)}`;
    const isTest = process.env.ZIINA_TEST_MODE === 'true';

    // Create Ziina Payment Intent (no permanent Supabase records until payment is confirmed)
    const ziinaMessage = `Vantage North Booking ${bookingReference}`.slice(0, 60);
    const ziinaRes = await fetch('https://api-v2.ziina.com/api/payment_intent', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ziinaKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: quote.amountFils,
        currency_code: 'AED',
        message: ziinaMessage,
        success_url: successUrl,
        cancel_url: cancelUrl,
        test: isTest,
      }),
    });

    const ziinaData = await ziinaRes.json();
    if (!ziinaRes.ok || !ziinaData.redirect_url) {
      return res.status(ziinaRes.status || 502).json({
        error: ziinaData?.message || 'Failed to create Ziina payment intent',
        details: ziinaData,
      });
    }

    // Store temporary 15-minute slot hold + payload for webhook & confirmation lookup
    await createCheckoutHold({
      booking_reference: bookingReference,
      ziina_payment_intent_id: ziinaData.id,
      scheduled_start: startDt.toISOString(),
      scheduled_end: endDt.toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: 'pending',
      payload: bookingPayload,
    });

    return res.status(200).json({
      bookingReference,
      paymentIntentId: ziinaData.id,
      checkoutUrl: ziinaData.redirect_url,
      token,
      isTest,
      priceAed: quote.priceAed,
    });
  } catch (err) {
    console.error('Error in /api/checkout:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
