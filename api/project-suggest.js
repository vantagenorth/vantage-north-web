const { supabaseFetch, isSupabaseConfigured } = require('./_lib/supabase');

// GET /api/project-suggest?q=cre
// Returns up to 3 saved projects (id, name, area, developer) whose name matches what the client typed,
// so the booking form can prefill area and developer and the same building isn't saved twice.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = String(req.query?.q || '').trim().slice(0, 80);
  if (q.length < 3 || !isSupabaseConfigured()) {
    return res.status(200).json({ suggestions: [] });
  }

  try {
    const result = await supabaseFetch('rpc/suggest_projects', {
      method: 'POST',
      body: JSON.stringify({ q }),
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json({
      suggestions: rows.slice(0, 3).map((r) => ({
        id: r.id,
        name: r.name,
        area: r.area || null,
        developer: r.developer || null,
      })),
    });
  } catch (err) {
    // Never block a booking because suggestions failed (e.g. migration not applied yet)
    console.warn('project-suggest failed:', err.message);
    return res.status(200).json({ suggestions: [] });
  }
};
