const { supabaseFetch, isSupabaseConfigured } = require('./_lib/supabase');

// GET /api/agent-suggest?q=ahm
// Returns up to 3 partner agents (id, name, agency) whose name matches what the client typed.
// Partners only, and only name + agency, so the agent list itself is never exposed.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = String(req.query?.q || '').trim().slice(0, 60);
  if (q.length < 3 || !isSupabaseConfigured()) {
    return res.status(200).json({ suggestions: [] });
  }

  try {
    const result = await supabaseFetch('rpc/suggest_partner_agents', {
      method: 'POST',
      body: JSON.stringify({ q }),
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json({
      suggestions: rows.slice(0, 3).map((r) => ({
        id: r.id,
        name: r.name,
        agency: r.agency_name || null,
      })),
    });
  } catch (err) {
    // Never block a booking because suggestions failed
    console.warn('agent-suggest failed:', err.message);
    return res.status(200).json({ suggestions: [] });
  }
};
