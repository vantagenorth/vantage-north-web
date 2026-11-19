const {
  isSupabaseConfigured,
  getPaymentByIntentId,
  updatePaymentByIntentId,
  updateBookingByReference,
  insertReport,
} = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const intentId = body?.data?.id || body?.id || body?.payment_intent_id;
    if (!intentId) {
      return res.status(400).json({ error: 'Missing payment intent id' });
    }

    const ziinaKey = process.env.ZIINA_API_KEY;
    if (!ziinaKey) {
      return res.status(500).json({ error: 'ZIINA_API_KEY not configured' });
    }

    // Verify directly with Ziina API so we never trust unverified webhook payloads
    const ziinaRes = await fetch(`https://api-v2.ziina.com/api/payment_intent/${encodeURIComponent(intentId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ziinaKey}` },
    });
    const ziinaData = await ziinaRes.json();
    if (!ziinaRes.ok) {
      return res.status(ziinaRes.status).json({ error: 'Failed to verify payment intent', details: ziinaData });
    }

    if (!isSupabaseConfigured()) {
      return res.status(200).json({ ok: true, status: ziinaData.status, supabaseSynced: false });
    }

    if (ziinaData.status === 'completed') {
      const paymentRow = await getPaymentByIntentId(intentId);
      const booking = paymentRow?.bookings;
      let reportId = booking?.report_id || null;

      if (booking && !reportId) {
        try {
          const report = await insertReport({
            clientId: booking.client_id,
            unitId: booking.unit_id,
            agentId: booking.agent_id,
            reportType: 'Handover',
            status: 'pending',
            ref: booking.booking_reference,
          });
          reportId = report?.id || null;
        } catch (e) {
          console.warn('Webhook report creation warning:', e.message);
        }
      }

      await updatePaymentByIntentId(intentId, {
        status: 'paid',
        paid_at: new Date().toISOString(),
        raw_response: ziinaData,
        ...(reportId ? { report_id: reportId } : {}),
      });

      if (booking && booking.status !== 'confirmed') {
        await updateBookingByReference(booking.booking_reference, {
          status: 'confirmed',
          ...(reportId ? { report_id: reportId } : {}),
        });
      }
    } else if (ziinaData.status === 'failed' || ziinaData.status === 'canceled') {
      await updatePaymentByIntentId(intentId, {
        status: ziinaData.status === 'canceled' ? 'cancelled' : 'failed',
        raw_response: ziinaData,
      });
    }

    return res.status(200).json({ ok: true, status: ziinaData.status });
  } catch (err) {
    console.error('Error in /api/ziina-webhook:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
