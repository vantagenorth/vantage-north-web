const crypto = require('crypto');
const { supabaseFetch, isSupabaseConfigured } = require('./_lib/supabase');

// One function for both jobs (Vercel Hobby allows 12 functions and we're at the limit):
//
//   GET /api/project-suggest?q=cre
//     Up to 3 projects (id, name, area, developer) matching what the client typed, from our
//     saved projects and our copy of Reelly's Dubai list. The booking form prefills area and
//     developer from the pick. id is null for Reelly-only projects.
//
//   GET /api/project-suggest?action=reelly-import   (daily Vercel cron, needs CRON_SECRET)
//     Copies Reelly's Dubai projects into reelly_projects. Needs REELLY_API_KEY in Vercel.
//     Picks up where it left off if a run runs out of time.

const REELLY_BASE = (process.env.REELLY_API_BASE || 'https://api-reelly.up.railway.app/api/v2/clients').replace(/\/+$/, '');
const PAGE_SIZE = 100;
const TIME_BUDGET_MS = 50 * 1000;

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = Buffer.from(String(req.headers.authorization || ''));
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const clean = (v) => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return s || null;
};

function toRow(p) {
  const loc = p.location || {};
  const dev = typeof p.developer === 'string' ? p.developer : p.developer?.name;
  return {
    reelly_id: p.id,
    name: clean(p.name),
    area: clean(loc.district) || clean(loc.sector),
    developer: clean(dev),
    construction_status: clean(p.construction_status || p.status),
    completion_date: clean(p.completion_date),
    reelly_updated_at: p.updated_at || null,
    synced_at: new Date().toISOString(),
  };
}

async function reellyPage(offset) {
  // No country/region filter: with them Reelly returned only 38 projects. We keep Dubai ones below.
  const url = `${REELLY_BASE}/projects?limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await fetch(url, { headers: { 'X-API-Key': process.env.REELLY_API_KEY, Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Reelly ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function saveState(patch) {
  await supabaseFetch('reelly_sync_state?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, last_run_at: new Date().toISOString() }),
  });
}

async function runImport(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.REELLY_API_KEY) return res.status(200).json({ skipped: 'REELLY_API_KEY is not set' });
  if (!isSupabaseConfigured()) return res.status(200).json({ skipped: 'Supabase is not configured' });

  const started = Date.now();
  const stateRes = await supabaseFetch('reelly_sync_state?id=eq.1&select=next_offset', { method: 'GET' });
  let offset = Number(stateRes.data?.[0]?.next_offset) || 0;
  let saved = 0;
  let total = null;
  let finished = false;

  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const page = await reellyPage(offset);
      const results = Array.isArray(page.results) ? page.results : [];
      total = Number.isFinite(page.count) ? page.count : total;
      // Only Dubai projects
      const rows = results
        .filter((p) => /dubai/i.test(p.location?.region || ''))
        .map(toRow)
        .filter((r) => r.reelly_id && r.name);
      if (rows.length) {
        await supabaseFetch('reelly_projects?on_conflict=reelly_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        });
        saved += rows.length;
      }
      offset += results.length;
      if (!page.next || !results.length) { finished = true; break; }
    }
    await saveState(finished
      ? { next_offset: 0, total, last_full_sync_at: new Date().toISOString(), last_error: null }
      : { next_offset: offset, total, last_error: null });
    return res.status(200).json({ saved, nextOffset: finished ? 0 : offset, total, finished });
  } catch (err) {
    console.error('reelly-import failed:', err.message);
    await saveState({ next_offset: offset, last_error: err.message.slice(0, 500) }).catch(() => {});
    return res.status(502).json({ error: err.message, saved, nextOffset: offset });
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.query?.action === 'reelly-import') return runImport(req, res);

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
        id: r.id || null,
        name: r.name,
        area: r.area || null,
        developer: r.developer || null,
      })),
    });
  } catch (err) {
    // Never block a booking because suggestions failed
    console.warn('project-suggest failed:', err.message);
    return res.status(200).json({ suggestions: [] });
  }
};
