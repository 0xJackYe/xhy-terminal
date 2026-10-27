// Sample data for the public copy of the portal. The real overview comes from
// /api/overview on the owner's computer; nothing here is personal data.
const DAY = 86400000;
const zone = "Asia/Shanghai";
// Diary days run on UTC+0, like the real diary.
const diaryDate = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

const meals = [
  { id: "demo-breakfast", type: "breakfast", title: "燕麦牛奶碗", status: "eaten", kcal: 522 },
  { id: "demo-lunch", type: "lunch", title: "鸡胸肉米饭", status: "eaten", kcal: 631 },
  { id: "demo-snack", type: "snack", title: "水果坚果", status: "eaten", kcal: 178 },
];
const weekKcal = [1720, 1580, 1745, null, 1690, 1735, 1331];

// The price drifts a little on every refresh so the page behaves like the live one.
let price = 67420 + Math.random() * 400;
const open = 66040.5;

function chart(now) {
  const points = [];
  let value = open;
  for (let i = 0; i <= 120; i++) {
    value += Math.sin(i / 9) * 38 + (Math.random() - .45) * 70;
    points.push([now - (120 - i) * 5 * 60000, Math.round(value * 100) / 100]);
  }
  // Bend the walk so it ends exactly at the current price without a jump.
  const gap = price - points[points.length - 1][1];
  return points.map(([time, value], i) => [time, Math.round((value + gap * i / 120) * 100) / 100]);
}

export function demoOverview() {
  const now = Date.now();
  price = Math.max(open * .96, price + (Math.random() - .48) * 60);
  const today = diaryDate(new Date(now));
  const days = weekKcal.map((kcal, index) => {
    const date = diaryDate(new Date(now - (6 - index) * DAY));
    return { date, recorded: kcal !== null, mealCount: kcal ? 3 : 0, totals: { kcal } };
  });
  const updatedAt = new Date(now).toISOString();
  const recent = [5, 2, 0].map((daysAgo, index) => ({
    kind: "threshold", metric: "daily_change", threshold_pct: [3.5, 2.5, 2.5][index],
    change_pct: [-3.52, 2.6, 2.51][index], price: [63120.2, 61001.2, 67698.4][index],
    at_ms: now - daysAgo * DAY - (index + 1) * 3600000,
  }));
  return {
    updatedAt, timezone: zone, demo: true,
    services: { diet: { status: "online" }, btc: { status: "online" } },
    diet: {
      status: "online", updatedAt, date: today, recorded: true,
      today: { date: today, recorded: true, mealCount: 3, itemCount: 10, meals,
        totals: { kcal: 1331, protein: 78.6, carbs: 158.1, fat: 45.4, fiber: 18 } },
      week: { recordedDays: 6, days },
    },
    wallet: {
      status: "online", updatedAt, complete: true, stale: false,
      totalUsd: 49432.17, totalCny: 351957, btcHoldings: 0.61234567, btcHoldingsStale: false,
      pnl: { status: "fresh", averageCost: "58210.44", price: price.toFixed(2), unrealized: ((price - 58210.44) * 0.61234567).toFixed(2), returnPct: ((price / 58210.44 - 1) * 100).toFixed(2) },
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
      status: "online", updatedAt, stale: false, price, dayOpen: open, dayHigh: Math.max(68120.5, price), dayLow: 65810.2,
      changePct: (price / open - 1) * 100, rangePct: (Math.max(68120.5, price) - 65810.2) / open * 100,
      enabled: true, thresholds: [2.5, 3.5, 5], metric: "daily_change", recent, chart: chart(now),
    },
  };
}
