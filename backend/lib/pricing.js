// Country pricing table and the paise↔local-currency display math — extracted
// from server.js so this can be unit-tested directly (see test/pricing.test.js).
// This exact formula previously had a real, shipped bug: IN's `rate` was 1
// instead of 100, and the display formula divided by rate *and* 100 — which
// happened to cancel out correctly for IN (rate=1) but silently produced ~0
// for every other country. Nobody had noticed because nothing called the
// endpoint that used this formula. See the comment on GEO_PRICING below for
// the full story. These tests exist to make sure that class of bug can't
// silently ship again.
//
// `rate` is INR paise per 1 unit of the local currency (e.g. US rate:8390
// means $1 ≈ ₹83.90 ≈ 8390 paise). IN's rate is 100 (100 paise = ₹1) for the
// same reason — it must NOT be 1, or every display conversion divides by the
// wrong unit.
const GEO_PRICING = {
  IN: { currency:'INR', symbol:'₹', rate:100, spotlight:{ min:80000, recommended:80000 }, stream:{ min:30000, recommended:30000 }, label:'India', minBudgetSpotlight:500000, minBudgetStream:200000 },
  US: { currency:'USD', symbol:'$', rate:8390, spotlight:{ min:101880, recommended:118000 }, stream:{ min:42000, recommended:50000 }, label:'USA', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  // 1 USD ≈ ₹83.9 · US devs have 3x higher ad value · Spotlight $12/1K, Stream $5/1K
  GB: { currency:'GBP', symbol:'£', rate:10600, spotlight:{ min:106000, recommended:127000 }, stream:{ min:45000, recommended:53000 }, label:'United Kingdom', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  // 1 GBP ≈ ₹106 · Spotlight £10/1K
  SG: { currency:'SGD', symbol:'S$', rate:6200, spotlight:{ min:99200, recommended:111600 }, stream:{ min:40000, recommended:46000 }, label:'Singapore', minBudgetSpotlight:900000, minBudgetStream:360000 },
  // 1 SGD ≈ ₹62 · Spotlight S$16/1K
  AU: { currency:'AUD', symbol:'A$', rate:5450, spotlight:{ min:98100, recommended:115000 }, stream:{ min:40000, recommended:47000 }, label:'Australia', minBudgetSpotlight:900000, minBudgetStream:360000 },
  // 1 AUD ≈ ₹54.5 · Spotlight A$18/1K
  CA: { currency:'CAD', symbol:'C$', rate:6150, spotlight:{ min:98400, recommended:115000 }, stream:{ min:40000, recommended:47000 }, label:'Canada', minBudgetSpotlight:900000, minBudgetStream:360000 },
  // 1 CAD ≈ ₹61.5 · Spotlight C$16/1K
  DE: { currency:'EUR', symbol:'€', rate:9050, spotlight:{ min:99550, recommended:118000 }, stream:{ min:42000, recommended:50000 }, label:'Germany', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  // 1 EUR ≈ ₹90.5 · Spotlight €11/1K
  NL: { currency:'EUR', symbol:'€', rate:9050, spotlight:{ min:99550, recommended:118000 }, stream:{ min:42000, recommended:50000 }, label:'Netherlands', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  FR: { currency:'EUR', symbol:'€', rate:9050, spotlight:{ min:99550, recommended:118000 }, stream:{ min:42000, recommended:50000 }, label:'France', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  AE: { currency:'AED', symbol:'AED', rate:2285, spotlight:{ min:91400, recommended:109000 }, stream:{ min:38000, recommended:45000 }, label:'UAE', minBudgetSpotlight:900000, minBudgetStream:360000 },
  // 1 AED ≈ ₹22.85 · Spotlight AED 40/1K
  JP: { currency:'JPY', symbol:'¥', rate:56, spotlight:{ min:100800, recommended:120000 }, stream:{ min:42000, recommended:50000 }, label:'Japan', minBudgetSpotlight:1000000, minBudgetStream:400000 },
  // 1 JPY ≈ ₹0.56 · Spotlight ¥1800/1K
  // ── The 10 countries below were previously only priced on the marketing site
  // (web/index.html's own hardcoded GEO_PRICING copy) and had NO entry here —
  // an advertiser targeting one of them was silently priced as if targeting
  // India instead of what the site showed them. Added here using the exact
  // same public CPM/budget figures already shown on the site, so the number a
  // prospect sees now matches what they're actually charged.
  PK: { currency:'PKR', symbol:'Rs', rate:30, spotlight:{ min:66000, recommended:76000 }, stream:{ min:27000, recommended:31000 }, label:'Pakistan', minBudgetSpotlight:600000, minBudgetStream:270000 },
  BD: { currency:'BDT', symbol:'৳', rate:76, spotlight:{ min:68400, recommended:79000 }, stream:{ min:26600, recommended:31000 }, label:'Bangladesh', minBudgetSpotlight:608000, minBudgetStream:243200 },
  LK: { currency:'LKR', symbol:'Rs', rate:28, spotlight:{ min:70000, recommended:80500 }, stream:{ min:28000, recommended:32000 }, label:'Sri Lanka', minBudgetSpotlight:616000, minBudgetStream:246400 },
  NP: { currency:'NPR', symbol:'Rs', rate:63, spotlight:{ min:69300, recommended:80000 }, stream:{ min:27090, recommended:31000 }, label:'Nepal', minBudgetSpotlight:598500, minBudgetStream:239400 },
  ID: { currency:'IDR', symbol:'Rp', rate:0.52, spotlight:{ min:88400, recommended:102000 }, stream:{ min:36400, recommended:42000 }, label:'Indonesia', minBudgetSpotlight:780000, minBudgetStream:312000 },
  PH: { currency:'PHP', symbol:'₱', rate:149, spotlight:{ min:80460, recommended:92500 }, stream:{ min:32780, recommended:38000 }, label:'Philippines', minBudgetSpotlight:715200, minBudgetStream:286080 },
  MY: { currency:'MYR', symbol:'RM', rate:1850, spotlight:{ min:96200, recommended:111000 }, stream:{ min:38850, recommended:45000 }, label:'Malaysia', minBudgetSpotlight:888000, minBudgetStream:355200 },
  TH: { currency:'THB', symbol:'฿', rate:237, spotlight:{ min:90060, recommended:103500 }, stream:{ min:36735, recommended:42000 }, label:'Thailand', minBudgetSpotlight:805800, minBudgetStream:322320 },
  KR: { currency:'KRW', symbol:'₩', rate:6.3, spotlight:{ min:94500, recommended:109000 }, stream:{ min:37800, recommended:43500 }, label:'South Korea', minBudgetSpotlight:850500, minBudgetStream:340200 },
};

function getGeoPricing(countries) {
  // Return pricing for the first/primary target country
  const primary = (countries && countries[0]) || 'IN';
  return GEO_PRICING[primary] || GEO_PRICING['IN'];
}

// paise (INR) -> local-currency display amount, as a rounded string. This is
// the exact formula that was broken (see file header) — never re-add a
// stray "/100" here.
function toLocalDisplay(paise, rate) {
  return (paise / rate).toFixed(0);
}

// The exact shape GET /v1/public/pricing returns for one country's ad-type
// tier (spotlight or stream).
function tierDisplay(tier, rate) {
  return {
    minPaise: tier.min,
    recommendedPaise: tier.recommended,
    minDisplay: toLocalDisplay(tier.min, rate),
    recommendedDisplay: toLocalDisplay(tier.recommended, rate),
  };
}

// The exact shape GET /v1/public/pricing's `allCountries` array uses for one
// country's row.
function countryRow(code, p) {
  return {
    code, label: p.label, currency: p.currency, symbol: p.symbol, rate: p.rate,
    spotlightMinDisplay: toLocalDisplay(p.spotlight.min, p.rate),
    spotlightRecommendedDisplay: toLocalDisplay(p.spotlight.recommended, p.rate),
    spotlightMinBudgetDisplay: toLocalDisplay(p.minBudgetSpotlight, p.rate),
    streamMinDisplay: toLocalDisplay(p.stream.min, p.rate),
    streamRecommendedDisplay: toLocalDisplay(p.stream.recommended, p.rate),
    streamMinBudgetDisplay: toLocalDisplay(p.minBudgetStream, p.rate),
  };
}

module.exports = { GEO_PRICING, getGeoPricing, toLocalDisplay, tierDisplay, countryRow };
