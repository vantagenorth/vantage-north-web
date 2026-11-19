const { calculateQuote, getSiteUrl } = require('./_lib/config');
const {
  isSupabaseConfigured,
  upsertClient,
  insertBooking,
  insertPayment,
  upsertDeveloper,
  upsertArea,
  findOrCreateProject,
  insertUnit,
  findOrCreateAgent,
  signBookingToken,
} = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

    const {
      propertyType,
      bedroomTier,
      buaSqft,
      packageType,
      scheduledStart,
      fullName,
      email,
      phone,
      clientType = 'owner_buyer',
      companyOrAgency,
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
    if (!fullName || !email || !phone || !projectName || !areaCommunity || !unitNumber || !scheduledStart) {
      return res.status(400).json({ error: 'Please complete all required personal, unit, and schedule fields.' });
    }

    const quote = calculateQuote({ propertyType, bedroomTier, buaSqft, packageType });
    if (quote.error) {
      return res.status(400).json({ error: quote.error });
    }
    if (quote.isLuxuryQuote) {
      return res.status(400).json({
        error: 'Luxury Homes (> 6,500 sq ft or 6+ bedrooms) require a custom quote via /api/luxury-inquiry.',
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

    const bookingReference = `VN-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;

    const bookingPayload = {
      bookingReference,
      propertyType: quote.propertyType,
      bedroomTier: quote.bedroomTier,
      tierLabel: quote.tierLabel,
      buaSqft: buaSqft ? Number(buaSqft) : null,
      packageType: quote.packageType,
      packageLabel: quote.packageLabel,
      priceAed: quote.priceAed,
      amountFils: quote.amountFils,
      calEventTypeId: quote.calEventTypeId,
      durationMinutes: quote.durationMinutes,
      kindOfApartment: quote.kindOfApartment,
      scheduledStart: startDt.toISOString(),
      scheduledEnd: endDt.toISOString(),
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.trim(),
      clientType,
      companyOrAgency: companyOrAgency || agentAgency || null,
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
    const successUrl = `${siteUrl}/booking-confirmation?booking_ref=${encodeURIComponent(
      bookingReference
    )}&token=${encodeURIComponent(token)}`;
    const cancelUrl = `${siteUrl}/book?cancelled=1&booking_ref=${encodeURIComponent(bookingReference)}`;
    const isTest = process.env.ZIINA_TEST_MODE === 'true';

    // Create Ziina Payment Intent
    const ziinaRes = await fetch('https://api-v2.ziina.com/api/payment_intent', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ziinaKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: quote.amountFils,
        currency_code: 'AED',
        message: `Vantage North ${quote.tierLabel} - ${quote.packageLabel} (${bookingReference})`,
        success_url: successUrl,
        cancel_url: cancelUrl,
        test: isTest,
      }),
    });

    const ziinaData = await ziinaRes.json();
    if (!ziinaRes.ok || !ziinaData.redirect_url) {
      return res.status(ziinaRes.status || 502).json({
        error: 'Failed to create Ziina payment intent',
        details: ziinaData,
      });
    }

    let supabaseSynced = false;
    if (isSupabaseConfigured()) {
      const clientRes = await upsertClient({
        fullName: bookingPayload.fullName,
        email: bookingPayload.email,
        phone: bookingPayload.phone,
      });

      const clientId = clientRes.data.id;

      let developerId = null;
      let areaId = null;
      let projectId = null;
      let unitId = null;
      let agentId = null;

      try {
        if (bookingPayload.developer && bookingPayload.developer !== 'Not specified') {
          const dev = await upsertDeveloper(bookingPayload.developer);
          developerId = dev?.id || null;
        }
        const area = await upsertArea(bookingPayload.areaCommunity);
        areaId = area?.id || null;

        const project = await findOrCreateProject({
          name: bookingPayload.projectName,
          areaId,
          developerId,
        });
        projectId = project?.id || null;

        const unit = await insertUnit({
          unitNumber: bookingPayload.unitNumber,
          projectId,
          areaId,
          developerId,
          clientId,
          propertyType: bookingPayload.propertyType,
          bedroomTier: bookingPayload.bedroomTier,
          address: bookingPayload.address,
          dewaConnected: bookingPayload.dewaConnected,
          accessInstructions: bookingPayload.accessInstructions,
        });
        unitId = unit?.id || null;

        if (bookingPayload.agentName) {
          const agent = await findOrCreateAgent({
            fullName: bookingPayload.agentName,
            agency: bookingPayload.agentAgency,
            email: bookingPayload.agentEmail,
            phone: bookingPayload.agentPhone,
          });
          agentId = agent?.id || null;
        }
      } catch (normErr) {
        console.warn('Normalized property/agent sync warning:', normErr.message);
      }

      const bookingRes = await insertBooking({
        booking_reference: bookingReference,
        client_id: clientId,
        unit_id: unitId,
        agent_id: agentId,
        status: 'pending_payment',
        package_type: bookingPayload.packageType,
        package_label: bookingPayload.packageLabel,
        price_aed: bookingPayload.priceAed,
        scheduled_date: bookingPayload.scheduledStart.slice(0, 10),
        scheduled_start: bookingPayload.scheduledStart,
        scheduled_end: bookingPayload.scheduledEnd,
        timezone: 'Asia/Dubai',
        terms_accepted: true,
        terms_accepted_at: bookingPayload.termsAcceptedAt,
        notes: bookingPayload.notes,
      });

      await insertPayment({
        booking_id: bookingRes.data.id,
        client_id: clientId,
        provider: 'ziina',
        ziina_payment_intent_id: ziinaData.id,
        amount_aed: bookingPayload.priceAed,
        amount_fils: bookingPayload.amountFils,
        currency: 'AED',
        status: 'pending',
        is_test: isTest,
        checkout_url: ziinaData.redirect_url,
        raw_response: ziinaData,
      });

      supabaseSynced = true;
    }

    return res.status(200).json({
      bookingReference,
      paymentIntentId: ziinaData.id,
      checkoutUrl: ziinaData.redirect_url,
      isTest,
      priceAed: quote.priceAed,
      supabaseSynced,
    });
  } catch (err) {
    console.error('Error in /api/checkout:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
