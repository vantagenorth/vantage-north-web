const { normalizeReportReason } = require('./_lib/report-reasons');
const { isSupabaseConfigured, upsertClient, insertBooking } = require('./_lib/supabase');

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const {
      propertyType = 'Villa',
      bedroomTier,
      buaSqft,
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
      inspectionPurpose: rawReason,
      accessInstructions,
      agentName,
      agentAgency,
      agentEmail,
      agentPhone,
      notes,
      termsAccepted,
    } = body;
    const inspectionPurpose = normalizeReportReason(rawReason);

    if (!termsAccepted) {
      return res.status(400).json({ error: 'You must accept the Vantage North Terms of Service.' });
    }
    if (!fullName || !email || !phone || !projectName || !areaCommunity || !unitNumber) {
      return res.status(400).json({ error: 'Please complete all required personal and property fields.' });
    }

    const bookingReference = `VN-LUX-${Date.now().toString(36).toUpperCase()}`;

    let supabaseSynced = false;
    if (isSupabaseConfigured()) {
      const clientRes = await upsertClient({
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
      });

      await insertBooking({
        booking_reference: bookingReference,
        client_id: clientRes.data.id,
        status: 'quote_requested',
        timezone: 'Asia/Dubai',
        terms_accepted: true,
        terms_accepted_at: new Date().toISOString(),
        notes: notes
          ? notes.trim()
          : `Luxury Villa (${bedroomTier || 'Custom'}${buaSqft ? `, ${buaSqft} sq ft` : ''}) — ${unitNumber}, ${projectName}, ${areaCommunity} | Reason for report: ${inspectionPurpose}`,
      });
      supabaseSynced = true;
    }

    const html = `
      <div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#FAFAFA;padding:32px 16px;color:#000;">
        <div style="max-width:600px;margin:0 auto;background:#FFF;border:1px solid #E5E5E5;border-radius:12px;padding:32px;">
          <img src="https://vantagenorth.ae/logo/vantage_north_logo_email_footer.png" alt="Vantage North" style="height:28px;width:auto;display:block;margin-bottom:20px;">
          <p style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#646464;margin:0 0 8px;">Vantage North — Luxury Home Quote Request</p>
          <h1 style="font-size:24px;margin:0 0 16px;font-weight:600;">We've Received Your Custom Inspection Request</h1>
          <p style="font-size:15px;line-height:1.6;color:#2B2B2B;margin:0 0 20px;">
            Hi ${fullName}, thank you for contacting Vantage North. Because your home is a luxury property, is over 5,000 sq ft or has 6 or more bedrooms, our senior inspection team will prepare a tailored scope and quote within 2 business hours.
          </p>
          <div style="background:#FAFAFA;border:1px solid #E5E5E5;border-radius:8px;padding:16px;font-size:14px;">
            <p style="margin:4px 0;"><strong>Reference:</strong> ${bookingReference}</p>
            <p style="margin:4px 0;"><strong>Property:</strong> ${propertyType} (${bedroomTier || 'Custom'}${buaSqft ? `, ${buaSqft} sq ft` : ''})</p>
            <p style="margin:4px 0;"><strong>Location:</strong> ${unitNumber}, ${projectName}, ${areaCommunity}</p>
            <p style="margin:4px 0;"><strong>Reason for report:</strong> ${inspectionPurpose}</p>
          </div>
          <p style="font-size:13px;color:#646464;margin:20px 0 0;">Need immediate assistance? WhatsApp us on <strong>+971 58 556 5311</strong>.</p>
        </div>
      </div>`;

    const emailResult = await sendResendEmail({
      to: email.trim().toLowerCase(),
      subject: `Vantage North Luxury Home Quote Request — ${bookingReference}`,
      html,
    });

    const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
    if (adminEmail && adminEmail.toLowerCase() !== email.trim().toLowerCase()) {
      await sendResendEmail({
        to: adminEmail,
        subject: `[Luxury Quote Request] ${bookingReference} — ${projectName} (${buaSqft || 'N/A'} sq ft)`,
        html,
      });
    }

    return res.status(200).json({
      ok: true,
      bookingReference,
      supabaseSynced,
      emailResult,
    });
  } catch (err) {
    console.error('Error in /api/luxury-inquiry:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
