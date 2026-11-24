// Inspection pricing (AED), shared by the homepage quote tool (index.html) and the savings calculator
// (savings-calculator.html). Keep in sync with BASE_RATES in api/_lib/config.js and PRICING in book.html.
window.VN_PRICING = {
    Studio: { base: 699, includedBeds: 0, includedBaths: 1, minBeds: 0, maxBeds: 0, minBaths: 1, maxBaths: 1, extraRoom: 0, recheck: 299 },
    Apartment: { base: 899, includedBeds: 1, includedBaths: 2, minBeds: 1, maxBeds: 5, minBaths: 1, maxBaths: 15, extraRoom: 99, recheck: 299 },
    Townhouse: { base: 1999, includedBeds: 3, includedBaths: 3, minBeds: 1, maxBeds: 5, minBaths: 1, maxBaths: 15, extraRoom: 199, recheck: 499 },
    Villa: { base: 2499, includedBeds: 4, includedBaths: 4, minBeds: 1, maxBeds: 5, minBaths: 1, maxBaths: 15, extraRoom: 199, recheck: 499 }
};
