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
  const payload = {
    full_name: client.fullName,
    email: client.email.trim().toLowerCase(),
    phone: client.phone || null,
    client_type: client.clientType || 'owner_buyer',
    company_or_agency: client.companyOrAgency || null,
    source: client.source || 'website_booking',
    updated_at: new Date().toISOString(),
  };
  const res = await supabaseFetch('clients?on_conflict=email', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  });
  return { skipped: false, data: Array.isArray(res.data) ? res.data[0] : res.data };
}

async function insertBooking(booking) {
  if (!isSupabaseConfigured()) return { skipped: true, data: null };
  const res = await supabaseFetch('bookings', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(booking),
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
    body: JSON.stringify(payment),
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

async function findOrCreateByName(table, name) {
  if (!isSupabaseConfigured() || !name) return null;
  const clean = name.trim();
  if (!clean) return null;
  const existing = await supabaseFetch(`${table}?name=eq.${encodeURIComponent(clean)}&limit=1`, {
    method: 'GET',
  });
  if (Array.isArray(existing.data) && existing.data[0]?.id) {
    return existing.data[0];
  }
  const created = await supabaseFetch(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: clean }),
  });
  return Array.isArray(created.data) ? created.data[0] : created.data;
}

async function upsertDeveloper(name) {
  return findOrCreateByName('developers', name);
}

async function upsertArea(name) {
  return findOrCreateByName('areas', name);
}

async function findOrCreateProject({ name, areaId, developerId }) {
  if (!isSupabaseConfigured() || !name) return null;
  const clean = name.trim();
  const areaFilter = areaId ? `&area_id=eq.${encodeURIComponent(areaId)}` : '';
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
      name: clean,
      area_id: areaId || null,
      developer_id: developerId || null,
    }),
  });
  return Array.isArray(created.data) ? created.data[0] : created.data;
}

async function insertUnit(unit) {
  if (!isSupabaseConfigured()) return null;
  if (unit.unitNumber && unit.projectId) {
    const existing = await supabaseFetch(
      `units?unit_number=eq.${encodeURIComponent(unit.unitNumber)}&project_id=eq.${encodeURIComponent(unit.projectId)}&limit=1`,
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
      unit_number: unit.unitNumber,
      project_id: unit.projectId || null,
      area_id: unit.areaId || null,
      developer_id: unit.developerId || null,
      client_id: unit.clientId || null,
      property_type: unit.propertyType || null,
      bedroom_tier: unit.bedroomTier || null,
      address: unit.address || null,
      dewa_connected: Boolean(unit.dewaConnected),
      access_instructions: unit.accessInstructions || null,
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
      full_name: agent.fullName.trim(),
      agency: agent.agency ? agent.agency.trim() : null,
      email: agent.email ? agent.email.trim().toLowerCase() : null,
      phone: agent.phone ? agent.phone.trim() : null,
    }),
  });
  return Array.isArray(created.data) ? created.data[0] : created.data;
}

async function insertReport(report) {
  if (!isSupabaseConfigured()) return null;
  const created = await supabaseFetch('reports', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      booking_id: report.bookingId,
      client_id: report.clientId || null,
      unit_id: report.unitId || null,
      type: report.type || 'Handover',
      status: report.status || 'pending',
    }),
  });
  return Array.isArray(created.data) ? created.data[0] : created.data;
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
  upsertArea,
  findOrCreateProject,
  insertUnit,
  findOrCreateAgent,
  insertReport,
  signBookingToken,
  verifyBookingToken,
};
