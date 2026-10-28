/** AeroDataBox airport-board adapter. A schedule is never a ticket offer. */
const HOST = 'aerodatabox.p.rapidapi.com';
const ORIGIN = `https://${HOST}`;
const MINUTE = 60_000, MAX_WINDOW = 12 * 60 * MINUTE, MAX_BYTES = 2_000_000;
const SOURCE = Object.freeze({
  name: 'AeroDataBox', url: 'https://aerodatabox.com/', environment: 'production',
  attribution: '航班时刻来源：AeroDataBox',
});

export class FlightProviderError extends Error {
  constructor(code, message, { status = 502, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'FlightProviderError';
    this.code = code;
    this.status = status;
    this.retry_after_seconds = retryAfterSeconds;
  }
}

function fail(code, message, details) { throw new FlightProviderError(code, message, details); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iata = value => typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
const country = value => typeof value === 'string' && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
const code2 = value => typeof value === 'string' && /^[A-Za-z0-9]{2}$/.test(value) ? value.toUpperCase() : null;
function instant(value, { utcOnly = false } = {}) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m || +m[1] < 2009 || +m[1] > 2100 || +m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59) return null;
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (date.getUTCFullYear() !== +m[1] || date.getUTCMonth() !== +m[2] - 1 || date.getUTCDate() !== +m[3]) return null;
  if (m[8] !== 'Z' && (+m[10] > 14 || +m[11] > 59 || +m[10] === 14 && +m[11] !== 0)) return null;
  if (utcOnly && m[8] !== 'Z' && m[8] !== '+00:00') return null;
  const result = Date.parse(value);
  return Number.isSafeInteger(result) ? result : null;
}
function zone(value) {
  if (typeof value !== 'string' || value.length > 64 || value !== 'UTC' && !value.includes('/')) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return value; } catch { return null; }
}
function localMinute(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp);
  const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}
function cleanText(value, secret, limit = 120) {
  if (typeof value !== 'string') return '';
  return value.split(secret).join('[redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}
function registryAirport(registry, code) {
  const item = registry instanceof Map ? registry.get(code) : object(registry) ? registry[code] : null;
  return object(item) && iata(item.iata) === code ? item : null;
}
function airportDetails(raw, fallback, secret, { destination = false } = {}) {
  const result = {
    iata: iata(raw?.iata ?? fallback?.iata),
    name: cleanText(fallback?.name ?? raw?.name ?? raw?.shortName, secret) || iata(raw?.iata ?? fallback?.iata),
    city: cleanText(fallback?.city ?? raw?.municipalityName, secret, 80),
    time_zone: zone(fallback?.time_zone ?? raw?.timeZone),
  };
  const nation = country(raw?.countryCode ?? fallback?.country_code);
  if (nation) result.country_code = nation;
  if (destination) result.country_name = cleanText(fallback?.country_name, secret, 80) || nation;
  for (const field of ['lat', 'lon']) {
    const n = fallback?.[field];
    if (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= (field === 'lat' ? 90 : 180)) result[field] = n;
  }
  return result;
}
function normalizedStatus(value) {
  const status = typeof value === 'string' ? value.toLowerCase() : 'unknown';
  return ({ expected: 'scheduled', checkin: 'check_in', gateclosed: 'gate_closed', enroute: 'en_route', arrived: 'arrived', canceled: 'cancelled', canceleduncertain: 'cancelled_uncertain' })[status] ?? (['scheduled', 'boarding', 'departed', 'delayed', 'approaching', 'diverted', 'unknown'].includes(status) ? status : 'unknown');
}

function normalizeFlight(raw, context) {
  const { airport, registry, from, to, now, secret } = context;
  // FIDS withLeg=true describes one airport-to-airport leg; never infer a leg from movement-only data.
  if (!object(raw) || !object(raw.departure) || !object(raw.arrival) || raw.isCargo !== false || raw.isPrivate === true) return null;
  if (['nonstop', 'isNonStop', 'isNonstop'].some(field => raw[field] != null && raw[field] !== true)) return null;
  if (raw.numberOfStops != null && raw.numberOfStops !== 0 || raw.stops != null && raw.stops !== 0 && (!Array.isArray(raw.stops) || raw.stops.length !== 0) || raw.segments != null && (!Array.isArray(raw.segments) || raw.segments.length !== 1)) return null;
  if (raw.codeshareStatus === 'IsCodeshared') return null;
  // AeroDataBox intentionally omits departure.airport when it is the requested airport.
  if (raw.departure.airport != null && (!object(raw.departure.airport) || iata(raw.departure.airport.iata) !== airport.iata)) return null;
  const destinationCode = iata(raw.arrival.airport?.iata);
  if (!destinationCode || destinationCode === airport.iata) return null;
  const knownDestination = registryAirport(registry, destinationCode);
  const sourceCountry = country(raw.arrival.airport?.countryCode);
  const knownCountry = country(knownDestination?.country_code);
  if (sourceCountry && knownCountry && sourceCountry !== knownCountry) return null;
  const destinationCountry = sourceCountry ?? knownCountry;
  if (!destinationCountry || destinationCountry === 'CN') return null;
  const departure = instant(raw.departure.scheduledTime?.utc);
  if (departure === null || departure < from || departure >= to || departure <= now) return null;
  const flightNumber = typeof raw.number === 'string' ? raw.number.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{2,3}\s?\d{1,5}[A-Z]?$/.test(flightNumber)) return null;
  const status = normalizedStatus(raw.status);
  if (['cancelled', 'cancelled_uncertain', 'gate_closed', 'departed', 'en_route', 'approaching', 'arrived', 'diverted'].includes(status)) return null;
  const parsedArrival = instant(raw.arrival.scheduledTime?.utc);
  const arrival = parsedArrival !== null && parsedArrival > departure && parsedArrival - departure <= 2 * 86_400_000 ? parsedArrival : null;
  const revised = instant(raw.departure.revisedTime?.utc);
  return {
    id: `aerodatabox:${airport.iata}:${destinationCode}:${flightNumber.replace(/\s/g, '')}:${departure}`,
    flight_number: flightNumber,
    airline: { name: cleanText(raw.airline?.name, secret, 100), iata: code2(raw.airline?.iata) },
    origin: airportDetails(null, airport, secret),
    destination: airportDetails({ ...raw.arrival.airport, countryCode: destinationCountry }, knownDestination, secret, { destination: true }),
    scheduled_departure: new Date(departure).toISOString(),
    scheduled_arrival: arrival === null ? null : new Date(arrival).toISOString(),
    estimated_departure: revised === null ? null : new Date(revised).toISOString(),
    status, nonstop: true, availability: 'schedule_only', price: null, booking_url: null,
    source: { ...SOURCE, checked_at: new Date(now).toISOString() },
    entry: { status: 'verify', official_url: null, checked_at: null, passport_country: null, note: '入境条件尚未核实。' },
  };
}

/**
 * UTC inputs must align to whole minutes and cover at most 12 hours: exactly one provider request.
 * Returns {flights, metadata}; no key is a needs_configuration result, other failures throw safe errors.
 * airportsByIata is an optional trusted Map/object of the core airport registry shape.
 */
export async function fetchAirportDepartures({ airport, from, to, apiKey, airportsByIata = {}, fetchImpl = fetch, now = Date.now(), timeoutMs = 10_000 } = {}) {
  const code = iata(airport?.iata), timeZone = zone(airport?.time_zone);
  const start = instant(from, { utcOnly: true }), end = instant(to, { utcOnly: true });
  const checked = typeof now === 'function' ? now() : now;
  if (!code || !timeZone || start === null || end === null || start % MINUTE !== 0 || end % MINUTE !== 0 || end <= start || end - start > MAX_WINDOW || !Number.isSafeInteger(checked) || checked < 1_230_768_000_000 || checked > 4_133_980_800_000) fail('INVALID_PROVIDER_INPUT', '航班数据查询的机场、时区或时间窗口无效（需整分钟且不超过 12 小时）。', { status: 400 });
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('INVALID_PROVIDER_INPUT', '航班数据查询配置无效。', { status: 400 });
  const checkedAt = new Date(checked).toISOString();
  const metadata = { provider: 'aerodatabox', status: 'ok', checked_at: checkedAt, window: { from: new Date(start).toISOString(), to: new Date(end).toISOString() }, source: { ...SOURCE, checked_at: checkedAt }, received_count: 0, excluded_count: 0, request_count: 0, query_windows: [], availability: 'schedule_only', coverage_warning: '时刻数据可能不完整；没有查询可售余票，购票前请向航空公司核实。' };
  if (apiKey == null || typeof apiKey === 'string' && !apiKey.trim()) return { flights: [], metadata: { ...metadata, status: 'needs_configuration' } };
  if (typeof apiKey !== 'string' || apiKey.length > 512 || !/^[\x21-\x7e]+$/.test(apiKey)) fail('INVALID_PROVIDER_KEY', '航班数据服务凭证格式无效。', { status: 400 });
  const normalizedAirport = { ...airport, iata: code, time_zone: timeZone };
  const windows = [[start, end]];
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new FlightProviderError('PROVIDER_TIMEOUT', '航班数据服务响应超时，请稍后重试。', { status: 504 })); }, timeoutMs); });
  const work = async () => {
    const flights = [], seen = new Set();
    for (const [begin, finish] of windows) {
      const fromLocal = localMinute(begin, timeZone), toLocal = localMinute(finish, timeZone);
      // Fixed origin, strict IATA, no user-controlled URLs and no redirect forwarding of the credential.
      const url = new URL(`/flights/airports/iata/${code}/${fromLocal}/${toLocal}`, ORIGIN);
      if (url.origin !== ORIGIN || url.hostname !== HOST) fail('INVALID_PROVIDER_INPUT', '航班数据服务地址无效。', { status: 400 });
      for (const [key, value] of Object.entries({ direction: 'Departure', withLeg: 'true', withCancelled: 'false', withCodeshared: 'false', withCargo: 'false', withPrivate: 'false', withLocation: 'false' })) url.searchParams.set(key, value);
      metadata.query_windows.push({ from: new Date(begin).toISOString(), to: new Date(finish).toISOString(), from_local: fromLocal, to_local: toLocal });
      metadata.request_count++;
      let response;
      try { response = await fetchImpl.call(globalThis, url.toString(), { method: 'GET', headers: { Accept: 'application/json', 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': HOST }, signal: controller.signal, redirect: 'error' }); }
      catch { fail('PROVIDER_UNAVAILABLE', '暂时无法连接航班数据服务，请稍后重试。'); }
      if (response?.redirected || !response || typeof response.status !== 'number') fail('INVALID_PROVIDER_RESPONSE', '航班数据服务返回了无法核实的响应。');
      if (response.status === 429) {
        const header = response.headers?.get('retry-after');
        const retry = typeof header === 'string' && /^\d{1,6}$/.test(header) ? Math.min(3600, Number(header)) : null;
        fail('PROVIDER_RATE_LIMITED', '航班数据服务额度或请求频率受限，请稍后重试。', { status: 503, retryAfterSeconds: retry });
      }
      if (response.status === 401 || response.status === 403) fail('PROVIDER_AUTH_FAILED', '航班数据服务凭证或套餐权限需检查。');
      if (!response.ok) fail('PROVIDER_UNAVAILABLE', '航班数据服务暂时不可用，请稍后重试。');
      if (response.status === 204) continue;
      const size = response.headers?.get('content-length');
      if (size && (/^\d+$/.test(size) ? Number(size) > MAX_BYTES : true)) fail('INVALID_PROVIDER_RESPONSE', '航班数据服务响应超出可核实范围。');
      let body;
      try {
        const raw = await response.text();
        if (raw.length > MAX_BYTES) fail('INVALID_PROVIDER_RESPONSE', '航班数据服务响应超出可核实范围。');
        body = JSON.parse(raw);
      } catch (error) {
        if (error instanceof FlightProviderError) throw error;
        fail('INVALID_PROVIDER_RESPONSE', '航班数据服务返回的数据格式无效。');
      }
      if (!object(body) || body.error != null || body.errors != null || body.success === false || !Object.hasOwn(body, 'departures') || body.departures !== null && !Array.isArray(body.departures)) fail('INVALID_PROVIDER_RESPONSE', '航班数据服务未返回可核实的出发时刻。');
      const rows = body.departures ?? [];
      if (rows.length > 3000) fail('INVALID_PROVIDER_RESPONSE', '航班数据服务响应超出可核实范围。');
      metadata.received_count += rows.length;
      for (const raw of rows) {
        const flight = normalizeFlight(raw, { airport: normalizedAirport, registry: airportsByIata, from: start, to: end, now: checked, secret: apiKey });
        if (!flight || seen.has(flight.id)) { metadata.excluded_count++; continue; }
        seen.add(flight.id); flights.push(flight);
      }
    }
    flights.sort((a, b) => Date.parse(a.scheduled_departure) - Date.parse(b.scheduled_departure) || a.flight_number.localeCompare(b.flight_number));
    return { flights, metadata };
  };
  try { return await Promise.race([work(), timeout]); }
  catch (error) {
    if (error instanceof FlightProviderError) throw error;
    fail('PROVIDER_UNAVAILABLE', '航班数据服务暂时不可用，请稍后重试。');
  } finally { clearTimeout(timer); controller.abort(); }
}
