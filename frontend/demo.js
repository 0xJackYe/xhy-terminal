// Sample data for the ?demo preview of the portal. The real overview comes from
// /api/overview; nothing here is personal data.
const DAY = 86400000;
const zone = "Asia/Shanghai";

// The price drifts a little on every refresh and live tick so the page behaves like the live one.
let price = 67420 + Math.random() * 400;
const open = 66040.5;
let dayHigh = Math.max(68120.5, price), dayLow = 65810.2;
const STEP = 5 * 60000;
const started = Date.now();

function move(size) {
  price = Math.max(open * .96, price + (Math.random() - .48) * size);
  dayHigh = Math.max(dayHigh, price);
  dayLow = Math.min(dayLow, price);
}

// One walk per visit, bent to end at the opening price of the visit; later
// refreshes extend it every five minutes instead of drawing a new one.
const history = (() => {
  const points = [];
  let value = open;
  for (let i = 0; i <= 120; i++) {
    value += Math.sin(i / 9) * 38 + (Math.random() - .45) * 70;
    points.push([started - (120 - i) * STEP, value]);
  }
  const gap = price - points[points.length - 1][1];
  return points.map(([time, value], i) => [time, Math.round((value + gap * i / 120) * 100) / 100]);
})();

function chart(now) {
  while (history[history.length - 1][0] + STEP <= now) history.push([history[history.length - 1][0] + STEP, Math.round(price * 100) / 100]);
  return history.slice(-121);
}

const recent = [5, 2, 0].map((daysAgo, index) => ({
  kind: "threshold", metric: "daily_change", threshold_pct: [3.5, 2.5, 2.5][index],
  change_pct: [-3.52, 2.6, 2.51][index], price: [63120.2, 61001.2, 67698.4][index],
  at_ms: started - daysAgo * DAY - (index + 1) * 3600000,
}));
const settings = { enabled: true, thresholds_pct: [2.5, 3.5, 5], metric: "daily_change" };

// The same shape as the terminal's ?view=market stream, one tick at a time.
export function demoMarket() {
  move(14);
  return {
    market: { status: "live", price: Math.round(price * 100) / 100, change_pct: (price / open - 1) * 100, range_pct: (dayHigh - dayLow) / open * 100,
      day_open: open, day_high: dayHigh, day_low: dayLow, event_ms: Date.now() },
    settings, alerts: recent,
  };
}

export function demoOverview() {
  const now = Date.now();
  move(60);
  const updatedAt = new Date(now).toISOString();
  return {
    updatedAt, timezone: zone, demo: true,
    services: { btc: { status: "online" } },
    wallet: {
      status: "online", updatedAt, complete: true, stale: false,
      totalUsd: 49432.17, totalCny: 351957, btcHoldings: 0.61234567, btcHoldingsStale: false,
      pnl: { status: "fresh", averageCost: "58210.44", price: price.toFixed(2), unrealized: ((price - 58210.44) * 0.61234567).toFixed(2), returnPct: ((price / 58210.44 - 1) * 100).toFixed(2) },
      totalProfit: { status: "estimated", profit_usdt: (49432.17 + 1200 - 41850).toFixed(2), contributed_usdt: "41850.00", withdrawn_usdt: "1200.00", market_value_usdt: "49432.17" },
      assets: [
        { ccy: "BTC", usd_value: 41422.1, quantity: 0.61234567 },
        { ccy: "USDT", usd_value: 5210.3, quantity: 5210.3 },
        { ccy: "ETH", usd_value: 1999.17, quantity: 0.8 },
        { ccy: "BNB", usd_value: 612.4, quantity: 1.02 },
        { ccy: "OKB", usd_value: 188.2, quantity: 4 },
      ],
      locations: [
        { id: "offline", label: "离线钱包", usd_value: "41022.1" },
        { id: "okx", label: "欧易", usd_value: "6100.4" },
        { id: "binance", label: "币安", usd_value: "2309.67" },
      ],
      sources: [{ status: "connected" }, { status: "connected" }, { status: "connected" }],
    },
    alerts: {
      status: "online", updatedAt, stale: false, price: Math.round(price * 100) / 100, dayOpen: open, dayHigh, dayLow,
      changePct: (price / open - 1) * 100, rangePct: (dayHigh - dayLow) / open * 100,
      enabled: settings.enabled, thresholds: settings.thresholds_pct, metric: settings.metric, settings, recent, chart: chart(now),
    },
  };
}
