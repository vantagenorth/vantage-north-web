const BASE_RATES = {
  Studio: {
    baseRate: 1100,
    includedBedrooms: 0,
    includedBathrooms: 1,
    minBedrooms: 0,
    maxBedrooms: 0,
    minBathrooms: 1,
  },
  Apartment: {
    baseRate: 1800,
    includedBedrooms: 1,
    includedBathrooms: 2,
    minBedrooms: 1,
    maxBedrooms: 15,
    minBathrooms: 1,
  },
  Townhouse: {
    baseRate: 2950,
    includedBedrooms: 3,
    includedBathrooms: 3,
    minBedrooms: 1,
    maxBedrooms: 15,
    minBathrooms: 1,
  },
  Villa: {
    baseRate: 4500,
    includedBedrooms: 4,
    includedBathrooms: 4,
    minBedrooms: 1,
    maxBedrooms: 15,
    minBathrooms: 1,
  },
};

const EXTRA_BEDROOM_AED = 350;
const EXTRA_BATHROOM_AED = 500;
const LUXURY_VILLA_MAX_SQFT = 6500;

function isLuxuryHome(propertyType, bedroomTier, buaSqft) {
  if (propertyType === 'Luxury') return true;
  if (propertyType !== 'Villa') return false;
  if (bedroomTier === '6+ Bed' || bedroomTier === '6+ Bedrooms' || bedroomTier === 'Luxury Home') {
    return true;
  }
  const sqft = Number(buaSqft);
  if (Number.isFinite(sqft) && sqft > LUXURY_VILLA_MAX_SQFT) {
    return true;
  }
  return false;
}

function getCalEventConfig(propertyType, bedrooms) {
  const beds = Number(bedrooms) || 0;
  if (propertyType === 'Studio' || (propertyType === 'Apartment' && beds <= 1)) {
    return { calEventTypeId: 7985836, durationMinutes: 120 };
  }
  if (propertyType === 'Apartment') {
    return { calEventTypeId: 7985837, durationMinutes: 180 };
  }
  return { calEventTypeId: 7985838, durationMinutes: 240 };
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
  const cal = getCalEventConfig(propertyType, beds);
  return {
    ...cfg,
    ...cal,
  };
}

function calculateQuote({ propertyType, bedrooms, bathrooms, bedroomTier, buaSqft, packageType }) {
  if (isLuxuryHome(propertyType, bedroomTier, buaSqft)) {
    return {
      isLuxuryQuote: true,
      propertyType,
      bedroomTier: 'Luxury',
      packageType: 'custom_quote',
      packageLabel: 'Luxury Home — Price on Request',
      priceAed: null,
      amountFils: null,
      calEventTypeId: 7985838,
      durationMinutes: 240,
      kindOfApartment: 'Luxury',
    };
  }

  const cfg = BASE_RATES[propertyType];
  if (!cfg) {
    return { error: `Unsupported propertyType: ${propertyType}` };
  }

  const beds = Math.max(
    cfg.minBedrooms,
    Math.min(cfg.maxBedrooms, Number.isFinite(Number(bedrooms)) ? Number(bedrooms) : cfg.includedBedrooms)
  );
  const baths = Math.max(
    cfg.minBathrooms,
    Math.min(15, Number.isFinite(Number(bathrooms)) ? Number(bathrooms) : cfg.includedBathrooms)
  );

  const extraBedrooms = Math.max(0, beds - cfg.includedBedrooms);
  const extraBathrooms = Math.max(0, baths - cfg.includedBathrooms);
  const extraBedroomAed = extraBedrooms * EXTRA_BEDROOM_AED;
  const extraBathroomAed = extraBathrooms * EXTRA_BATHROOM_AED;
  const baseWithExtras = cfg.baseRate + extraBedroomAed + extraBathroomAed;

  const followupAddon = Math.round(cfg.baseRate * 0.4);
  const finalAddon = Math.round(cfg.baseRate * 0.5);

  let priceAed = baseWithExtras;
  let packageLabel = 'Initial Inspection';
  let appliedFollowupAed = 0;
  let appliedFinalAed = 0;
  let bundleDiscountAed = 0;

  if (packageType === 'initial_followup') {
    appliedFollowupAed = followupAddon;
    priceAed = baseWithExtras + followupAddon;
    packageLabel = 'Initial + Developer Follow-Up';
  } else if (packageType === 'initial_final') {
    appliedFinalAed = finalAddon;
    priceAed = baseWithExtras + finalAddon;
    packageLabel = 'Initial + Final Handover Inspection';
  } else if (packageType === 'full_bundle') {
    appliedFollowupAed = followupAddon;
    appliedFinalAed = finalAddon;
    const subtotal = baseWithExtras + followupAddon + finalAddon;
    priceAed = Math.round(subtotal * 0.9);
    bundleDiscountAed = subtotal - priceAed;
    packageLabel = 'Full Package Bundle (10% Off)';
  } else if (packageType && packageType !== 'initial') {
    return { error: `Unsupported packageType: ${packageType}` };
  }

  const cal = getCalEventConfig(propertyType, beds);
  const bedLabel = propertyType === 'Studio' ? 'Studio' : `${beds} Bed`;
  const sizeLabel = `${bedLabel}, ${baths} Bath`;

  return {
    isLuxuryQuote: false,
    propertyType,
    bedrooms: beds,
    bathrooms: baths,
    bedroomTier: sizeLabel,
    tierLabel: sizeLabel,
    packageType: packageType || 'initial',
    packageLabel,
    priceAed,
    amountFils: priceAed * 100,
    calEventTypeId: cal.calEventTypeId,
    durationMinutes: cal.durationMinutes,
    kindOfApartment: bedLabel,
    pricingBreakdown: {
      baseRateAed: cfg.baseRate,
      extraBedrooms,
      extraBedroomAed,
      extraBathrooms,
      extraBathroomAed,
      followupAddonAed: appliedFollowupAed,
      finalAddonAed: appliedFinalAed,
      bundleDiscountAed,
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
  EXTRA_BEDROOM_AED,
  EXTRA_BATHROOM_AED,
  LUXURY_VILLA_MAX_SQFT,
  isLuxuryHome,
  resolveTierConfig,
  calculateQuote,
  getSiteUrl,
};
