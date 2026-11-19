module.exports = async function handler(req, res) {
  const baseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  const baseInfo = {
    vercelEnv: process.env.VERCEL_ENV || null,
    hasZiinaKey: Boolean(process.env.ZIINA_API_KEY),
    ziinaTestMode: process.env.ZIINA_TEST_MODE || null,
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
    hasSupabaseUrl: Boolean(baseUrl),
    hasSupabaseServiceKey: Boolean(serviceKey),
    hasCalKey: Boolean(process.env.CAL_API_KEY),
  };

  if (req.query?.schema === '1' && baseUrl && serviceKey) {
    try {
      const specRes = await fetch(`${baseUrl.replace(/\/+$/, '')}/rest/v1/`, {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      });
      const spec = await specRes.json();
      const tables = {};
      if (spec?.definitions) {
        for (const [tableName, def] of Object.entries(spec.definitions)) {
          tables[tableName] = Object.keys(def.properties || {});
        }
      }
      return res.status(200).json({ ...baseInfo, tables });
    } catch (err) {
      return res.status(200).json({ ...baseInfo, schemaError: err.message });
    }
  }

  return res.status(200).json(baseInfo);
};
