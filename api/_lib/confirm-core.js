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
  deleteCheckoutHold,
  claimCheckoutHold,
} = require('./supabase');

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

function buildItemizedRowsHtml(b) {
  const pb = b.pricingBreakdown;
  if (!pb) {
    return `<tr><td style="padding:6px 0; color:#646464;">${b.packageLabel}</td><td style="padding:6px 0; text-align:right;">${Number(b.priceAed).toLocaleString()} AED</td></tr>`;
  }
  const rows = [
    `<tr><td style="padding:4px 0; color:#646464;">Base Inspection (${b.propertyType})</td><td style="padding:4px 0; text-align:right;">${Number(pb.baseRateAed).toLocaleString()} AED</td></tr>`,
  ];
  if (pb.extraBedrooms > 0) {
    rows.push(`<tr><td style="padding:4px 0; color:#646464;">Extra Bedrooms (${pb.extraBedrooms} × 350 AED)</td><td style="padding:4px 0; text-align:right;">${Number(pb.extraBedroomAed).toLocaleString()} AED</td></tr>`);
  }
  if (pb.extraBathrooms > 0) {
    rows.push(`<tr><td style="padding:4px 0; color:#646464;">Extra Bathrooms (${pb.extraBathrooms} × 500 AED)</td><td style="padding:4px 0; text-align:right;">${Number(pb.extraBathroomAed).toLocaleString()} AED</td></tr>`);
  }
  if (pb.followupAddonAed > 0) {
    rows.push(`<tr><td style="padding:4px 0; color:#646464;">Developer Follow-Up</td><td style="padding:4px 0; text-align:right;">${Number(pb.followupAddonAed).toLocaleString()} AED</td></tr>`);
  }
  if (pb.finalAddonAed > 0) {
    rows.push(`<tr><td style="padding:4px 0; color:#646464;">Final Handover Inspection</td><td style="padding:4px 0; text-align:right;">${Number(pb.finalAddonAed).toLocaleString()} AED</td></tr>`);
  }
  if (pb.bundleDiscountAed > 0) {
    rows.push(`<tr><td style="padding:4px 0; color:#047857;">Full Package Discount (10%)</td><td style="padding:4px 0; text-align:right; color:#047857;">−${Number(pb.bundleDiscountAed).toLocaleString()} AED</td></tr>`);
  }
  return rows.join('');
}

function buildConfirmationHtml(b, paymentStatus, calBookingUid, calCollision) {
  const dubaiTime = formatDubaiTime(b.scheduledStart);
  const collisionBanner = calCollision
    ? `
      <div style="margin:0 0 20px; padding:14px 16px; background:#FEF3C7; border:1px solid #F59E0B; border-radius:8px; font-size:13px; color:#92400E;">
        <strong>Schedule Notice:</strong> Your payment succeeded, but your selected time slot was reserved by another client moments earlier. Our team will contact you shortly (or WhatsApp <strong>+971 58 556 5311</strong>) to confirm an alternate time at no extra cost.
      </div>`
    : '';
  const manageButtons = calBookingUid
    ? `
      <div style="margin:24px 0 0; padding-top:20px; border-top:1px solid #E5E5E5;">
        <a href="https://cal.com/reschedule/${encodeURIComponent(calBookingUid)}" style="display:inline-block; background:#000000; color:#FFFFFF; text-decoration:none; font-size:13px; font-weight:600; padding:11px 20px; border-radius:8px; margin-right:10px;">Reschedule</a>
        <a href="https://cal.com/booking/${encodeURIComponent(calBookingUid)}?cancel=true" style="display:inline-block; background:#FFFFFF; color:#2B2B2B; text-decoration:none; font-size:13px; font-weight:600; padding:10px 20px; border-radius:8px; border:1px solid #D4D4D4;">Cancel</a>
      </div>`
    : '';
  return `
  <div style="font-family: 'Helvetica Neue', Arial, sans-serif; background:#FAFAFA; padding:32px 16px; color:#000000;">
    <div style="max-width:600px; margin:0 auto; background:#FFFFFF; border:1px solid #E5E5E5; border-radius:12px; padding:32px;">
      <img src="https://vantagenorth.ae/logo/vantage_north_logo_email_footer.png" alt="Vantage North" style="height:28px; width:auto; display:block; margin-bottom:20px;">
      <p style="font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#646464; margin:0 0 8px;">Vantage North — Booking Confirmed &amp; Payment Receipt</p>
      <h1 style="font-size:24px; margin:0 0 16px; font-weight:600;">Your Property Inspection is Booked</h1>
      <p style="font-size:15px; line-height:1.6; color:#2B2B2B; margin:0 0 20px;">
        Hi ${b.fullName}, thank you for booking with Vantage North. Your payment has been confirmed and your receipt is below.
      </p>
      ${collisionBanner}
      <div style="background:#FAFAFA; border:1px solid #E5E5E5; border-radius:8px; padding:20px; margin-bottom:20px;">
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <tr><td style="padding:6px 0; color:#646464;">Booking Reference</td><td style="padding:6px 0; text-align:right; font-weight:600;">${b.bookingReference}</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Payment ID</td><td style="padding:6px 0; text-align:right; font-size:12px; color:#646464;">${b.intentId}</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Inspection Date &amp; Time</td><td style="padding:6px 0; text-align:right; font-weight:600;">${dubaiTime} (Dubai)</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Property</td><td style="padding:6px 0; text-align:right;">${b.propertyType} — ${b.bedroomTier}</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Unit / Project</td><td style="padding:6px 0; text-align:right;">${b.unitNumber}, ${b.projectName} (${b.areaCommunity})</td></tr>
          <tr><td style="padding:6px 0; color:#646464;">Purpose</td><td style="padding:6px 0; text-align:right;">${b.inspectionPurpose}</td></tr>
        </table>
      </div>

      <div style="background:#FAFAFA; border:1px solid #E5E5E5; border-radius:8px; padding:20px; margin-bottom:24px;">
        <p style="font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:#646464; margin:0 0 10px; font-weight:600;">Itemized Receipt</p>
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          ${buildItemizedRowsHtml(b)}
          <tr><td style="padding:10px 0 0; border-top:1px solid #E5E5E5; font-weight:600;">Total Paid</td><td style="padding:10px 0 0; border-top:1px solid #E5E5E5; text-align:right; font-weight:600;">${Number(b.priceAed).toLocaleString()} AED (${paymentStatus})</td></tr>
        </table>
      </div>

      <p style="font-size:13px; line-height:1.6; color:#646464; margin:0 0 16px;">
        Please ensure DEWA (electricity &amp; water) and site access are arranged prior to the inspection. Your interactive digital report will be delivered within 24 hours of inspection completion.
      </p>
      <p style="font-size:13px; color:#646464; margin:0 0 16px;">
        Questions? Reply to this email or WhatsApp us on <strong>+971 58 556 5311</strong>.
      </p>
      <p style="font-size:11px; color:#888888; margin:0;">
        Issued by <strong>Al Marsad Property Observer L.L.C S.O.C</strong> trading as <strong>Vantage North</strong> · Dubai, UAE
      </p>
      ${manageButtons}
    </div>
  </div>`;
}

async function finalizeBooking({ bookingReference, paymentIntentId, tokenData, ziinaData }) {
  // 1. Idempotency check if booking already persisted in Supabase
  let existingBooking = null;
  if (isSupabaseConfigured()) {
    const dbRes = await getBookingByReference(bookingReference);
    existingBooking = dbRes.data;
  }

  if (existingBooking && (existingBooking.status === 'confirmed' || existingBooking.status === 'needs_reschedule')) {
    return {
      alreadyConfirmed: true,
      booking: {
        bookingReference: existingBooking.booking_reference,
        status: existingBooking.status,
        propertyType: tokenData?.propertyType || 'Property',
        bedroomTier: tokenData?.bedroomTier || '',
        packageLabel: tokenData?.packageLabel || 'Initial Inspection',
        priceAed: tokenData?.priceAed || existingBooking.payments?.[0]?.amount_aed || 0,
        pricingBreakdown: tokenData?.pricingBreakdown || null,
        scheduledStart: existingBooking.scheduled_start,
        scheduledEnd: existingBooking.scheduled_end,
        fullName: existingBooking.clients?.name || tokenData?.fullName,
        email: existingBooking.clients?.email || tokenData?.email,
        projectName: tokenData?.projectName || 'Dubai Property',
        areaCommunity: tokenData?.areaCommunity || 'Dubai',
        unitNumber: tokenData?.unitNumber || 'TBD',
        inspectionPurpose: tokenData?.inspectionPurpose || 'Handover',
        calBookingUid: existingBooking.cal_booking_uid || null,
        intentId: existingBooking.payments?.[0]?.ziina_payment_intent_id || paymentIntentId,
      },
      supabaseSynced: true,
    };
  }

  // Atomic lock: ensure webhook and redirect don't both run finalizeBooking simultaneously
  const claim = await claimCheckoutHold(bookingReference);
  if (claim.available && !claim.claimed) {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const retryDb = await getBookingByReference(bookingReference);
      const found = retryDb.data;
      if (found && (found.status === 'confirmed' || found.status === 'needs_reschedule')) {
        return {
          alreadyConfirmed: true,
          booking: {
            bookingReference: found.booking_reference,
            status: found.status,
            propertyType: tokenData?.propertyType || 'Property',
            bedroomTier: tokenData?.bedroomTier || '',
            packageLabel: tokenData?.packageLabel || 'Initial Inspection',
            priceAed: tokenData?.priceAed || found.payments?.[0]?.amount_aed || 0,
            pricingBreakdown: tokenData?.pricingBreakdown || null,
            scheduledStart: found.scheduled_start,
            scheduledEnd: found.scheduled_end,
            fullName: found.clients?.name || tokenData?.fullName,
            email: found.clients?.email || tokenData?.email,
            projectName: tokenData?.projectName || 'Dubai Property',
            areaCommunity: tokenData?.areaCommunity || 'Dubai',
            unitNumber: tokenData?.unitNumber || 'TBD',
            inspectionPurpose: tokenData?.inspectionPurpose || 'Handover',
            calBookingUid: found.cal_booking_uid || null,
            calCollision: found.status === 'needs_reschedule',
            intentId: found.payments?.[0]?.ziina_payment_intent_id || paymentIntentId,
          },
          supabaseSynced: true,
        };
      }
    }
  }

  const b = { ...tokenData, intentId: paymentIntentId };

  // 2. Cal.com booking creation (with UTC start, E.164 phone, and collision detection)
  let calBookingId = null;
  let calBookingUid = null;
  let calWarning = null;
  let calCollision = false;
  const calApiKey = process.env.CAL_API_KEY;
  if (calApiKey && b.calEventTypeId) {
    const startUtc = new Date(b.scheduledStart).toISOString();
    let cleanPhone = (b.phone || '').replace(/[^\d+]/g, '');
    if (cleanPhone.startsWith('00')) cleanPhone = '+' + cleanPhone.slice(2);
    else if (/^05\d{8}$/.test(cleanPhone)) cleanPhone = '+971' + cleanPhone.slice(1);
    else if (/^971\d{8,9}$/.test(cleanPhone)) cleanPhone = '+' + cleanPhone;
    const validE164 = /^\+\d{8,15}$/.test(cleanPhone) ? cleanPhone : null;

    const baseCalPayload = {
      start: startUtc,
      eventTypeId: Number(b.calEventTypeId),
      attendee: {
        name: b.fullName,
        email: b.email,
        timeZone: 'Asia/Dubai',
        ...(validE164 ? { phoneNumber: validE164 } : {}),
      },
      metadata: {
        bookingReference: b.bookingReference,
        packageType: b.packageType,
        propertyType: b.propertyType,
        bedroomTier: b.bedroomTier,
        projectName: b.projectName,
        areaCommunity: b.areaCommunity,
      },
    };

    const fullCalPayload = {
      ...baseCalPayload,
      bookingFieldsResponses: {
        notes: [
          `Ref: ${b.bookingReference}`,
          `Property: ${b.propertyType} — ${b.bedroomTier}`,
          `Unit: ${b.unitNumber || 'TBD'}, ${b.projectName || ''}, ${b.areaCommunity || 'Dubai'}`,
          `Package: ${b.packageLabel} (${b.priceAed} AED)`,
          `Purpose: ${b.inspectionPurpose || 'Handover'}`,
          `DEWA On: ${b.dewaConnected ? 'Yes' : 'No'}`,
          `Developer: ${b.developer || 'Not specified'}`,
          `Access: ${b.accessInstructions || 'N/A'}`,
        ].join(' | '),
      },
    };

    const calHeaders = {
      Authorization: `Bearer ${calApiKey}`,
      'cal-api-version': '2024-08-13',
      'Content-Type': 'application/json',
      'User-Agent': 'VantageNorthBooking/1.0',
    };

    try {
      let calRes = await fetch('https://api.cal.com/v2/bookings', {
        method: 'POST',
        headers: calHeaders,
        body: JSON.stringify(fullCalPayload),
      });
      let calJson = await calRes.json();

      if (!calRes.ok || !calJson.data) {
        const minimalPayload = {
          ...baseCalPayload,
          attendee: { name: b.fullName, email: b.email, timeZone: 'Asia/Dubai' },
        };
        calRes = await fetch('https://api.cal.com/v2/bookings', {
          method: 'POST',
          headers: calHeaders,
          body: JSON.stringify(minimalPayload),
        });
        calJson = await calRes.json();
      }

      if (calRes.ok && calJson.data) {
        calBookingId = calJson.data.id || null;
        calBookingUid = calJson.data.uid || null;
      } else {
        calWarning = calJson?.error?.message || JSON.stringify(calJson);
        const msg = String(calWarning).toLowerCase();
        if (calRes.status === 409 || msg.includes('already') || msg.includes('not available') || msg.includes('busy')) {
          try {
            const existingCalRes = await fetch(
              `https://api.cal.com/v2/bookings?attendeeEmail=${encodeURIComponent(b.email)}&take=5`,
              { headers: calHeaders }
            );
            const existingCalJson = await existingCalRes.json();
            const match = (existingCalJson?.data || []).find(
              (cb) => cb.start && new Date(cb.start).getTime() === new Date(startUtc).getTime() && cb.status !== 'cancelled'
            );
            if (match) {
              calBookingId = match.id || null;
              calBookingUid = match.uid || null;
              calWarning = null;
            } else {
              calCollision = true;
            }
          } catch {
            calCollision = true;
          }
        }
      }
    } catch (calErr) {
      calWarning = calErr.message;
    }
  }

  const bookingStatus = calCollision ? 'needs_reschedule' : 'confirmed';

  // 3. Create all Supabase records ONLY now that payment is verified
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
        beds: b.bedrooms ?? b.bedroomTier,
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
        status: 'draft',
      });
      reportId = report?.id || null;
    } catch (repErr) {
      reportWarning = repErr.message;
      console.warn('Report creation warning:', repErr.message);
    }

    const summaryNotes = [
      `Package: ${b.packageLabel} (${b.priceAed} AED)`,
      `Purpose: ${b.inspectionPurpose}`,
      calCollision ? 'CAL_COLLISION: Slot taken during checkout — needs reschedule' : null,
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
      status: bookingStatus,
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

    await deleteCheckoutHold(b.bookingReference);
    supabaseSynced = true;
  }

  // 4. Send confirmation / receipt email via Resend
  const emailHtml = buildConfirmationHtml(
    b,
    ziinaData?.is_test ? 'Paid (Test Mode)' : 'Paid',
    calBookingUid,
    calCollision
  );
  const customerEmailResult = await sendResendEmail({
    to: b.email,
    subject: calCollision
      ? `Vantage North Payment Received — Reschedule Needed (${b.bookingReference})`
      : `Vantage North Booking Confirmed & Receipt — ${b.bookingReference}`,
    html: emailHtml,
  });

  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (adminEmail && adminEmail.toLowerCase() !== b.email.toLowerCase()) {
    await sendResendEmail({
      to: adminEmail,
      subject: calCollision
        ? `[ACTION REQUIRED: Slot Collision] ${b.bookingReference} — ${b.projectName}`
        : `[New Paid Booking] ${b.bookingReference} — ${b.projectName} (${b.priceAed} AED)`,
      html: emailHtml,
    });
  }

  return {
    confirmed: true,
    booking: {
      ...b,
      status: bookingStatus,
      calBookingId,
      calBookingUid,
      calCollision,
      reportId,
    },
    isTest: Boolean(ziinaData?.is_test),
    supabaseSynced,
    calWarning,
    normWarning,
    reportWarning,
    emailResult: customerEmailResult,
  };
}

module.exports = {
  finalizeBooking,
};
