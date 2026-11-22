const crypto = require('crypto');
const {
  getCheckoutHoldByIntentId,
  updateCheckoutHoldStatus,
} = require('./_lib/supabase');
const { finalizeBooking } = require('./_lib/confirm-core');
const { logPaymentEvent, ziinaSummary, errorMessageOf } = require('./_lib/payment-log');

const ZIINA_WEBHOOK_IPS = new Set([
  '3.29.184.186',
  '3.29.190.95',
  '20.233.47.127',
  '13.202.161.181',
]);

function verifyHmac(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let intentId = null;
  let bookingReference = null;
  const sourceIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
  try {
    if (process.env.ZIINA_ENFORCE_WEBHOOK_IPS === 'true') {
      const forwarded = sourceIp;
      if (forwarded && !ZIINA_WEBHOOK_IPS.has(forwarded)) {
        await logPaymentEvent({
          source: 'ziina_webhook',
          event: 'webhook.rejected_ip',
          level: 'warn',
          httpStatus: 403,
          details: { source_ip: forwarded },
        });
        return res.status(403).json({ error: 'Untrusted webhook source IP' });
      }
    }

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const webhookSecret = process.env.ZIINA_WEBHOOK_SECRET;
    const sigHeader = req.headers['x-hmac-signature'];
    if (webhookSecret && !verifyHmac(rawBody, sigHeader, webhookSecret)) {
      await logPaymentEvent({
        source: 'ziina_webhook',
        event: 'webhook.rejected_signature',
        level: 'warn',
        httpStatus: 401,
        details: { source_ip: sourceIp, has_signature: Boolean(sigHeader) },
      });
      return res.status(401).json({ error: 'Invalid Ziina webhook signature' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    intentId = body?.data?.id || body?.id || body?.payment_intent_id || null;
    await logPaymentEvent({
      source: 'ziina_webhook',
      event: 'webhook.received',
      intentId,
      ziinaStatus: body?.data?.status || body?.status || null,
      details: {
        event: body?.event || body?.type || null,
        source_ip: sourceIp,
        signature_checked: Boolean(webhookSecret),
      },
    });
    if (!intentId) {
      await logPaymentEvent({
        source: 'ziina_webhook',
        event: 'webhook.missing_intent_id',
        level: 'warn',
        httpStatus: 400,
      });
      return res.status(400).json({ error: 'Missing payment intent id' });
    }

    const ziinaKey = process.env.ZIINA_API_KEY;
    if (!ziinaKey) {
      return res.status(500).json({ error: 'ZIINA_API_KEY not configured' });
    }

    // Re-verify directly with Ziina API
    const ziinaRes = await fetch(`https://api-v2.ziina.com/api/payment_intent/${encodeURIComponent(intentId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ziinaKey}` },
    });
    const ziinaData = await ziinaRes.json().catch(() => ({}));
    if (!ziinaRes.ok) {
      await logPaymentEvent({
        source: 'ziina_webhook',
        event: 'ziina.verify_failed',
        level: 'error',
        intentId,
        httpStatus: ziinaRes.status,
        message: ziinaData?.message || 'Ziina payment intent lookup failed',
        details: { ziina: ziinaSummary(ziinaData) },
      });
      return res.status(ziinaRes.status).json({ error: 'Failed to verify payment intent', details: ziinaData });
    }

    const hold = await getCheckoutHoldByIntentId(intentId);
    bookingReference = hold?.booking_reference || null;

    await logPaymentEvent({
      source: 'ziina_webhook',
      event: 'ziina.verified',
      bookingReference,
      intentId,
      httpStatus: ziinaRes.status,
      ziinaStatus: ziinaData.status,
      details: { ziina: ziinaSummary(ziinaData), hold_status: hold?.status || null },
    });

    if (ziinaData.status === 'completed') {
      if (!hold || !hold.payload) {
        // Paid, but there is no checkout hold to build the booking from. The
        // redirect page may still confirm it; the health check alerts if no
        // payment record appears.
        await logPaymentEvent({
          source: 'ziina_webhook',
          event: 'webhook.completed_no_hold',
          level: 'warn',
          intentId,
          ziinaStatus: ziinaData.status,
          message: 'Payment completed but no checkout hold was found for this payment intent',
          details: { ziina: ziinaSummary(ziinaData) },
        });
        return res.status(200).json({
          ok: true,
          status: ziinaData.status,
          note: 'No checkout_hold found for intentId; confirmation handled via redirect or table not yet created.',
        });
      }

      const result = await finalizeBooking({
        bookingReference: hold.booking_reference,
        paymentIntentId: intentId,
        tokenData: hold.payload,
        ziinaData,
        trigger: 'webhook',
      });

      return res.status(200).json({
        ok: true,
        status: ziinaData.status,
        bookingReference: hold.booking_reference,
        alreadyConfirmed: Boolean(result.alreadyConfirmed),
      });
    }

    if (ziinaData.status === 'failed' || ziinaData.status === 'canceled') {
      if (hold?.booking_reference) {
        await updateCheckoutHoldStatus(hold.booking_reference, 'expired');
      }
    }

    return res.status(200).json({ ok: true, status: ziinaData.status });
  } catch (err) {
    console.error('Error in /api/ziina-webhook:', err);
    await logPaymentEvent({
      source: 'ziina_webhook',
      event: 'webhook.exception',
      level: 'error',
      bookingReference,
      intentId,
      message: errorMessageOf(err),
    });
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
