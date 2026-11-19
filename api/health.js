module.exports = async function handler(req, res) {
  const baseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (req.query?.reports_meta === '1' && baseUrl && serviceKey) {
    try {
      const headers = {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      };
      const [schemaRes, rowsRes] = await Promise.all([
        fetch(`${baseUrl.replace(/\/$/, '')}/rest/v1/`, { headers }),
        fetch(`${baseUrl.replace(/\/$/, '')}/rest/v1/reports?select=report_type,status,report_outcome&limit=10`, { headers }),
      ]);
      const schemaJson = await schemaRes.json();
      const rowsJson = await rowsRes.json();
      return res.status(200).json({
        reportsDefinition: schemaJson?.definitions?.reports || null,
        sampleValues: Array.isArray(rowsJson) ? rowsJson : rowsJson,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(200).json({
    vercelEnv: process.env.VERCEL_ENV || null,
    hasZiinaKey: Boolean(process.env.ZIINA_API_KEY),
    ziinaTestMode: process.env.ZIINA_TEST_MODE || null,
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
    hasSupabaseUrl: Boolean(baseUrl),
    hasSupabaseServiceKey: Boolean(serviceKey),
    hasCalKey: Boolean(process.env.CAL_API_KEY),
  });
};
