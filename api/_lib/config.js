const PRICING_TIERS = {
  Apartment: {
    Studio: {
      tierKey: 'Studio',
      label: 'Studio',
      benchmarkSqft: 450,
      effectiveRate: 2.44,
      calEventTypeId: 7739308,
      durationMinutes: 120,
      kindOfApartment: 'Studio',
      packages: {
        initial: {
          key: 'initial',
          label: 'Initial Inspection',
          description: 'Full RERA-certified snagging inspection & interactive digital report within 24h.',
          priceAed: 1100,
          addonAed: 0,
          savingsAed: 0,
        },
        initial_followup: {
          key: 'initial_followup',
          label: 'Initial + Follow-Up Snag Check',
          description: 'Initial inspection plus follow-up verification (+35%) after developer rectification.',
          priceAed: 1475,
          addonAed: 375,
          savingsAed: 0,
        },
        initial_final: {
          key: 'initial_final',
          label: 'Initial + Final Handover Sign-Off',
          description: 'Initial inspection plus final handover sign-off visit (+50%).',
          priceAed: 1650,
          addonAed: 550,
          savingsAed: 0,
        },
        full_bundle: {
          key: 'full_bundle',
          label: 'Full Package Bundle (All 3 Visits)',
          description: 'Initial Inspection + Follow-Up Snag Check + Final Handover Sign-Off.',
          priceAed: 1900,
          addonAed: 0,
          savingsAed: 125,
        },
      },
    },
    '1 Bedroom': {
      tierKey: '1 Bedroom',
      label: '1 Bedroom',
      benchmarkSqft: 800,
      effectiveRate: 2.5,
      calEventTypeId: 7739308,
      durationMinutes: 120,
      kindOfApartment: '1 Bedroom',
      packages: {
        initial: {
          key: 'initial',
          label: 'Initial Inspection',
          description: 'Full RERA-certified snagging inspection & interactive digital report within 24h.',
          priceAed: 2000,
          addonAed: 0,
          savingsAed: 0,
        },
        initial_followup: {
          key: 'initial_followup',
          label: 'Initial + Follow-Up Snag Check',
          description: 'Initial inspection plus follow-up verification (+35%) after developer rectification.',
          priceAed: 2700,
          addonAed: 700,
          savingsAed: 0,
        },
        initial_final: {
          key: 'initial_final',
          label: 'Initial + Final Handover Sign-Off',
          description: 'Initial inspection plus final handover sign-off visit (+50%).',
          priceAed: 3000,
          addonAed: 1000,
          savingsAed: 0,
        },
        full_bundle: {
          key: 'full_bundle',
          label: 'Full Package Bundle (All 3 Visits)',
          description: 'Initial Inspection + Follow-Up Snag Check + Final Handover Sign-Off.',
          priceAed: 3500,
          addonAed: 0,
          savingsAed: 200,
        },
      },
    },
    '2 Bedroom': {
      tierKey: '2 Bedroom',
      label: '2 Bedroom',
      benchmarkSqft: 1250,
      effectiveRate: 2.48,
      calEventTypeId: 7742473,
      durationMinutes: 120,
      kindOfApartment: '1 Bedroom',
      packages: {
        initial: {
          key: 'initial',
          label: 'Initial Inspection',
          description: 'Full RERA-certified snagging inspection & interactive digital report within 24h.',
          priceAed: 3100,
          addonAed: 0,
          savingsAed: 0,
        },
        initial_followup: {
          key: 'initial_followup',
          label: 'Initial + Follow-Up Snag Check',
          description: 'Initial inspection plus follow-up verification (+35%) after developer rectification.',
          priceAed: 4175,
          addonAed: 1075,
          savingsAed: 0,
        },
        initial_final: {
          key: 'initial_final',
          label: 'Initial + Final Handover Sign-Off',
          description: 'Initial inspection plus final handover sign-off visit (+50%).',
          priceAed: 4650,
          addonAed: 1550,
          savingsAed: 0,
        },
        full_bundle: {
          key: 'full_bundle',
          label: 'Full Package Bundle (All 3 Visits)',
          description: 'Initial Inspection + Follow-Up Snag Check + Final Handover Sign-Off.',
          priceAed: 5400,
          addonAed: 0,
          savingsAed: 325,
        },
      },
    },
    '3 Bedroom': {
      tierKey: '3 Bedroom',
      label: '3 Bedroom',
      benchmarkSqft: 1800,
      effectiveRate: 2.5,
      calEventTypeId: 7742486,
      durationMinutes: 180,
      kindOfApartment: '1 Bedroom',
      packages: {
        initial: {
          key: 'initial',
          label: 'Initial Inspection',
          description: 'Full RERA-certified snagging inspection & interactive digital report within 24h.',
          priceAed: 4500,
          addonAed: 0,
          savingsAed: 0,
        },
        initial_followup: {
          key: 'initial_followup',
          label: 'Initial + Follow-Up Snag Check',
          description: 'Initial inspection plus follow-up verification (+35%) after developer rectification.',
          priceAed: 6075,
          addonAed: 1575,
          savingsAed: 0,
        },
        initial_final: {
          key: 'initial_final',
          label: 'Initial + Final Handover Sign-Off',
          description: 'Initial inspection plus final handover sign-off visit (+50%).',
          priceAed: 6750,
          addonAed: 2250,
          savingsAed: 0,
        },
        full_bundle: {
          key: 'full_bundle',
          label: 'Full Package Bundle (All 3 Visits)',
          description: 'Initial Inspection + Follow-Up Snag Check + Final Handover Sign-Off.',
          priceAed: 7900,
          addonAed: 0,
          savingsAed: 425,
        },
      },
    },
  },
  Townhouse: {
    '3–4 Bed': {
      tierKey: '3–4 Bed',
      label: 'Townhouse (3–4 Bed)',
      benchmarkSqft: 2600,
      effectiveRate: 2.5,
      calEventTypeId: 7742494,
      durationMinutes: 180,
      kindOfApartment: '1 Bedroom',
      packages: {
        initial: {
          key: 'initial',
          label: 'Initial Inspection',
          description: 'Full RERA-certified snagging inspection & interactive digital report within 24h.',
          priceAed: 6500,
          addonAed: 0,
          savingsAed: 0,
        },
        initial_followup: {
          key: 'initial_followup',
          label: 'Initial + Follow-Up Snag Check',
          description: 'Initial inspection plus follow-up verification (+35%) after developer rectification.',
          priceAed: 8775,
          addonAed: 2275,
          savingsAed: 0,
        },
        initial_final: {
          key: 'initial_final',
          label: 'Initial + Final Handover Sign-Off',
          description: 'Initial inspection plus final handover sign-off visit (+50%).',
          priceAed: 9750,
          addonAed: 3250,
          savingsAed: 0,
        },
        full_bundle: {
          key: 'full_bundle',
          label: 'Full Package Bundle (All 3 Visits)',
          description: 'Initial Inspection + Follow-Up Snag Check + Final Handover Sign-Off.',
          priceAed: 11400,
          addonAed: 0,
          savingsAed: 625,
        },
      },
    },
  },
  Villa: {
    '4–5 Bed': {
      tierKey: '4–5 Bed',
      label: 'Standard Villa (4–5 Bed)',
      benchmarkSqft: 4200,
      effectiveRate: 2.5,
      calEventTypeId: 7742505,
      durationMinutes: 180,
      kindOfApartment: '1 Bedroom',
      packages: {
        initial: {
          key: 'initial',
          label: 'Initial Inspection',
          description: 'Full RERA-certified snagging inspection & interactive digital report within 24h.',
          priceAed: 10500,
          addonAed: 0,
          savingsAed: 0,
        },
        initial_followup: {
          key: 'initial_followup',
          label: 'Initial + Follow-Up Snag Check',
          description: 'Initial inspection plus follow-up verification (+35%) after developer rectification.',
          priceAed: 14175,
          addonAed: 3675,
          savingsAed: 0,
        },
        initial_final: {
          key: 'initial_final',
          label: 'Initial + Final Handover Sign-Off',
          description: 'Initial inspection plus final handover sign-off visit (+50%).',
          priceAed: 15750,
          addonAed: 5250,
          savingsAed: 0,
        },
        full_bundle: {
          key: 'full_bundle',
          label: 'Full Package Bundle (All 3 Visits)',
          description: 'Initial Inspection + Follow-Up Snag Check + Final Handover Sign-Off.',
          priceAed: 18400,
          addonAed: 0,
          savingsAed: 1025,
        },
      },
    },
  },
};

const LUXURY_VILLA_MAX_SQFT = 6500;

function isLuxuryHome(propertyType, bedroomTier, buaSqft) {
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

function resolveTierConfig(propertyType, bedroomTier) {
  const byType = PRICING_TIERS[propertyType];
  if (!byType) return null;
  return byType[bedroomTier] || null;
}

function calculateQuote({ propertyType, bedroomTier, buaSqft, packageType }) {
  if (isLuxuryHome(propertyType, bedroomTier, buaSqft)) {
    return {
      isLuxuryQuote: true,
      propertyType,
      bedroomTier,
      packageType: 'custom_quote',
      packageLabel: 'Luxury Home — Price on Request',
      priceAed: null,
      amountFils: null,
      calEventTypeId: 7742505,
      durationMinutes: 180,
      kindOfApartment: '1 Bedroom',
    };
  }

  const tier = resolveTierConfig(propertyType, bedroomTier);
  if (!tier) {
    return { error: `Unsupported propertyType/bedroomTier: ${propertyType} / ${bedroomTier}` };
  }

  const pkg = tier.packages[packageType];
  if (!pkg) {
    return { error: `Unsupported packageType: ${packageType}` };
  }

  return {
    isLuxuryQuote: false,
    propertyType,
    bedroomTier: tier.tierKey,
    tierLabel: tier.label,
    packageType: pkg.key,
    packageLabel: pkg.label,
    priceAed: pkg.priceAed,
    amountFils: pkg.priceAed * 100,
    savingsAed: pkg.savingsAed,
    calEventTypeId: tier.calEventTypeId,
    durationMinutes: tier.durationMinutes,
    kindOfApartment: tier.kindOfApartment,
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
  PRICING_TIERS,
  LUXURY_VILLA_MAX_SQFT,
  isLuxuryHome,
  resolveTierConfig,
  calculateQuote,
  getSiteUrl,
};
