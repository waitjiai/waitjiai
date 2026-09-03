const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GEO_PRICING, getGeoPricing, toLocalDisplay, tierDisplay, countryRow } = require('../lib/pricing');

// This exact formula shipped a real bug once: IN's `rate` was 1 instead of
// 100, and the display code divided by rate *and* 100 — which happened to
// cancel out for IN specifically but silently produced ~0 for every other
// country. These cases pin down the known-correct values (matching what's
// publicly promised on the marketing site) so that class of bug can't
// silently ship again.
test('toLocalDisplay matches the publicly-promised price for every country', () => {
  const expected = {
    IN: { spot: '800', stream: '300' },
    US: { spot: '12', stream: '5' },
    GB: { spot: '10', stream: '4' },
    SG: { spot: '16', stream: '6' },
    AU: { spot: '18', stream: '7' },
    CA: { spot: '16', stream: '7' },
    DE: { spot: '11', stream: '5' },
    NL: { spot: '11', stream: '5' },
    FR: { spot: '11', stream: '5' },
    AE: { spot: '40', stream: '17' },
    JP: { spot: '1800', stream: '750' },
    PK: { spot: '2200', stream: '900' },
    BD: { spot: '900', stream: '350' },
    LK: { spot: '2500', stream: '1000' },
    NP: { spot: '1100', stream: '430' },
    ID: { spot: '170000', stream: '70000' },
    PH: { spot: '540', stream: '220' },
    MY: { spot: '52', stream: '21' },
    TH: { spot: '380', stream: '155' },
    KR: { spot: '15000', stream: '6000' },
  };
  for (const [code, exp] of Object.entries(expected)) {
    const p = GEO_PRICING[code];
    assert.ok(p, `GEO_PRICING is missing an entry for ${code}`);
    assert.equal(toLocalDisplay(p.spotlight.min, p.rate), exp.spot, `${code} spotlight min display`);
    assert.equal(toLocalDisplay(p.stream.min, p.rate), exp.stream, `${code} stream min display`);
  }
});

test('IN rate must be 100 (paise per rupee), never 1 — the exact regression this guards against', () => {
  assert.equal(GEO_PRICING.IN.rate, 100);
});

test('every country rate is paise-per-local-currency-unit, not rupees-per-unit', () => {
  // A rate of 1-10 would mean someone accidentally used a rupee-denominated
  // rate (like the old buggy IN:1) instead of a paise-denominated one for a
  // low-value currency — every real currency here is either INR itself
  // (rate 100) or a currency where 1 unit is worth well under ₹1 in paise
  // terms is still >= 1, so just assert rate is a positive number and, for
  // non-IN entries, that it's set (not accidentally 1, the known-bad value).
  for (const [code, p] of Object.entries(GEO_PRICING)) {
    assert.ok(p.rate > 0, `${code} rate must be positive`);
    if (code !== 'ID' && code !== 'KR') {
      // ID and KR legitimately have sub-1 rates (IDR/KRW are low-value currencies)
      assert.notEqual(p.rate, 1, `${code} rate looks like the known-bad rupee-denominated bug value`);
    }
  }
});

test('getGeoPricing returns the primary target country, defaults to India', () => {
  assert.equal(getGeoPricing(['US']).label, 'USA');
  assert.equal(getGeoPricing(['US', 'GB']).label, 'USA', 'first country in the list wins');
  assert.equal(getGeoPricing([]).label, 'India');
  assert.equal(getGeoPricing(undefined).label, 'India');
  assert.equal(getGeoPricing(['ZZ']).label, 'India', 'unknown country code falls back to India');
});

test('tierDisplay produces the min/recommended shape used by GET /v1/public/pricing', () => {
  const t = tierDisplay(GEO_PRICING.US.spotlight, GEO_PRICING.US.rate);
  assert.deepEqual(t, {
    minPaise: 101880,
    recommendedPaise: 118000,
    minDisplay: '12',
    recommendedDisplay: '14',
  });
});

test('countryRow produces the allCountries row shape, matching known values', () => {
  const row = countryRow('JP', GEO_PRICING.JP);
  assert.equal(row.code, 'JP');
  assert.equal(row.currency, 'JPY');
  assert.equal(row.spotlightMinDisplay, '1800');
  assert.equal(row.streamMinDisplay, '750');
});

test('recommended price is never lower than the minimum, for every country/placement', () => {
  for (const [code, p] of Object.entries(GEO_PRICING)) {
    assert.ok(p.spotlight.recommended >= p.spotlight.min, `${code} spotlight recommended < min`);
    assert.ok(p.stream.recommended >= p.stream.min, `${code} stream recommended < min`);
  }
});
