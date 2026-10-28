import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAirportDepartures, FlightProviderError } from '../flights-provider.mjs';
import { DESTINATION_AIRPORTS, DESTINATION_AIRPORTS_BY_IATA } from '../flights-airports.mjs';

const NOW = Date.parse('2026-10-29T00:00:00Z');
const FROM = '2026-10-29T00:00:00.000Z', TO = '2026-10-29T12:00:00.000Z';
const KEY = 'mock-only-provider-key-never-real';
const ORIGIN = { iata: 'NKG', name: '南京禄口', city: '南京', country_code: 'CN', time_zone: 'Asia/Shanghai', lat: 31.74, lon: 118.86 };
const JAPAN = { iata: 'KIX', name: '关西国际机场', city: '大阪', country_code: 'JP', country_name: '日本', time_zone: 'Asia/Tokyo' };
function row(patch = {}) {
  return { number: 'MU 531', status: 'Expected', codeshareStatus: 'IsOperator', isCargo: false,
    airline: { name: 'China Eastern', iata: 'MU' },
    departure: { scheduledTime: { utc: '2026-10-29T01:30:00Z', local: '2026-10-29T09:30:00+08:00' }, revisedTime: { utc: '2026-10-29T01:50:00Z' } },
    arrival: { airport: { iata: 'KIX', name: 'Kansai International', municipalityName: 'Osaka', countryCode: 'JP', timeZone: 'Asia/Tokyo' }, scheduledTime: { utc: '2026-10-29T04:00:00Z' } }, ...patch };
}
function args(extra = {}) { return { airport: ORIGIN, from: FROM, to: TO, apiKey: KEY, now: NOW, ...extra }; }
function mock(rows = [row()], calls = []) {
  return async (url, init) => { calls.push({ url, init }); return Response.json({ departures: rows }); };
}
function safeError(code, secret = KEY) {
  return error => {
    assert(error instanceof FlightProviderError);
    assert.equal(error.code, code);
    assert(!error.message.includes(secret));
    assert(!JSON.stringify(error).includes(secret));
    assert(!error.stack.includes(secret));
    return true;
  };
}

test('runtime fetch retains the global receiver required by Cloudflare Workers', async () => {
  let calls = 0;
  const fetchImpl = async function (url, init) {
    assert.equal(this, globalThis);
    calls++;
    assert.equal(new URL(url).origin, 'https://aerodatabox.p.rapidapi.com');
    assert.equal(init.method, 'GET');
    return Response.json({ departures: [row()] });
  };
  const result = await fetchAirportDepartures(args({ fetchImpl }));
  assert.equal(calls, 1);
  assert.equal(result.metadata.status, 'ok');
  assert.equal(result.flights.length, 1);
});

test('airport UTC window becomes local minutes in one pinned, credential-header-only request', async () => {
  const calls = [], result = await fetchAirportDepartures(args({ fetchImpl: mock([row()], calls), airportsByIata: { KIX: JAPAN } }));
  assert.equal(calls.length, 1);
  const { url: address, init } = calls[0], url = new URL(address);
  assert.equal(url.origin, 'https://aerodatabox.p.rapidapi.com');
  assert.equal(url.pathname, '/flights/airports/iata/NKG/2026-10-29T08:00/2026-10-29T20:00');
  assert.equal(url.searchParams.get('direction'), 'Departure');
  assert.equal(url.searchParams.get('withLeg'), 'true');
  for (const field of ['withCancelled', 'withCodeshared', 'withCargo', 'withPrivate', 'withLocation']) assert.equal(url.searchParams.get(field), 'false');
  assert(!address.includes(KEY));
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['X-RapidAPI-Key'], KEY);
  assert.equal(init.headers['X-RapidAPI-Host'], 'aerodatabox.p.rapidapi.com');
  assert(init.signal instanceof AbortSignal);
  assert.equal(result.metadata.request_count, 1);
  assert.deepEqual(result.metadata.query_windows, [{ from: FROM, to: TO, from_local: '2026-10-29T08:00', to_local: '2026-10-29T20:00' }]);
  assert.equal(result.flights.length, 1);
  const flight = result.flights[0];
  assert.equal(flight.origin.iata, 'NKG');
  assert.equal(flight.destination.iata, 'KIX');
  assert.equal(flight.destination.country_code, 'JP');
  assert.equal(flight.destination.time_zone, 'Asia/Tokyo');
  assert.equal(flight.scheduled_departure, '2026-10-29T01:30:00.000Z');
  assert.equal(flight.scheduled_arrival, '2026-10-29T04:00:00.000Z');
  assert.equal(flight.estimated_departure, '2026-10-29T01:50:00.000Z');
  assert.equal(flight.status, 'scheduled');
  assert.equal(flight.nonstop, true);
  assert.equal(flight.availability, 'schedule_only');
  assert.equal(flight.price, null);
  assert.equal(flight.booking_url, null);
  assert.equal(flight.entry.status, 'verify');
  assert.equal(flight.entry.passport_country, null);
  assert.equal(flight.source.url, 'https://aerodatabox.com/');
  assert.match(flight.source.attribution, /AeroDataBox/);
  assert.equal(result.metadata.received_count, 1);
  assert.equal(result.metadata.excluded_count, 0);
  assert(!JSON.stringify(result).includes(KEY));
});

test('UTC conversion crosses the Shanghai calendar date without treating UTC as local', async () => {
  const calls = [];
  await fetchAirportDepartures(args({ from: '2026-10-29T16:30:00Z', to: '2026-10-30T04:30:00Z', fetchImpl: mock([], calls) }));
  assert.equal(new URL(calls[0].url).pathname, '/flights/airports/iata/NKG/2026-10-30T00:30/2026-10-30T12:30');
});

test('real provider wire timestamps normalize only the separator and preserve offsets across a calendar date', async () => {
  const raw = row({
    departure: { scheduledTime: { utc: '2026-10-28 23:00Z', local: '2026-10-29 07:00+08:00' }, revisedTime: { utc: '2026-10-29 07:15:30+08:00' } },
    arrival: { airport: { ...row().arrival.airport, countryCode: 'jp' }, scheduledTime: { utc: '2026-10-29 11:00+09:00' } },
  });
  const result = await fetchAirportDepartures(args({ from: '2026-10-28T22:00:00Z', to: '2026-10-29T10:00:00Z', now: Date.parse('2026-10-28T21:59:00Z'), fetchImpl: mock([raw]) }));
  assert.equal(result.flights.length, 1);
  assert.equal(result.flights[0].scheduled_departure, '2026-10-28T23:00:00.000Z');
  assert.equal(result.flights[0].scheduled_arrival, '2026-10-29T02:00:00.000Z');
  assert.equal(result.flights[0].estimated_departure, '2026-10-28T23:15:30.000Z');
  assert.equal(result.flights[0].destination.country_code, 'JP');
});

test('wire departure with seconds survives while missing or naive arrival and revision remain unknown', async () => {
  const raw = row({ departure: { scheduledTime: { utc: '2026-10-29 01:30:12Z' }, revisedTime: { utc: '2026-10-29 01:50' } } });
  for (const scheduledTime of [undefined, { utc: '2026-10-29 04:00' }]) {
    raw.arrival.scheduledTime = scheduledTime;
    const result = await fetchAirportDepartures(args({ fetchImpl: mock([raw]) }));
    assert.equal(result.flights.length, 1);
    assert.equal(result.flights[0].scheduled_departure, '2026-10-29T01:30:12.000Z');
    assert.equal(result.flights[0].scheduled_arrival, null);
    assert.equal(result.flights[0].estimated_departure, null);
  }
});

test('wire normalization rejects naive, ambiguous, malformed and invalid calendar values without relaxing query inputs', async () => {
  const invalid = ['2026-10-29 01:30', '2026-10-29 01:30 CST', '2026-10-29 25:30Z', '2026-10-29 01:60Z', '2026-10-29 01:30+14:01', '2026-10-29  01:30Z', '2026-10-29\t01:30Z', '2026-10-29 01:30Z junk', ' 2026-10-29 01:30Z'];
  const records = invalid.map(utc => row({ departure: { scheduledTime: { utc } } }));
  const result = await fetchAirportDepartures(args({ fetchImpl: mock(records) }));
  assert.equal(result.flights.length, 0);
  assert.equal(result.metadata.excluded_count, records.length);
  // Date.parse rolls February 30 into March 2, inside this valid window.
  assert.equal(Date.parse('2026-02-30T01:30Z'), Date.parse('2026-03-02T01:30Z'));
  const badCalendar = row({ departure: { scheduledTime: { utc: '2026-02-30 01:30Z' } }, arrival: { ...row().arrival, scheduledTime: { utc: '2026-03-02 04:00Z' } } });
  const calendarResult = await fetchAirportDepartures(args({ from: '2026-03-02T00:00:00Z', to: '2026-03-02T12:00:00Z', now: Date.parse('2026-03-01T23:59:00Z'), fetchImpl: mock([badCalendar]) }));
  assert.equal(calendarResult.flights.length, 0);
  let calls = 0;
  for (const patch of [{ from: '2026-10-29 00:00Z' }, { to: '2026-10-29 12:00+00:00' }]) {
    await assert.rejects(fetchAirportDepartures(args({ ...patch, fetchImpl: async () => { calls++; } })), safeError('INVALID_PROVIDER_INPUT'));
  }
  assert.equal(calls, 0);
});

test('missing key returns an honest configuration state without making a request', async () => {
  let calls = 0;
  for (const apiKey of [undefined, null, '', '   ']) {
    const result = await fetchAirportDepartures(args({ apiKey, fetchImpl: async () => { calls++; } }));
    assert.equal(result.metadata.status, 'needs_configuration');
    assert.equal(result.metadata.request_count, 0);
    assert.deepEqual(result.flights, []);
  }
  assert.equal(calls, 0);
});

test('invalid credentials, URL injection, timezone-less dates, invalid dates and oversized or unaligned windows never reach upstream', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; };
  const invalid = [
    { airport: { ...ORIGIN, iata: 'NKG/../../evil' } },
    { airport: { ...ORIGIN, time_zone: 'invalid/timezone' } },
    { airport: { ...ORIGIN, time_zone: 'CST' } },
    { airport: { ...ORIGIN, time_zone: 'PST' } },
    { airport: { ...ORIGIN, time_zone: 'IST' } },
    { airport: { ...ORIGIN, time_zone: undefined } },
    { from: '2026-10-29T00:00:00' },
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-10-29T00:00:00+08:00' },
    { from: '2026-10-29T00:00:01Z' },
    { to: '2026-10-29T12:01:00Z' },
    { to: FROM }, { now: NaN }, { timeoutMs: 30_001 },
  ];
  for (const patch of invalid) await assert.rejects(fetchAirportDepartures(args({ fetchImpl, ...patch })), safeError('INVALID_PROVIDER_INPUT'));
  await assert.rejects(fetchAirportDepartures(args({ fetchImpl, apiKey: `not-valid\n${KEY}` })), safeError('INVALID_PROVIDER_KEY'));
  assert.equal(calls, 0);
});

test('only verified international airport-to-airport legs survive; explicit stops and unknown destinations are rejected', async () => {
  const base = row(), records = [
    base,
    row({ arrival: { ...base.arrival, airport: { iata: 'PEK', countryCode: 'CN' } } }),
    row({ arrival: { ...base.arrival, airport: { iata: 'KIX' } } }),
    row({ departure: { ...base.departure, airport: { iata: 'PVG' } } }),
    row({ arrival: { scheduledTime: base.arrival.scheduledTime } }),
    row({ departure: undefined, arrival: undefined, movement: base.departure }),
    row({ nonstop: false }), row({ nonstop: 'true' }), row({ numberOfStops: 1 }), row({ stops: ['ICN'] }), row({ stops: 'unknown' }), row({ segments: [{}, {}] }),
    row({ isCargo: true }), row({ isCargo: undefined }), row({ isCargo: 'false' }), row({ isPrivate: true }), row({ codeshareStatus: 'IsCodeshared' }),
    row({ arrival: { ...base.arrival, airport: { iata: 'NKG', countryCode: 'JP' } } }),
  ];
  const result = await fetchAirportDepartures(args({ fetchImpl: mock(records) }));
  assert.equal(result.flights.length, 1);
  assert.equal(result.metadata.received_count, records.length);
  assert.equal(result.metadata.excluded_count, records.length - 1);
});

test('trusted registry may fill missing destination country, but conflicts are excluded and no nationality or timezone is guessed', async () => {
  const raw = row(); delete raw.arrival.airport.countryCode; delete raw.arrival.airport.timeZone;
  const unknown = await fetchAirportDepartures(args({ fetchImpl: mock([raw]) }));
  assert.equal(unknown.flights.length, 0);
  const result = await fetchAirportDepartures(args({ fetchImpl: mock([raw]), airportsByIata: new Map([['KIX', { ...JAPAN, time_zone: undefined }]]) }));
  assert.equal(result.flights[0].destination.country_code, 'JP');
  assert.equal(result.flights[0].destination.time_zone, null);
  assert.equal(result.flights[0].entry.passport_country, null);
  const conflict = await fetchAirportDepartures(args({ fetchImpl: mock([row()]), airportsByIata: { KIX: { ...JAPAN, country_code: 'CN' } } }));
  assert.equal(conflict.flights.length, 0);
  for (const timeZone of ['CST', 'PST', 'IST']) {
    const ambiguous = row(); ambiguous.arrival.airport.timeZone = timeZone;
    const board = await fetchAirportDepartures(args({ fetchImpl: mock([ambiguous]) }));
    assert.equal(board.flights[0].destination.time_zone, null);
  }
});

test('reference airport registry resolves country and timezone for limited airport-board responses across the supported destinations', async () => {
  const expected = {
    TH: ['BKK', 'DMK', 'HKT', 'CNX', 'KBV'], MY: ['KUL', 'PEN', 'BKI', 'JHB', 'LGK'], SG: ['SIN'],
    JP: ['NRT', 'HND', 'KIX', 'NGO', 'FUK', 'OKA'], KR: ['ICN', 'GMP', 'PUS', 'CJU'], ID: ['CGK', 'DPS'],
  };
  const records = Object.values(expected).flat().map(code => {
    const raw = row(); raw.arrival.airport = { iata: code, name: code }; return raw;
  });
  const result = await fetchAirportDepartures(args({ fetchImpl: mock(records), airportsByIata: DESTINATION_AIRPORTS_BY_IATA }));
  assert.equal(result.flights.length, 23);
  assert.equal(DESTINATION_AIRPORTS.length, 23);
  for (const [nation, codes] of Object.entries(expected)) for (const code of codes) {
    const destination = result.flights.find(f => f.destination.iata === code)?.destination;
    assert.equal(destination?.country_code, nation);
    assert(destination?.city);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: destination.time_zone }).format(NOW));
  }
  assert.equal(result.flights.find(f => f.destination.iata === 'BKI').destination.time_zone, 'Asia/Kuching');
  assert.equal(result.flights.find(f => f.destination.iata === 'CGK').destination.time_zone, 'Asia/Jakarta');
  assert.equal(result.flights.find(f => f.destination.iata === 'DPS').destination.time_zone, 'Asia/Makassar');
});

test('missing, invalid, reversed and timezone-less arrivals remain null instead of being invented', async () => {
  for (const scheduledTime of [undefined, {}, { local: '2026-10-29T13:00:00+09:00' }, { utc: '2026-10-29T04:00:00' }, { utc: '2026-10-29T00:01:00Z' }, { utc: '2026-10-32T04:00:00Z' }]) {
    const raw = row(); raw.arrival.scheduledTime = scheduledTime;
    const result = await fetchAirportDepartures(args({ fetchImpl: mock([raw]) }));
    assert.equal(result.flights.length, 1);
    assert.equal(result.flights[0].scheduled_arrival, null);
  }
});

test('missing or invalid departure UTC, stale, out-of-window and non-departing flights are excluded', async () => {
  const records = ['Canceled', 'CanceledUncertain', 'GateClosed', 'Departed', 'EnRoute', 'Approaching', 'Arrived', 'Diverted'].map(status => row({ status }));
  for (const utc of [null, '2026-10-29T01:30:00', '2026-02-30T01:30:00Z', '2026-10-28T23:30:00Z', TO]) records.push(row({ departure: { scheduledTime: { utc } } }));
  const result = await fetchAirportDepartures(args({ fetchImpl: mock(records) }));
  assert.equal(result.flights.length, 0);
  assert.equal(result.metadata.excluded_count, records.length);
});

test('duplicate airport-board rows are removed and results sort by scheduled rather than delayed departure', async () => {
  const later = row({ number: 'MU 533', departure: { scheduledTime: { utc: '2026-10-29T03:00:00Z' }, revisedTime: { utc: '2026-10-29T03:10:00Z' } } });
  const earlier = row({ departure: { scheduledTime: { utc: '2026-10-29T01:30:00Z' }, revisedTime: { utc: '2026-10-29T03:30:00Z' } } });
  const result = await fetchAirportDepartures(args({ fetchImpl: mock([later, earlier, earlier]) }));
  assert.deepEqual(result.flights.map(f => f.flight_number), ['MU 531', 'MU 533']);
  assert.equal(result.metadata.excluded_count, 1);
});

test('HTTP quota and credential errors expose fixed messages and sanitized retry guidance only', async () => {
  await assert.rejects(fetchAirportDepartures(args({ fetchImpl: async () => new Response(KEY, { status: 429, headers: { 'retry-after': '120' } }) })), error => {
    safeError('PROVIDER_RATE_LIMITED')(error);
    assert.equal(error.status, 503); assert.equal(error.upstream_status, 429); assert.equal(error.retry_after_seconds, 120); return true;
  });
  for (const status of [401, 403]) await assert.rejects(fetchAirportDepartures(args({ fetchImpl: async () => new Response(KEY, { status }) })), safeError('PROVIDER_AUTH_FAILED'));
  for (const status of [302, 500, 503]) await assert.rejects(fetchAirportDepartures(args({ fetchImpl: async () => new Response(KEY, { status }) })), safeError('PROVIDER_UNAVAILABLE'));
  await assert.rejects(fetchAirportDepartures(args({ fetchImpl: async () => { throw new Error(`Rejected ${KEY}`); } })), safeError('PROVIDER_UNAVAILABLE'));
});

test('HTTP diagnostic status is numeric while an upstream error body containing the key stays private', async () => {
  for (const status of [400, 401, 403, 500]) {
    await assert.rejects(fetchAirportDepartures(args({ fetchImpl: async () => new Response(JSON.stringify({ message: `Upstream failed ${KEY}` }), { status }) })), error => {
      safeError(status === 401 || status === 403 ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_UNAVAILABLE')(error);
      assert.equal(error.upstream_status, status);
      assert.equal(error.status, 502);
      assert(!JSON.stringify(error).includes('Upstream failed'));
      return true;
    });
  }
  await assert.rejects(fetchAirportDepartures(args({ fetchImpl: async () => { throw new Error(KEY); } })), error => {
    safeError('PROVIDER_UNAVAILABLE')(error);
    assert.equal(error.upstream_status, null);
    return true;
  });
});

test('error envelopes, malformed bodies, oversized boards and unexpected schemas never become successful live data', async () => {
  const responses = [
    () => Response.json({ error: { message: KEY } }),
    () => Response.json({ errors: [{ message: KEY }], departures: [] }),
    () => Response.json({ message: KEY }),
    () => Response.json([{ departures: [] }]),
    () => Response.json({ departures: {} }),
    () => new Response(`not JSON ${KEY}`),
    () => new Response('{}', { headers: { 'content-length': '2000001' } }),
    () => Response.json({ departures: Array(3001).fill(null) }),
  ];
  for (const response of responses) await assert.rejects(fetchAirportDepartures(args({ fetchImpl: async () => response() })), safeError('INVALID_PROVIDER_RESPONSE'));
  const empty = await fetchAirportDepartures(args({ fetchImpl: async () => new Response(null, { status: 204 }) }));
  assert.deepEqual(empty.flights, []); assert.equal(empty.metadata.request_count, 1);
});

test('timeout aborts the sole upstream request and cannot expose provider credentials', async () => {
  let signal, calls = 0;
  await assert.rejects(fetchAirportDepartures(args({ timeoutMs: 15, fetchImpl: async (_, init) => { calls++; signal = init.signal; return new Promise(() => {}); } })), safeError('PROVIDER_TIMEOUT'));
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});

test('accidentally echoed credential in displayed provider text is redacted', async () => {
  const raw = row({ airline: { name: `Airline ${KEY}`, iata: 'MU' } });
  raw.arrival.airport.name = `Airport ${KEY}`;
  const result = await fetchAirportDepartures(args({ fetchImpl: mock([raw]) }));
  assert(!JSON.stringify(result).includes(KEY));
  assert.match(result.flights[0].airline.name, /\[redacted\]/);
});
