const { getSiteUrl } = require('./_lib/config');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const intentId = req.query?.intent_id;
    if (!intentId) {
      return res.status(400).json({ error: 'Missing intent_id' });
    }
    const ziinaKey = process.env.ZIINA_API_KEY;
    if (!ziinaKey) {
      return res.status(500).json({ error: 'ZIINA_API_KEY is not configured on the server' });
    }
    try {
      const ziinaRes = await fetch(`https://api-v2.ziina.com/api/payment_intent/${encodeURIComponent(intentId)}`, {
        headers: { Authorization: `Bearer ${ziinaKey}` },
      });
      const data = await ziinaRes.json();
      return res.status(ziinaRes.status).json({
        id: data.id,
        status: data.status,
        amount: data.amount,
        currency_code: data.currency_code,
        test: data.test,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to verify Ziina payment intent' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const ziinaKey = process.env.ZIINA_API_KEY;
    if (!ziinaKey) {
      return res.status(500).json({ error: 'ZIINA_API_KEY is not configured on the server' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const rawAed = Number(body.amountAed ?? 2);
    const amountAed = Number.isFinite(rawAed) ? Math.min(25, Math.max(2, Math.round(rawAed))) : 2;
    const amountFils = amountAed * 100;
    const isTest = body.testMode === true || process.env.ZIINA_TEST_MODE === 'true';

    const ref = `VN-TEST-${Date.now().toString(36).toUpperCase()}`;
    const siteUrl = getSiteUrl(req);
    const successUrl = `${siteUrl}/booking-test?status=success&ref=${encodeURIComponent(ref)}&intent_id={PAYMENT_INTENT_ID}`;
    const cancelUrl = `${siteUrl}/booking-test?status=cancelled&ref=${encodeURIComponent(ref)}`;

    const ziinaRes = await fetch('https://api-v2.ziina.com/api/payment_intent', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ziinaKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountFils,
        currency_code: 'AED',
        message: `Vantage North Test ${ref}`,
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

    return res.status(200).json({
      redirectUrl: ziinaData.redirect_url,
      paymentIntentId: ziinaData.id,
      bookingReference: ref,
      amountAed,
      test: isTest,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
