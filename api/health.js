module.exports = function handler(req, res) {
  const baseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  return res.status(200).json({
    vercelEnv: process.env.VERCEL_ENV || null,
    hasZiinaKey: Boolean(process.env.ZIINA_API_KEY),
    ziinaTestMode: process.env.ZIINA_TEST_MODE || null,
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
    hasSupabaseUrl: Boolean(baseUrl),
    hasSupabaseServiceKey: Boolean(serviceKey),
    hasGoogleCalendar: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    hasZiinaWebhookSecret: Boolean(process.env.ZIINA_WEBHOOK_SECRET),
    hasCronSecret: Boolean(process.env.CRON_SECRET),
  });
};
