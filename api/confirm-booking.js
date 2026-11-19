const {
  isSupabaseConfigured,
  upsertClient,
  upsertDeveloper,
  findOrCreateProject,
  insertUnit,
  findOrCreateAgent,
  insertReport,
  insertBooking,
  insertPayment,
  updatePaymentByIntentId,
  getBookingByReference,
  verifyBookingToken,
} = require('./_lib/supabase');

function formatDubaiTime(iso) {
  try {
    return new Intl.DateTimeFormat('en-AE', {
      timeZone: 'Asia/Dubai',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function sendResendEmail({ to, subject, html }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey || !to) {
    return { sent: false, reason: 'RESEND_API_KEY or recipient missing' };
  }
  const from = process.env.RESEND_FROM_EMAIL || 'Vantage North <bookings@vantagenorth.ae>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html }),
  });
  const data = await res.json();
  if (!res.ok) {
    return { sent: false, reason: data?.message || JSON.stringify(data) };
  }
  return { sent: true, id: data.id };
}

function buildConfirmationHtml(b, paymentStatus) {
  const dubaiTime = formatDubaiTime(b.scheduledStart);
  return `
  <div style="font-family: 'Helvetica Neue', Arial, sans-serif; background:#FAFAFA; padding:32px 16px; color:#000000;">
    <div style="max-width:600px; margin:0 auto; background:#FFFFFF; border:1px solid #E5E5E5; border-radius:12px; padding:32px;">
      <p style="font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#646464; margin:0 0 8px;">Vantage North — Booking Confirmed</p>
      <h1 style="font-size:24px; margin:0 0 16px; font-weight:600;">Your Property Inspection is Booked</h1>
      <p style="font-size:15px; line-height:1.6; color:#2B2B2B; margin:0 0 24px;">
        Hi ${b.fullName}, thank you for booking with Vantage North. Your payment has been confirmed and your inspection slot is reserved.
      </p>

      <div style="background:#FAFAFA; border:1px solid #E5E5E5; border-radius:8px; padding:20px; margin-bottom:24px;">
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <tr><td style="padding:6px 0; color:#646464;">Booking Reference</td><td style="padding:6px 0; text-align:right; font-weight:600;">${b.bookingReference}</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Inspection Date & Time</td><td style="padding:6px 0; text-align:right; font-weight:600;">${dubaiTime} (Dubai)</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Property</td><td style="padding:6px 0; text-align:right;">${b.propertyType} — ${b.bedroomTier}</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Package</td><td style="padding:6px 0; text-align:right;">${b.packageLabel}</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Unit / Project</td><td style="padding:6px 0; text-align:right;">${b.unitNumber}, ${b.projectName} (${b.areaCommunity})</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Purpose</td><td style="padding:6px 0; text-align:right;">${b.inspectionPurpose}</td></tr>
          <tr><td style="padding:10px 0 0; border-top:1px solid #E5E5E5; font-weight:600;">Amount Paid</td><td style="padding:10px 0 0; border-top:1px solid #E5E5E5; text-align:right; font-weight:600;">${Number(b.priceAed).toLocaleString()} AED (${paymentStatus})</td></tr>
        </table>
      </div>

      <p style="font-size:13px; line-height:1.6; color:#646464; margin:0 0 16px;">
        Please ensure DEWA (electricity & water) and site access are arranged prior to the inspection. Your interactive digital report will be delivered within 24 hours of inspection completion.
      </p>
      <p style="font-size:13px; color:#646464; margin:0;">
        Questions? Reply to this email or WhatsApp us on <strong>+971 58 556 5311</strong>.
      </p>
    </div>
  </div>`;
}

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

    const tokenData = token ? verifyBookingToken(token) : null;

    // Idempotency check if booking already confirmed & persisted in Supabase
    let existingBooking = null;
    if (isSupabaseConfigured()) {
      const dbRes = await getBookingByReference(bookingReference);
      existingBooking = dbRes.data;
    }

    if (existingBooking && existingBooking.status === 'confirmed') {
      return res.status(200).json({
        alreadyConfirmed: true,
        booking: {
          bookingReference: existingBooking.booking_reference,
          status: existingBooking.status,
          propertyType: tokenData?.propertyType || 'Property',
          bedroomTier: tokenData?.bedroomTier || '',
          packageLabel: tokenData?.packageLabel || 'Initial Inspection',
          priceAed: tokenData?.priceAed || existingBooking.payments?.[0]?.amount_aed || 0,
          scheduledStart: existingBooking.scheduled_start,
          scheduledEnd: existingBooking.scheduled_end,
          fullName: existingBooking.clients?.name || tokenData?.fullName,
          email: existingBooking.clients?.email || tokenData?.email,
          projectName: tokenData?.projectName || 'Dubai Property',
          areaCommunity: tokenData?.areaCommunity || 'Dubai',
          unitNumber: tokenData?.unitNumber || 'TBD',
        },
        supabaseSynced: true,
      });
    }

    if (!tokenData) {
      return res.status(404).json({ error: 'Invalid or missing booking token' });
    }

    const b = { ...tokenData, intentId: paymentIntentId };
    if (!b.intentId) {
      return res.status(400).json({ error: 'Missing paymentIntentId to verify payment' });
    }

    const ziinaKey = process.env.ZIINA_API_KEY;
    if (!ziinaKey) {
      return res.status(500).json({ error: 'ZIINA_API_KEY is not configured' });
    }

    // 1. Verify Ziina payment is completed BEFORE creating any Supabase records
    const ziinaRes = await fetch(`https://api-v2.ziina.com/api/payment_intent/${encodeURIComponent(b.intentId)}`, {
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

    // 2. Optional Cal.com booking creation (if CAL_API_KEY is configured on Vercel)
    let calBookingId = null;
    let calBookingUid = null;
    let calWarning = null;
    const calApiKey = process.env.CAL_API_KEY;
    if (calApiKey && b.calEventTypeId) {
      try {
        const calRes = await fetch('https://api.cal.com/v2/bookings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${calApiKey}`,
            'cal-api-version': '2024-08-13',
            'Content-Type': 'application/json',
            'User-Agent': 'VantageNorthBooking/1.0',
          },
          body: JSON.stringify({
            start: b.scheduledStart,
            eventTypeId: Number(b.calEventTypeId),
            attendee: {
              name: b.fullName,
              email: b.email,
              timeZone: 'Asia/Dubai',
              ...(b.phone ? { phoneNumber: b.phone.replace(/[^\d+]/g, '') } : {}),
            },
            bookingFieldsResponses: {
              'Apartment-number': b.unitNumber || 'TBD',
              'Kind-of-apartment': b.kindOfApartment || '1 Bedroom',
              'Electricity--water-DEWA-are-on': Boolean(b.dewaConnected),
              'Developer--if-known': b.developer || 'Not specified',
              'On-site-access': b.accessInstructions || 'Will coordinate prior to inspection',
              'Purpose-of-inspections': b.inspectionPurpose || 'Handover',
              'I-agree-to-True-North-s-terms-of-service': true,
            },
            metadata: {
              bookingReference: b.bookingReference,
              packageType: b.packageType,
              propertyType: b.propertyType,
              bedroomTier: b.bedroomTier,
              projectName: b.projectName,
              areaCommunity: b.areaCommunity,
            },
          }),
        });
        const calJson = await calRes.json();
        if (calRes.ok && calJson.data) {
          calBookingId = calJson.data.id || null;
          calBookingUid = calJson.data.uid || null;
        } else {
          calWarning = calJson?.error?.message || JSON.stringify(calJson);
        }
      } catch (calErr) {
        calWarning = calErr.message;
      }
    }

    // 3. Create all Supabase records ONLY now that payment is confirmed
    let supabaseSynced = false;
    let reportId = null;
    let normWarning = null;
    let reportWarning = null;
    if (isSupabaseConfigured()) {
      const clientRes = await upsertClient({
        fullName: b.fullName,
        email: b.email,
        phone: b.phone,
      });
      const clientId = clientRes.data.id;

      let developerId = null;
      let projectId = null;
      let unitId = null;
      let agentId = null;

      try {
        if (b.developer && b.developer !== 'Not specified') {
          const dev = await upsertDeveloper(b.developer);
          developerId = dev?.id || null;
        }

        const project = await findOrCreateProject({
          name: b.projectName,
          area: b.areaCommunity,
          developerId,
        });
        projectId = project?.id || null;

        const unit = await insertUnit({
          unitNo: b.unitNumber,
          type: b.propertyType,
          beds: b.bedroomTier,
          developer: developerId || (b.developer !== 'Not specified' ? b.developer : null),
          project: projectId || b.projectName,
          dewaActive: b.dewaConnected,
          accessNotes: b.accessInstructions,
        });
        unitId = unit?.id || null;

        if (b.agentName) {
          const agent = await findOrCreateAgent({
            fullName: b.agentName,
            agency: b.agentAgency,
            email: b.agentEmail,
            phone: b.agentPhone,
          });
          agentId = agent?.id || null;
        }
      } catch (normErr) {
        normWarning = normErr.message;
        console.warn('Normalized property/agent sync warning:', normErr.message);
      }

      try {
        const report = await insertReport({
          clientId,
          unitId,
          agentId,
          reportType: b.inspectionPurpose || 'Handover',
          status: 'pending',
          ref: b.bookingReference,
        });
        reportId = report?.id || null;
      } catch (repErr) {
        reportWarning = repErr.message;
        console.warn('Report creation warning:', repErr.message);
      }

      const summaryNotes = [
        `Package: ${b.packageLabel} (${b.priceAed} AED)`,
        `Purpose: ${b.inspectionPurpose}`,
        b.notes,
      ]
        .filter(Boolean)
        .join(' | ');

      const bookingRes = await insertBooking({
        booking_reference: b.bookingReference,
        client_id: clientId,
        unit_id: unitId,
        agent_id: agentId,
        report_id: reportId,
        status: 'confirmed',
        scheduled_date: b.scheduledStart.slice(0, 10),
        scheduled_start: b.scheduledStart,
        scheduled_end: b.scheduledEnd,
        timezone: 'Asia/Dubai',
        cal_event_type_id: b.calEventTypeId,
        cal_booking_id: calBookingId,
        cal_booking_uid: calBookingUid,
        terms_accepted: true,
        terms_accepted_at: b.termsAcceptedAt,
        notes: summaryNotes,
      });

      await insertPayment({
        booking_id: bookingRes.data.id,
        client_id: clientId,
        report_id: null,
        provider: 'ziina',
        ziina_payment_intent_id: b.intentId,
        total: b.priceAed,
        amount_aed: b.priceAed,
        amount_fils: b.amountFils,
        currency: 'AED',
        status: 'paid',
        is_test: Boolean(ziinaData?.is_test),
        checkout_url: ziinaData?.redirect_url || null,
        paid_at: new Date().toISOString(),
        raw_response: ziinaData,
      });

      if (reportId) {
        try {
          await updatePaymentByIntentId(b.intentId, { report_id: reportId });
        } catch (payRepErr) {
          console.warn('Payment report_id link warning:', payRepErr.message);
        }
      }

      supabaseSynced = true;
    }

    // 4. Send confirmation emails via Resend
    const emailHtml = buildConfirmationHtml(b, ziinaData?.is_test ? 'Paid (Test Mode)' : 'Paid');
    const customerEmailResult = await sendResendEmail({
      to: b.email,
      subject: `Vantage North Booking Confirmed — ${b.bookingReference}`,
      html: emailHtml,
    });

    const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
    if (adminEmail && adminEmail.toLowerCase() !== b.email.toLowerCase()) {
      await sendResendEmail({
        to: adminEmail,
        subject: `[New Paid Booking] ${b.bookingReference} — ${b.projectName} (${b.priceAed} AED)`,
        html: emailHtml,
      });
    }

    return res.status(200).json({
      confirmed: true,
      booking: {
        ...b,
        status: 'confirmed',
        calBookingId,
        calBookingUid,
        reportId,
      },
      isTest: Boolean(ziinaData?.is_test),
      supabaseSynced,
      calWarning,
      normWarning,
      reportWarning,
      emailResult: customerEmailResult,
    });
  } catch (err) {
    console.error('Error in /api/confirm-booking:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
