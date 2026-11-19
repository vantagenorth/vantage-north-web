const crypto = require('crypto');

function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
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
  const baseUrl = process.env.SUPABASE_URL.replace(/\/+$/, '');
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
    select: 'scheduled_start,scheduled_end,status',
    status: 'in.(pending_payment,confirmed)',
    scheduled_start: `gte.${startIso}`,
    scheduled_end: `lte.${endIso}`,
  });
  const res = await supabaseFetch(`bookings?${params.toString()}`, { method: 'GET' });
  return { skipped: false, data: Array.isArray(res.data) ? res.data : [] };
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
  getActiveBookingsInRange,
  signBookingToken,
  verifyBookingToken,
};
