// Pricing (AED). Keep in sync with the PRICING tables in book.html and index.html.
const BASE_RATES = {
  Studio: {
    baseRate: 699,
    includedBedrooms: 0,
    includedBathrooms: 1,
    minBedrooms: 0,
    maxBedrooms: 0,
    minBathrooms: 1,
    maxBathrooms: 1, // studios have fixed room counts
    extraRoomAed: 0,
    recheckAed: 299,
  },
  Apartment: {
    baseRate: 899,
    includedBedrooms: 1,
    includedBathrooms: 2,
    minBedrooms: 1,
    maxBedrooms: 5,
    minBathrooms: 1,
    maxBathrooms: 15,
    extraRoomAed: 99,
    recheckAed: 299,
  },
  Townhouse: {
    baseRate: 1999,
    includedBedrooms: 3,
    includedBathrooms: 3,
    minBedrooms: 1,
    maxBedrooms: 5,
    minBathrooms: 1,
    maxBathrooms: 15,
    extraRoomAed: 199,
    recheckAed: 499,
  },
  Villa: {
    baseRate: 2499,
    includedBedrooms: 4,
    includedBathrooms: 4,
    minBedrooms: 1,
    maxBedrooms: 5,
    minBathrooms: 1,
    maxBathrooms: 15,
    extraRoomAed: 199,
    recheckAed: 499,
  },
};

// Luxury, over 5,000 sq ft, or 6+ bedrooms: custom quote via WhatsApp.
const CUSTOM_QUOTE_MIN_BEDROOMS = 6;
const CUSTOM_QUOTE_OVER_SQFT = 5000;

function isLuxuryHome(propertyType, bedroomTier, buaSqft, bedrooms) {
  if (propertyType === 'Luxury') return true;
  if (bedroomTier === '6+ Bed' || bedroomTier === '6+ Bedrooms' || bedroomTier === 'Luxury Home') {
    return true;
  }
  const beds = Number(bedrooms);
  if (Number.isFinite(beds) && beds >= CUSTOM_QUOTE_MIN_BEDROOMS) {
    return true;
  }
  const sqft = Number(buaSqft);
  if (Number.isFinite(sqft) && sqft > CUSTOM_QUOTE_OVER_SQFT) {
    return true;
  }
  return false;
}

// How long an inspection takes, in minutes.
function inspectionMinutes(propertyType, bedrooms) {
  const beds = Number(bedrooms) || 0;
  if (propertyType === 'Studio' || (propertyType === 'Apartment' && beds <= 1)) return 120;
  if (propertyType === 'Apartment') return 180;
  return 240;
}

function resolveTierConfig(propertyType, bedroomTierOrBeds) {
  const cfg = BASE_RATES[propertyType];
  if (!cfg) return null;
  let beds = cfg.includedBedrooms;
  if (bedroomTierOrBeds !== undefined && bedroomTierOrBeds !== null && bedroomTierOrBeds !== '') {
    const num = Number(bedroomTierOrBeds);
    if (Number.isFinite(num)) {
      beds = num;
    } else if (String(bedroomTierOrBeds).toLowerCase().includes('studio')) {
      beds = 0;
    } else {
      const m = String(bedroomTierOrBeds).match(/\d+/);
      if (m) beds = Number(m[0]);
    }
  }
  return {
    ...cfg,
    durationMinutes: inspectionMinutes(propertyType, beds),
  };
}

function wantsRecheck(recheck, packageType) {
  if (packageType === 'initial_recheck') return true;
  return recheck === true || recheck === 'true' || recheck === 1 || recheck === '1';
}

function calculateQuote({ propertyType, bedrooms, bathrooms, bedroomTier, buaSqft, packageType, recheck }) {
  if (isLuxuryHome(propertyType, bedroomTier, buaSqft, bedrooms)) {
    return {
      isLuxuryQuote: true,
      propertyType,
      bedroomTier: 'Luxury',
      packageType: 'custom_quote',
      packageLabel: 'Luxury Home — Price on Request',
      priceAed: null,
      amountFils: null,
      durationMinutes: 240,
      kindOfApartment: 'Luxury',
    };
  }

  const cfg = BASE_RATES[propertyType];
  if (!cfg) {
    return { error: `Unsupported propertyType: ${propertyType}` };
  }
  if (packageType && packageType !== 'initial' && packageType !== 'initial_recheck') {
    // Developer Follow-Up, Final Handover Inspection and the Full Package Bundle were retired.
    return { error: 'That package is no longer offered. Please refresh the page and try again.' };
  }

  const beds = Math.max(
    cfg.minBedrooms,
    Math.min(cfg.maxBedrooms, Number.isFinite(Number(bedrooms)) ? Number(bedrooms) : cfg.includedBedrooms)
  );
  const baths = Math.max(
    cfg.minBathrooms,
    Math.min(cfg.maxBathrooms, Number.isFinite(Number(bathrooms)) ? Number(bathrooms) : cfg.includedBathrooms)
  );

  // Rooms above the included count add to the price; fewer rooms never go below the base.
  const extraBedrooms = Math.max(0, beds - cfg.includedBedrooms);
  const extraBathrooms = Math.max(0, baths - cfg.includedBathrooms);
  const extraBedroomAed = extraBedrooms * cfg.extraRoomAed;
  const extraBathroomAed = extraBathrooms * cfg.extraRoomAed;
  const baseWithExtras = cfg.baseRate + extraBedroomAed + extraBathroomAed;

  const withRecheck = wantsRecheck(recheck, packageType);
  const recheckAed = withRecheck ? cfg.recheckAed : 0;
  const priceAed = baseWithExtras + recheckAed;
  const packageLabel = withRecheck ? 'Initial Inspection + Re-Check' : 'Initial Inspection';

  const bedLabel = propertyType === 'Studio' ? 'Studio' : `${beds} Bed`;
  const sizeLabel = `${bedLabel}, ${baths} Bath`;

  return {
    isLuxuryQuote: false,
    propertyType,
    bedrooms: beds,
    bathrooms: baths,
    bedroomTier: sizeLabel,
    tierLabel: sizeLabel,
    packageType: withRecheck ? 'initial_recheck' : 'initial',
    packageLabel,
    recheck: withRecheck,
    priceAed,
    amountFils: priceAed * 100,
    durationMinutes: inspectionMinutes(propertyType, beds),
    kindOfApartment: bedLabel,
    pricingBreakdown: {
      baseRateAed: cfg.baseRate,
      extraRoomRateAed: cfg.extraRoomAed,
      extraBedrooms,
      extraBedroomAed,
      extraBathrooms,
      extraBathroomAed,
      recheckAed,
      totalAed: priceAed,
    },
  };
}

function getSiteUrl(req) {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/+$/, '');
  }
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  if (host) {
    return `${proto}://${host}`;
  }
  return 'https://vantagenorth.ae';
}

module.exports = {
  BASE_RATES,
  CUSTOM_QUOTE_MIN_BEDROOMS,
  CUSTOM_QUOTE_OVER_SQFT,
  isLuxuryHome,
  resolveTierConfig,
  calculateQuote,
  getSiteUrl,
};
