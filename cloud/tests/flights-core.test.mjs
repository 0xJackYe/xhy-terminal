import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_FRESH_MS, FlightInputError, OFFER_FRESH_MS, SCHEDULE_FRESH_MS,
  haversineKm, normalizeSearchInput, rankDepartures, safeFlightUrl,
  timestampWithOffset,
} from '../flights-core.mjs';

// Entirely synthetic fixtures: no live schedules, credentials or user location.
const NOW = Date.parse('2026-10-29T00:00:00Z');
const stamp = delta => new Date(NOW + delta).toISOString();
const clone = value => structuredClone(value);
const options = { now: NOW };
function query(extra = {}) {
  return { airports: [{ iata: 'NKG', travel_minutes: 60 }], ready_minutes: 120,
    passport_country: 'CN', ...extra };
}
function flight(extra = {}) {
  return {
    id: 'synthetic-1', flight_number: 'HO1001', airline: { name: '合成测试航空', iata: 'HO' },
    origin: { iata: 'NKG', name: '合成出发机场', city: '测试城市', lat: 31.74, lon: 118.86 },
    destination: { iata: 'BKK', name: '合成目的机场', city: '测试目的地', country_code: 'TH',
      country_name: '测试国家', time_zone: 'Asia/Bangkok' },
    scheduled_departure: '2026-10-29T16:00:00+08:00',
    scheduled_arrival: '2026-10-29T18:40:00+07:00', status: 'scheduled', nonstop: true,
    booking_url: 'https://www.airasia.com/flights/',
    source: { name: '合成测试来源', url: 'https://aerodatabox.com/', checked_at: stamp(0) },
    availability: 'confirmed_offer', price: { amount: '900.50', currency: 'CNY' },
    entry: { status: 'visa_free', official_url: 'https://www.mfa.gov.cn/',
      checked_at: stamp(0), passport_country: 'CN' },
    ...extra,
  };
}
function rank(flights, input = query()) { return rankDepartures(flights, input, options); }
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

test('normalization has conservative defaults, no inferred passport or commute', () => {
  const q = normalizeSearchInput({ airports: ['nkg'], extra: 'ignored' }, options);
  assert.deepEqual(q.airports, [{ iata: 'NKG', travel_minutes: null }]);
  assert.equal(q.ready_minutes, 0);
  assert.equal(q.international_buffer_minutes, 180);
  assert.equal(q.passport_country, null);
  assert.equal(q.sort, 'earliest_departure');
  assert.equal(q.entry_filter, 'all');
  assert.equal(q.earliest_departure, stamp(0));
  assert.equal(Object.hasOwn(q, 'extra'), false);
  assert.equal(normalizeSearchInput({ airports: [{ iata: 'NKG', travel_minutes: '' }] }, options).airports[0].travel_minutes, null);
  assert.equal(normalizeSearchInput({ airports: [{ iata: 'NKG', travel_minutes: 0 }] }, options).airports[0].travel_minutes, 0);
});

test('invalid location, travel time and duplicate conflicts are rejected rather than guessed', () => {
  for (const input of [null, [], {}, { origin: { lat: 91, lon: 0 } }, { origin: { lat: '32', lon: 118 } },
    { airports: ['not-iata'] }, { airports: [null] },
    { airports: [{ iata: 'NKG', travel_minutes: -1 }] },
    { airports: [{ iata: 'NKG', travel_minutes: 10.5 }] },
    { airports: [{ iata: 'NKG', travel_minutes: 60 }, { iata: 'nkg', travel_minutes: 61 }] },
    query({ ready_minutes: -1 }), query({ international_buffer_minutes: 0 }),
    query({ passport_country: 'China' }), query({ countries: ['Thailand'] }),
    query({ entry_filter: 'guaranteed_entry' }), query({ sort: 'cheap' }),
  ]) assert.throws(() => normalizeSearchInput(input, options), FlightInputError);
  assert.deepEqual(normalizeSearchInput({ airports: ['NKG', 'nkg'] }, options).airports,
    [{ iata: 'NKG', travel_minutes: null }]);
});

test('strict dates reject ambiguous timezone abbreviations, naive dates and calendar rollover', () => {
  for (const value of ['2026-10-29T12:00:00 CST', '2026-10-29T12:00:00',
    '2026-02-30T12:00:00+08:00', '2026-13-01T12:00:00Z',
    '2026-10-29T24:00:00Z', '2026-10-29T12:60:00Z',
    '2026-10-29T12:00:60Z', '2026-10-29T12:00:00+14:30',
    '2026-10-29T12:00:00+15:00', 'tomorrow', null,
  ]) assert.equal(timestampWithOffset(value), null, String(value));
  assert.equal(timestampWithOffset('2024-02-29T12:00:00+08:00'), Date.parse('2024-02-29T04:00:00Z'));
  assert.equal(timestampWithOffset('2026-10-29T12:00:00.123+08:00'), Date.parse('2026-10-29T04:00:00.123Z'));
});

test('date-only input means Beijing midnight and passed dates do not resurrect departed flights', () => {
  assert.equal(normalizeSearchInput(query({ earliest_departure: '2026-10-29' }), options).earliest_departure,
    '2026-10-28T16:00:00.000Z');
  assert.throws(() => normalizeSearchInput(query({ earliest_departure: '2026-02-29' }), options), FlightInputError);
  const answer = rank([flight({ scheduled_departure: stamp(-1) })], query({ earliest_departure: '2026-01-01' }));
  assert.equal(answer.results.length, 0);
  assert.equal(answer.excluded[0].code, 'not_departing');
});

test('exact reachable cutoff includes preparation, real commute and international buffer', () => {
  const answer = rank([flight({ scheduled_departure: '2026-10-29T14:00:00+08:00' })]);
  const p = answer.results[0].planning;
  assert.equal(p.disposition, 'actionable');
  assert.equal(p.ready_at, '2026-10-29T02:00:00.000Z');
  assert.equal(p.leave_by, '2026-10-29T02:00:00.000Z');
  assert.equal(p.arrive_by, '2026-10-29T03:00:00.000Z');
  assert.equal(p.airport_arrival, '2026-10-29T03:00:00.000Z');
  assert.equal(p.slack_minutes, 0);
  assert.deepEqual(p.reasons, []);
});

test('a delay estimate never makes a missed scheduled departure reachable', () => {
  const f = rank([flight({ scheduled_departure: '2026-10-29T13:59:59+08:00',
    estimated_departure: '2026-10-29T18:00:00+08:00', status: 'delayed' })]).results[0];
  assert.equal(f.planning.disposition, 'too_late');
  assert.ok(f.planning.slack_minutes < 0);
  assert.equal(f.estimated_departure, '2026-10-29T10:00:00.000Z');
  assert.equal(f.planning.arrive_by, '2026-10-29T02:59:59.000Z');
});

test('offsets compare actual instants across DST and international date boundaries', () => {
  const dstA = timestampWithOffset('2026-11-01T01:30:00-04:00');
  const dstB = timestampWithOffset('2026-11-01T01:30:00-05:00');
  assert.equal(dstB - dstA, 3600000);
  const answer = rank([
    flight({ id: 'later-arrival', flight_number: 'HO1002', scheduled_arrival: '2026-10-29T22:00:00+09:00' }),
    flight({ id: 'earlier-arrival', scheduled_arrival: '2026-10-30T00:30:00+14:00' }),
  ], query({ sort: 'earliest_arrival' }));
  assert.deepEqual(answer.results.map(f => f.id), ['earlier-arrival', 'later-arrival']);
  assert.equal(answer.results[0].scheduled_arrival, '2026-10-29T10:30:00.000Z');
});

test('missing arrival is retained for departure planning but sorts behind known arrival', () => {
  const missing = flight({ id: 'missing-arrival', scheduled_arrival: null,
    scheduled_departure: '2026-10-29T15:00:00+08:00', availability: 'schedule_only' });
  const known = flight({ id: 'known-arrival', flight_number: 'HO1002', availability: 'schedule_only' });
  const departure = rank([known, missing]);
  assert.equal(departure.results[0].id, 'missing-arrival');
  assert.equal(departure.results[0].scheduled_arrival, null);
  assert.match(departure.results[0].planning.reasons.join(' '), /到达时刻/);
  assert.equal(rank([missing, known], query({ sort: 'earliest_arrival' })).results[0].id, 'known-arrival');
  assert.equal(rank([flight({ scheduled_arrival: 'not-a-timestamp' })]).excluded[0].code, 'invalid_schedule');
});

test('schedule-only, unknown status, missing flight number or timezone never imply confirmed travel', () => {
  for (const extra of [{ availability: 'schedule_only' }, { availability: 'unknown' },
    { status: 'unknown' }, { flight_number: '' },
    { destination: { ...flight().destination, time_zone: 'unknown' } },
    { destination: { ...flight().destination, time_zone: 'CST' } },
    { destination: { ...flight().destination, time_zone: 'PST' } },
    { destination: { ...flight().destination, time_zone: 'IST' } },
  ]) {
    const f = rank([flight(extra)]).results[0];
    assert.equal(f.planning.disposition, 'needs_verification');
    assert.ok(f.planning.reasons.length > 0);
    if (extra.availability) assert.equal(f.price, null);
    if (extra.destination) assert.equal(f.destination.time_zone, null);
  }
});

test('missing commute remains unknown even when nearby coordinates are present', () => {
  const q = query({ origin: { lat: 32.04, lon: 118.78 }, airports: [{ iata: 'NKG', travel_minutes: null }] });
  const p = rank([flight()], q).results[0].planning;
  assert.equal(p.disposition, 'needs_verification');
  assert.equal(p.travel_minutes, null);
  assert.equal(p.airport_arrival, null);
  assert.equal(p.leave_by, null);
  assert.equal(p.slack_minutes, null);
  assert.ok(p.distance_km > 0 && p.distance_km < 50);
  assert.match(p.reasons.join(' '), /直线距离不能代替道路时间/);
});

test('cancelled, airborne, domestic, connecting and invalid windows are excluded explicitly', () => {
  const variants = [
    ['not_departing', { status: 'cancelled' }], ['not_departing', { status: 'active' }],
    ['not_departing', { status: 'departed' }], ['not_departing', { status: 'landed' }],
    ['not_nonstop', { nonstop: false }], ['not_nonstop', { nonstop: undefined }],
    ['domestic', { destination: { ...flight().destination, country_code: 'CN' } }],
    ['invalid_schedule', { destination: { iata: 'BKK' } }],
    ['invalid_schedule', { scheduled_arrival: '2026-10-29T15:00:00+08:00' }],
    ['invalid_schedule', { scheduled_arrival: '2026-11-01T15:00:00+08:00' }],
    ['invalid_schedule', { scheduled_departure: '2026-10-29T16:00:00' }],
  ];
  for (const [reason, extra] of variants) {
    const answer = rank([flight(extra)]);
    assert.equal(answer.results.length, 0, JSON.stringify(extra));
    assert.equal(answer.excluded[0].code, reason);
  }
  assert.equal(rank([flight()], query({ earliest_departure: '2026-10-30' })).excluded[0].code, 'before_window');
  assert.equal(rank([flight()], query({ countries: ['JP'] })).excluded[0].code, 'country_filtered');
  assert.equal(rank([flight()], query({ airports: ['PVG'] })).excluded[0].code, 'origin_filtered');
  assert.equal(rank([flight({ destination: { ...flight().destination, country_code: 'HK' } })]).results.length, 1);
});

test('source freshness, quote freshness and passport-scoped policy evidence are independent', () => {
  for (const extra of [
    { source: { ...flight().source, checked_at: stamp(-SCHEDULE_FRESH_MS - 1) } },
    { source: { ...flight().source, checked_at: stamp(61000) } },
    { source: { ...flight().source, url: 'https://untrusted.example/' } },
    { entry: { ...flight().entry, checked_at: stamp(-ENTRY_FRESH_MS - 1) } },
    { entry: { ...flight().entry, passport_country: 'JP' } },
    { entry: { ...flight().entry, official_url: 'https://travel-blog.example/policy' } },
    { entry: { ...flight().entry, status: 'visa_required' } },
  ]) assert.equal(rank([flight(extra)]).results[0].planning.disposition, 'needs_verification');
  const oldQuote = rank([flight({ source: { ...flight().source, checked_at: stamp(-OFFER_FRESH_MS - 1) } })]).results[0];
  assert.equal(oldQuote.price, null);
  assert.equal(oldQuote.planning.disposition, 'needs_verification');
  const visa = flight({ entry: { ...flight().entry, status: 'visa_required' } });
  assert.equal(rank([visa], query({ document_countries: ['TH'] })).results[0].planning.disposition, 'actionable');
});

test('demo, sandbox and known test endpoints cannot expose real-price or actionable claims', () => {
  for (const extra of [{ demo: true },
    { source: { ...flight().source, environment: 'sandbox' } },
    { source: { ...flight().source, url: 'https://test.api.amadeus.com/v2/shopping/flight-offers' } },
  ]) {
    const f = rank([flight(extra)]).results[0];
    assert.equal(f.availability, 'unknown');
    assert.equal(f.price, null);
    assert.equal(f.planning.disposition, 'needs_verification');
    assert.match(f.planning.reasons.join(' '), /测试或演示/);
  }
});

test('easy-entry filtering requires the selected passport and never reuses CN policy for others', () => {
  assert.equal(rank([flight()], query({ entry_filter: 'easy_entry' })).results.length, 1);
  for (const extra of [{ passport_country: null }, { passport_country: 'JP' }]) {
    const answer = rank([flight()], query({ ...extra, entry_filter: 'easy_entry' }));
    assert.equal(answer.results.length, 0);
    assert.equal(answer.excluded[0].code, 'entry_filtered');
    if (!extra.passport_country) assert.match(answer.summary.notices.join(' '), /护照/);
  }
  const visa = flight({ entry: { ...flight().entry, status: 'visa_required' } });
  assert.equal(rank([visa], query({ entry_filter: 'easy_entry', document_countries: ['TH'] })).results.length, 0);
  assert.equal(rank([visa], query({ entry_filter: 'all' })).results.length, 1);
});

test('external links require HTTPS and allowed domains, and do not expose provider credentials', () => {
  assert.equal(safeFlightUrl('https://www.airasia.com/flights/', 'booking'), 'https://www.airasia.com/flights/');
  assert.equal(safeFlightUrl('https://www.google.com/travel/flights?q=BKK', 'booking'), 'https://www.google.com/travel/flights?q=BKK');
  assert.equal(safeFlightUrl('https://cs.mfa.gov.cn/policy', 'entry'), 'https://cs.mfa.gov.cn/policy');
  assert.equal(safeFlightUrl('https://www.cn.emb-japan.go.jp/itpr_zh/visa.html', 'entry'), 'https://www.cn.emb-japan.go.jp/itpr_zh/visa.html');
  assert.equal(safeFlightUrl('https://www.visa.go.kr/', 'entry'), 'https://www.visa.go.kr/');
  for (const value of ['http://airasia.com/', 'https://airasia.com@evil.example/',
    'https://user:password@airasia.com/', 'https://airasia.com.evil.example/',
    'https://airasia.com:8443/', 'https://airasia.com./', 'https://127.0.0.1/',
    'https://airasia.com/\nmalicious', 'javascript:alert(1)',
    'https://api.aviationstack.com/v1/flights?access_key=private',
    'https://api.amadeus.com/v1/flights?apiKey=private',
    'https://aerodatabox.com/?authorization=private',
  ]) assert.equal(safeFlightUrl(value), null, value);
  assert.equal(safeFlightUrl('https://www.google.com/url?q=https://evil.example/', 'booking'), null);
  const answer = rank([flight({ booking_url: 'https://untrusted.example/checkout',
    source: { ...flight().source, url: 'https://api.aviationstack.com/v1/flights?access_key=private' } })]);
  assert.equal(answer.results[0].booking_url, null);
  assert.equal(answer.results[0].source.url, null);
  assert.equal(answer.results[0].planning.disposition, 'needs_verification');
  assert.doesNotMatch(JSON.stringify(answer), /access_key|private/);
});

test('cost sorting compares verified same-currency quotes and never prices missing data at zero', () => {
  const answer = rank([
    flight({ id: 'usd', flight_number: 'HO1002', price: { amount: 1, currency: 'USD' } }),
    flight({ id: 'unknown', flight_number: 'HO1003', availability: 'schedule_only', price: { amount: 1, currency: 'CNY' } }),
    flight({ id: 'expensive', flight_number: 'HO1004', price: { amount: '1500', currency: 'CNY' } }),
    flight({ id: 'cheap', flight_number: 'HO1005', price: { amount: '800', currency: 'CNY' } }),
  ], query({ sort: 'cost', currency: 'CNY' }));
  assert.deepEqual(answer.results.map(f => f.id), ['cheap', 'expensive', 'usd', 'unknown']);
  assert.equal(answer.results.at(-1).price, null);
  assert.match(answer.summary.notices.join(' '), /CNY/);
  for (const price of [{ amount: -1, currency: 'CNY' }, { amount: 'NaN', currency: 'CNY' },
    { amount: 0, currency: 'CNY' }, { amount: '1e2', currency: 'CNY' },
    { amount: '800', currency: 'CNY', checked_at: stamp(-OFFER_FRESH_MS - 1) },
  ]) assert.equal(rank([flight({ price })]).results[0].price, null);
});

test('stronger duplicates win independent of provider order, with counts and exclusions retained', () => {
  const weak = flight({ id: 'weak', flight_number: 'HO 1001', availability: 'schedule_only' });
  const strong = flight({ id: 'strong' });
  for (const pair of [[weak, strong], [strong, weak]]) {
    const answer = rank(pair);
    assert.equal(answer.results.length, 1);
    assert.equal(answer.results[0].id, 'strong');
    assert.equal(answer.summary.total_received, 2);
    assert.equal(answer.summary.matched, 1);
    assert.equal(answer.summary.excluded_count, 1);
    assert.equal(answer.excluded[0].code, 'duplicate');
    assert.equal(answer.excluded[0].id, 'weak');
  }
});

test('unreachable and unverified commutes cannot rank ahead of a viable verified option', () => {
  const answer = rank([
    flight({ id: 'too-late', scheduled_departure: '2026-10-29T12:00:00+08:00' }),
    flight({ id: 'unknown-commute', flight_number: 'HO1002', origin: { ...flight().origin, iata: 'PVG' } }),
    flight({ id: 'verified', flight_number: 'HO1003' }),
  ], query({ airports: [{ iata: 'NKG', travel_minutes: 60 }, { iata: 'PVG', travel_minutes: null }] }));
  assert.deepEqual(answer.results.map(f => f.id), ['verified', 'unknown-commute', 'too-late']);
  assert.equal(answer.summary.recommendation_id, 'verified');
  assert.equal(rank([flight({ scheduled_departure: '2026-10-29T12:00:00+08:00' })]).summary.recommendation_id, null);
});

test('haversine handles the antimeridian and radius without estimating road travel', () => {
  assert.equal(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }), 0);
  assert.ok(Math.abs(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.195) < 0.01);
  assert.ok(Math.abs(haversineKm({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }) - 222.390) < 0.01);
  const answer = rank([flight()], query({ origin: { lat: 0, lon: 0 }, max_distance_km: 300 }));
  assert.equal(answer.excluded[0].code, 'outside_radius');
});

test('empty input, limits and all returned data are explicit and source inputs remain immutable', () => {
  const raw = deepFreeze([flight(), flight({ id: 'second', flight_number: 'HO1002' })]);
  const q = deepFreeze(query({ limit: 1 }));
  const beforeRaw = clone(raw), beforeQ = clone(q);
  const answer = rank(raw, q);
  assert.equal(answer.results.length, 1);
  assert.equal(answer.summary.matched, 2);
  answer.results[0].origin.name = 'edited in output';
  answer.query.airports[0].travel_minutes = 5;
  assert.deepEqual(raw, beforeRaw);
  assert.deepEqual(q, beforeQ);
  const empty = rank([]);
  assert.equal(empty.summary.recommendation_id, null);
  assert.equal(empty.summary.total_received, 0);
  assert.deepEqual(empty.results, []);
  assert.throws(() => rankDepartures(null, query(), options), FlightInputError);
  assert.throws(() => rankDepartures([], query(), { now: NaN }), FlightInputError);
});
