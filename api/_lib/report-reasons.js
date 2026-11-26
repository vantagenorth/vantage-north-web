// "Reason for report" options on the booking form (was "Purpose of inspection").
// The stored value is the label itself, so the original three (Handover, Secondary purchase,
// Move out) are unchanged and older bookings, reports and emails still read the same.
const REPORT_REASONS = [
  'Handover',
  'Secondary purchase',
  'Move in',
  'Move out',
  'Post-renovation',
  'Before DLP ends',
  'Rental property check',
  'Before selling',
];

function normalizeReportReason(value) {
  const v = String(value || '').trim().toLowerCase();
  return REPORT_REASONS.find((r) => r.toLowerCase() === v) || 'Handover';
}

module.exports = { REPORT_REASONS, normalizeReportReason };
