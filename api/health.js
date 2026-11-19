module.exports = function handler(req, res) {
  res.status(200).json({
    vercelEnv: process.env.VERCEL_ENV || null,
    hasZiinaKey: Boolean(process.env.ZIINA_API_KEY),
    ziinaTestMode: process.env.ZIINA_TEST_MODE || null,
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
    hasSupabaseUrl: Boolean(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
    hasSupabaseServiceKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    hasCalKey: Boolean(process.env.CAL_API_KEY),
  });
};
