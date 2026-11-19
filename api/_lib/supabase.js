const crypto = require('crypto');

function getSupabaseUrl() {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
}

function isSupabaseConfigured() {
  return Boolean(getSupabaseUrl() && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function supabaseFetch(path, options = {}) {
  if (!isSupabaseConfigured()) {
    return { skipped: true, data: null };
  }
  const baseUrl = getSupabaseUrl().replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: getHeaders(options.headers),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Supabase error (${res.status}): ${JSON.stringify(json)}`);
  }
  return { skipped: false, data: json };
}

async function upsertClient(client) {
  if (!isSupabaseConfigured()) return { skipped: true, data: null };
  const cleanEmail = client.email.trim().toLowerCase();
  const cleanPhone = client.phone ? client.phone.trim() : '';

  // 1. Case-insensitive email lookup
  let existingRes = await supabaseFetch(
    `clients?email=ilike.${encodeURIComponent(cleanEmail)}&limit=1`,
    { method: 'GET' }
  );

  // 2. Fallback lookup by phone number if email didn't match
  if ((!Array.isArray(existingRes.data) || !existingRes.data[0]?.id) && cleanPhone) {
    existingRes = await supabaseFetch(
      `clients?phone=eq.${encodeURIComponent(cleanPhone)}&limit=1`,
      { method: 'GET' }
    );
  }

  if (Array.isArray(existingRes.data) && existingRes.data[0]?.id) {
    const existing = existingRes.data[0];
    const updated = await supabaseFetch(`clients?id=eq.${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        name: client.fullName || existing.name,
        email: cleanEmail || existing.email,
        phone: cleanPhone || existing.phone || null,
      }),
    });
    return { skipped: false, data: Array.isArray(updated.data) ? updated.data[0] : existing };
  }

  const created = await supabaseFetch('clients', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      name: client.fullName,
      email: cleanEmail,
      phone: cleanPhone || null,
    }),
  });
  return { skipped: false, data: Array.isArray(created.data) ? created.data[0] : created.data };
}

async function insertBooking(booking) {
  if (!isSupabaseConfigured()) return { skipped: true, data: null };
  const res = await supabaseFetch('bookings', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ id: crypto.randomUUID(), ...booking }),
  });
  return { skipped: false, data: Array.isArray(res.data) ? res.data[0] : res.data };
}

async function getBookingByReference(bookingReference) {
  if (!isSupabaseConfigured()) return { skipped: true, data: null };
  const encoded = encodeURIComponent(bookingReference);
  const res = await supabaseFetch(
    `bookings?booking_reference=eq.${encoded}&select=*,clients(*),payments(*)&limit=1`,
    { method: 'GET' }
  );
  return { skipped: false, data: Array.isArray(res.data) ? res.data[0] || null : null };
}

async function updateBookingByReference(bookingReference, patch) {
  if (!isSupabaseConfigured()) return { skipped: true, data: null };
  const encoded = encodeURIComponent(bookingReference);
  const res = await supabaseFetch(`bookings?booking_reference=eq.${encoded}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return { skipped: false, data: Array.isArray(res.data) ? res.data[0] : res.data };
}

async function insertPayment(payment) {
  if (!isSupabaseConfigured()) return { skipped: true, data: null };
  const res = await supabaseFetch('payments', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ id: crypto.randomUUID(), ...payment }),
  });
  return { skipped: false, data: Array.isArray(res.data) ? res.data[0] : res.data };
}

async function updatePaymentByIntentId(intentId, patch) {
  if (!isSupabaseConfigured()) return { skipped: true, data: null };
  const encoded = encodeURIComponent(intentId);
  const res = await supabaseFetch(`payments?ziina_payment_intent_id=eq.${encoded}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return { skipped: false, data: Array.isArray(res.data) ? res.data[0] : res.data };
}

async function getActiveBookingsInRange(startIso, endIso) {
  if (!isSupabaseConfigured()) return { skipped: true, data: [] };
  const params = new URLSearchParams({
    select: 'scheduled_start,scheduled_end,status,created_at',
    status: 'in.(pending_payment,confirmed)',
    scheduled_start: `gte.${startIso}`,
    scheduled_end: `lte.${endIso}`,
  });
  const res = await supabaseFetch(`bookings?${params.toString()}`, { method: 'GET' });
  return { skipped: false, data: Array.isArray(res.data) ? res.data : [] };
}

async function getPaymentByIntentId(intentId) {
  if (!isSupabaseConfigured() || !intentId) return null;
  const res = await supabaseFetch(
    `payments?ziina_payment_intent_id=eq.${encodeURIComponent(intentId)}&select=*,bookings(*)&limit=1`,
    { method: 'GET' }
  );
  return Array.isArray(res.data) ? res.data[0] || null : null;
}

async function upsertDeveloper(name) {
  if (!isSupabaseConfigured() || !name) return null;
  const clean = name.trim();
  if (!clean || clean === 'Not specified') return null;
  const existing = await supabaseFetch(`developers?name=eq.${encodeURIComponent(clean)}&limit=1`, {
    method: 'GET',
  });
  if (Array.isArray(existing.data) && existing.data[0]?.id) {
    return existing.data[0];
  }
  const created = await supabaseFetch('developers', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ id: crypto.randomUUID(), name: clean }),
  });
  return Array.isArray(created.data) ? created.data[0] : created.data;
}

async function findOrCreateProject({ name, area, developerId }) {
  if (!isSupabaseConfigured() || !name) return null;
  const clean = name.trim();
  const areaFilter = area ? `&area=eq.${encodeURIComponent(area.trim())}` : '';
  const existing = await supabaseFetch(`projects?name=eq.${encodeURIComponent(clean)}${areaFilter}&limit=1`, {
    method: 'GET',
  });
  if (Array.isArray(existing.data) && existing.data[0]?.id) {
    return existing.data[0];
  }
  const created = await supabaseFetch('projects', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      name: clean,
      area: area ? area.trim() : null,
      developer_id: developerId || null,
    }),
  });
  return Array.isArray(created.data) ? created.data[0] : created.data;
}

function parseBedsToInt(beds) {
  if (typeof beds === 'number' && Number.isFinite(beds)) return beds;
  if (!beds) return null;
  const s = String(beds).toLowerCase();
  if (s.includes('studio')) return 0;
  const match = s.match(/\d+/);
  return match ? Number(match[0]) : null;
}

async function insertUnit(unit) {
  if (!isSupabaseConfigured()) return null;
  if (unit.unitNo && unit.project) {
    const existing = await supabaseFetch(
      `units?unit_no=eq.${encodeURIComponent(unit.unitNo)}&project=eq.${encodeURIComponent(unit.project)}&limit=1`,
      { method: 'GET' }
    );
    if (Array.isArray(existing.data) && existing.data[0]?.id) {
      return existing.data[0];
    }
  }
  const created = await supabaseFetch('units', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      unit_no: unit.unitNo,
      type: unit.type || null,
      beds: parseBedsToInt(unit.beds),
      developer: unit.developer || null,
      project: unit.project || null,
      dewa_active: Boolean(unit.dewaActive),
      access_notes: unit.accessNotes || null,
    }),
  });
  return Array.isArray(created.data) ? created.data[0] : created.data;
}

async function findOrCreateAgent(agent) {
  if (!isSupabaseConfigured() || !agent?.fullName) return null;
  if (agent.email) {
    const existing = await supabaseFetch(
      `agents?email=eq.${encodeURIComponent(agent.email.trim().toLowerCase())}&limit=1`,
      { method: 'GET' }
    );
    if (Array.isArray(existing.data) && existing.data[0]?.id) {
      return existing.data[0];
    }
  }
  const created = await supabaseFetch('agents', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      name: agent.fullName.trim(),
      agency_name: agent.agency ? agent.agency.trim() : null,
      email: agent.email ? agent.email.trim().toLowerCase() : null,
      phone: agent.phone ? agent.phone.trim() : null,
    }),
  });
  return Array.isArray(created.data) ? created.data[0] : created.data;
}

async function insertReport(report) {
  if (!isSupabaseConfigured()) return null;
  const basePayload = {
    id: crypto.randomUUID(),
    client_id: report.clientId || null,
    unit_id: report.unitId || null,
    agent_id: report.agentId || null,
  };

  const attempts = [
    { ...basePayload, report_type: report.reportType || 'Initial inspection', status: report.status || 'draft' },
    { ...basePayload, report_type: 'Initial inspection', status: 'draft' },
    { ...basePayload, report_type: report.reportType || 'Handover' },
    basePayload,
  ];

  let lastErr = null;
  for (const payload of attempts) {
    try {
      const created = await supabaseFetch('reports', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      return Array.isArray(created.data) ? created.data[0] : created.data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function getSigningSecret() {
  return process.env.BOOKING_TOKEN_SECRET || process.env.ZIINA_API_KEY || 'vn-dev-fallback-secret';
}

function signBookingToken(payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSigningSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyBookingToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', getSigningSecret()).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  isSupabaseConfigured,
  upsertClient,
  insertBooking,
  getBookingByReference,
  updateBookingByReference,
  insertPayment,
  updatePaymentByIntentId,
  getPaymentByIntentId,
  getActiveBookingsInRange,
  upsertDeveloper,
  findOrCreateProject,
  insertUnit,
  findOrCreateAgent,
  insertReport,
  signBookingToken,
  verifyBookingToken,
};
