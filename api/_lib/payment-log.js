const { isSupabaseConfigured, insertPaymentEvent } = require('./supabase');

const MAX_MESSAGE_LENGTH = 1000;

function truncate(value, max = MAX_MESSAGE_LENGTH) {
  if (value === undefined || value === null) return null;
  const str = typeof value === 'string' ? value : String(value);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// Keep only the fields we need from a Ziina payment intent response. Full
// bodies are never stored.
function ziinaSummary(data) {
  if (!data || typeof data !== 'object') return null;
  const summary = {
    id: data.id ?? null,
    status: data.status ?? null,
    amount: data.amount ?? null,
    currency_code: data.currency_code ?? null,
    is_test: data.is_test ?? null,
    created_at: data.created_at ?? null,
  };
  const errorMessage = data.latest_error?.message || data.error?.message || data.message || null;
  const errorCode = data.latest_error?.code || data.error?.code || data.code || null;
  if (errorMessage) summary.error_message = truncate(errorMessage, 300);
  if (errorCode) summary.error_code = String(errorCode);
  return summary;
}

function errorMessageOf(err) {
  if (!err) return null;
  return truncate(err.message || String(err));
}

/**
 * Append one row to public.payment_events. Never throws: a logging failure
 * must not break checkout or booking confirmation. Every event is also written
 * to the function log as one JSON line, so it shows up in Vercel logs even if
 * Supabase is down.
 */
async function logPaymentEvent({
  source,
  event,
  level = 'info',
  bookingReference = null,
  intentId = null,
  httpStatus = null,
  ziinaStatus = null,
  message = null,
  details = null,
}) {
  const row = {
    source,
    event,
    level,
    booking_reference: bookingReference || null,
    ziina_payment_intent_id: intentId || null,
    http_status: Number.isFinite(Number(httpStatus)) && httpStatus !== null ? Number(httpStatus) : null,
    ziina_status: ziinaStatus || null,
    message: truncate(message),
    details: details || null,
  };

  const line = JSON.stringify({ paymentEvent: true, ...row });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  if (!isSupabaseConfigured()) return { logged: false };
  try {
    await insertPaymentEvent(row);
    return { logged: true };
  } catch (err) {
    console.error(`payment_events insert failed: ${err.message}`);
    return { logged: false, error: err.message };
  }
}

module.exports = {
  logPaymentEvent,
  ziinaSummary,
  errorMessageOf,
};
