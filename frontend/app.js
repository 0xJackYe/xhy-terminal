"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  // DOM writes happen only when a value actually changes, so the per-second
  // clock and live price leave everything else on the page untouched.
  const text = (id, value) => { const element = $(id), next = String(value ?? ""); if (element.textContent !== next) element.textContent = next; };
  const setData = (element, key, value) => { const next = String(value); if (element.dataset[key] !== next) element.dataset[key] = next; };
  const styles = new WeakMap();
  const setStyle = (element, property, value) => {
    let applied = styles.get(element);
    if (!applied) styles.set(element, applied = new Map());
    if (applied.get(property) === value) return;
    applied.set(property, value);
    element.style.setProperty(property, value);
  };
  const zone = "Asia/Shanghai";
  // Intl formatters are expensive to build; each shape is built once.
  const formats = new Map();
  const cached = (key, make) => formats.get(key) || formats.set(key, make()).get(key);
  const numberFormat = (min, max) => cached(`n${min}:${max}`, () => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: min, maximumFractionDigits: max }));
  const dateFormat = (key, locale, options) => cached(key, () => new Intl.DateTimeFormat(locale, options));
  const finite = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value));
  const number = (value, digits = 0) => finite(value) ? numberFormat(0, digits).format(Number(value)) : "—";
  // Prices and balances always show their cents: $41,422.10, not $41,422.1.
  const fixed = (value, digits = 2) => finite(value) ? numberFormat(digits, digits).format(Number(value)) : "—";
  const money = (value, digits = 2) => finite(value) ? `$${fixed(value, digits)}` : "—";
  const signed = (value, digits = 2) => finite(value) ? `${Number(value) > 0 ? "+" : ""}${fixed(value, digits)}` : "—";
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const views = {
    overview: { title: "总览", description: "资产与比特币行情。" },
    wallet: { title: "加密资产", description: "持仓、走势与价格警报。", url: "/btc/#wallet" },
    travel: { title: "快速出境", description: "附近机场、直飞时刻与入境准备。", url: "/travel" },
    alerts: { title: "价格警报", description: "比特币行情与价格提醒。", url: "/btc/#alerts" },
  };
  const state = { data: null, view: "overview", financeSection: "wallet", refreshing: false, failed: false, frames: new Map(), lastSuccess: null };
  const statusLabels = { online: "已同步", stale: "数据延迟", offline: "未连接", empty: "暂无记录", loading: "读取中" };
  const preferredTheme = matchMedia("(prefers-color-scheme: dark)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const easeOut = "cubic-bezier(.22,1,.36,1)";
  // The same page runs on the owner's computer (with local services it can
  // start) and on the cloud Worker (with its own backend). ?demo swaps in
  // labelled sample data: a design preview that never reads an account.
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  const demo = new URLSearchParams(location.search).has("demo");
  document.documentElement.dataset.demo = String(demo);

  // The main navigation's sliding pill.
  function segmentIndicator(container, activeSelector) {
    const pill = document.createElement("span");
    pill.className = "segment-indicator";
    pill.setAttribute("aria-hidden", "true");
    container.prepend(pill);
    let animation = null, ready = false;
    const move = (animate = true) => {
      const active = container.querySelector(activeSelector);
      if (!active) return;
      const from = { transform: getComputedStyle(pill).transform, width: `${pill.offsetWidth}px`, height: `${pill.offsetHeight}px` };
      const to = { transform: `translate3d(${active.offsetLeft}px,${active.offsetTop}px,0)`, width: `${active.offsetWidth}px`, height: `${active.offsetHeight}px` };
      animation?.cancel();
      Object.assign(pill.style, to);
      if (animate && ready && !reducedMotion.matches) animation = pill.animate([from, to], { duration: 420, easing: "cubic-bezier(.3,1.25,.5,1)" });
      container.dataset.indicatorReady = "true";
      ready = true;
    };
    new ResizeObserver(() => move(false)).observe(container);
    document.fonts?.ready.then(() => move(false));
    reducedMotion.addEventListener("change", () => { animation?.cancel(); move(false); });
    return move;
  }
  const moveNavigationIndicator = segmentIndicator(document.querySelector(".navigation"), '[aria-current="page"]');

  // Numbers ease between values instead of jumping; the first value appears directly.
  // A new value mid-tween continues from the number currently on screen.
  const tweens = new WeakMap(), shown = new WeakMap();
  function animateNumber(id, value, digits = 0, { cents = false, duration = 900 } = {}) {
    const element = $(id);
    if (!finite(value)) {
      cancelAnimationFrame(tweens.get(element));
      if (element.textContent !== "—") element.textContent = "—";
      delete element.dataset.value;
      shown.delete(element);
      return;
    }
    const to = Number(value);
    const from = element.dataset.value === undefined ? null : Number(element.dataset.value);
    if (from === to) return;
    cancelAnimationFrame(tweens.get(element));
    const final = cents ? fixed(to, digits) : number(to, digits);
    element.dataset.value = String(to);
    if (from === null || reducedMotion.matches || document.hidden) { element.textContent = final; shown.set(element, to); return; }
    const origin = shown.get(element) ?? from;
    const decimals = (final.split(".")[1] || "").length;
    const format = numberFormat(decimals, decimals);
    const start = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const current = origin + (to - origin) * (1 - Math.pow(1 - progress, 4));
      shown.set(element, current);
      element.textContent = progress < 1 ? format.format(current) : final;
      if (progress < 1) tweens.set(element, requestAnimationFrame(step));
    };
    tweens.set(element, requestAnimationFrame(step));
  }

  function setTheme(theme, persist = true) {
    window.XHYMotion?.cancelAll();
    const next = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    document.querySelector('meta[name="theme-color"]').content = next === "dark" ? "#0e0e0d" : "#f6f5f2";
    $("theme-toggle").setAttribute("aria-pressed", String(next === "dark"));
    $("theme-toggle").setAttribute("aria-label", `当前${next === "dark" ? "黑夜" : "白天"}模式，切换至${next === "dark" ? "白天" : "黑夜"}模式`);
    text("theme-label", next === "dark" ? "黑夜模式" : "白天模式");
    if (persist) { try { localStorage.setItem("xhy-theme", next); } catch {} }
    window.dispatchEvent(new CustomEvent("xhy:theme-change", { detail: { theme: next } }));
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    if (!document.startViewTransition || reducedMotion.matches) { setTheme(next); return; }
    // Reveal the new palette as a circle growing out of the toggle.
    const rect = $("theme-toggle").getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = document.startViewTransition(() => setTheme(next));
    transition.ready.then(() => {
      document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 620, easing: "cubic-bezier(.65,0,.35,1)", pseudoElement: "::view-transition-new(root)" });
    }).catch(() => {});
  }

  // The night shift runs 23:00–07:00 Beijing time on Monday to Friday nights
  // (09:00–17:00 in Denver while it keeps daylight time). A shift belongs to the
  // day it starts: Friday's ends on Saturday morning, and Saturday and Sunday
  // nights are free.
  const SHIFT_START = 23 * 3600, SHIFT_END = 7 * 3600, DAY = 86400;
  const workday = (day) => day >= 1 && day <= 5;
  function updateWorkSchedule(now) {
    const beijing = new Date(now.getTime() + 8 * 3600000);
    const seconds = beijing.getUTCHours() * 3600 + beijing.getUTCMinutes() * 60 + beijing.getUTCSeconds();
    const day = beijing.getUTCDay();
    const started = seconds >= SHIFT_START ? day : seconds < SHIFT_END ? (day + 6) % 7 : -1;
    const working = started >= 0 && workday(started);
    let remaining;
    if (working) remaining = (SHIFT_END - seconds + DAY) % DAY;
    else {
      // The next shift starts at 23:00 on the first workday from today.
      let ahead = seconds < SHIFT_START ? 0 : 1;
      while (!workday((day + ahead) % 7)) ahead++;
      remaining = ahead * DAY + SHIFT_START - seconds;
    }
    const days = Math.floor(remaining / DAY), hours = Math.floor(remaining % DAY / 3600), minutes = Math.floor(remaining % 3600 / 60);
    text("work-status", working ? "工作中" : day === 0 || day === 6 ? "周末" : "休息时间");
    text("work-countdown", `${working ? "距下班" : "距开工"} ${days ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${String(minutes).padStart(2, "0")} 分`}`);
    setData($("work-dot"), "working", working);
  }

  function timestamp(value, includeDate = false) {
    if (!value) return "尚未同步";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "尚未同步";
    return dateFormat(includeDate ? "stamp-date" : "stamp", "zh-CN", { timeZone: zone, ...(includeDate ? { month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
  }

  // Header clocks. Denver follows its daylight-saving changes (UTC−6 in
  // summer, UTC−7 in winter); New Delhi stays at UTC+5:30.
  const clocks = [
    { id: "clock", zone, name: "北京时间" },
    { id: "gmt-clock", zone: "UTC", name: "格林尼治时间" },
    { id: "denver-clock", zone: "America/Denver", name: "丹佛时间" },
    { id: "delhi-clock", zone: "Asia/Kolkata", name: "新德里时间" },
  ];
  let titledMinute = -1;
  // The clock text is itself a valid time string, so <time> needs no
  // per-second datetime attribute; dates and titles change at most once a minute.
  function updateClock() {
    const now = new Date();
    for (const clock of clocks) text(clock.id, dateFormat(`time-${clock.zone}`, "en-GB", { timeZone: clock.zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now));
    const minute = Math.floor(now.getTime() / 60000);
    if (minute !== titledMinute) {
      titledMinute = minute;
      for (const clock of clocks) {
        const date = dateFormat(`date-${clock.zone}`, "zh-CN", { timeZone: clock.zone, month: "long", day: "numeric", weekday: "short" }).format(now);
        const offset = dateFormat(`offset-${clock.zone}`, "en-US", { timeZone: clock.zone, timeZoneName: "shortOffset" }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value.replace("GMT", "UTC") || "";
        const title = `${clock.name} · ${date} · ${offset === "UTC" ? "UTC+0" : offset}`;
        const element = $(clock.id).parentElement;
        if (element.title !== title) element.title = title;
      }
    }
    text("today", dateFormat("today", "zh-CN", { timeZone: zone, month: "long", day: "numeric", weekday: "short" }).format(now));
    updateWorkSchedule(now);
    watchLive();
  }

  // Ticks land just after each second boundary. A hidden page skips the clock
  // and only checks every few seconds that its live title is still current.
  let clockTimer = 0;
  function tick() {
    clearTimeout(clockTimer);
    if (document.hidden) { watchLive(); clockTimer = setTimeout(tick, 5000); return; }
    updateClock();
    clockTimer = setTimeout(tick, 1000 - Date.now() % 1000 + 4);
  }

  function setModuleStatus(key, value) {
    const status = statusLabels[value] ? value : "offline";
    const element = $(`${key}-status`);
    setData(element, "status", status);
    if (element.lastElementChild.textContent !== statusLabels[status]) element.lastElementChild.textContent = statusLabels[status];
  }

  function setSource(key, status, updatedAt) {
    const element = $(`${key}-source-state`);
    if (demo) { setData(element, "status", "demo"); text(element.id, "示例数据"); text(`${key}-updated`, "演示模式不读取真实数据"); return; }
    setData(element, "status", status);
    text(element.id, status === "online" ? "连接正常" : status === "empty" ? "已连接 · 暂无记录" : statusLabels[status] || "未连接");
    text(`${key}-updated`, updatedAt ? `更新于 ${timestamp(updatedAt, true)}` : "尚未同步");
  }

  // Exchange wallet totals (e.g. Binance Earn) carry a readable label instead of a coin code.
  const assetName = (asset) => typeof asset.label === "string" && asset.label ? asset.label.slice(0, 40) : asset.ccy;

  function renderWallet(wallet = {}) {
    setModuleStatus("wallet", wallet.status || "offline");
    animateNumber("wallet-usd", wallet.totalUsd, 2, { cents: true });
    text("wallet-cny", finite(wallet.totalCny) ? `约 ¥${fixed(wallet.totalCny, 2)} CNY` : wallet.status === "offline" ? "暂时无法读取钱包估值" : "连接账户后显示资产总估值");
    animateNumber("wallet-btc", wallet.btcHoldings, 8);
    text("wallet-btc-label", `BTC 持仓${finite(wallet.btcHoldings) && wallet.btcHoldingsStale ? " · 已延迟" : ""}`);
    const list = $("wallet-assets");
    const assets = (Array.isArray(wallet.assets) ? wallet.assets : []).filter((asset) => asset && typeof asset.ccy === "string" && finite(asset.usd_value));
    const visible = assets.slice(0, 8);
    renderPnl(wallet.pnl);
    renderTotalProfit(wallet.totalProfit);
    renderLocations(Array.isArray(wallet.locations) ? wallet.locations : [], wallet);
    text("wallet-asset-count", assets.length ? `${number(assets.length)} 种${assets.length > visible.length ? ` · 显示前 ${visible.length}` : ""}` : "");
    const total = finite(wallet.totalUsd) && Number(wallet.totalUsd) > 0 ? Number(wallet.totalUsd) : assets.reduce((sum, asset) => sum + Math.max(0, Number(asset.usd_value)), 0);
    const signature = visible.map((asset) => asset.ccy).join("|");
    // Rebuild rows only when the set of coins changes; otherwise update in place.
    if (list.dataset.signature !== signature || !visible.length) {
      list.replaceChildren();
      list.dataset.signature = signature;
      visible.forEach((asset, index) => {
        const row = document.createElement("div");
        row.className = "asset-row";
        row.style.setProperty("--d", index);
        const name = document.createElement("span");
        name.className = "asset-name";
        const share = document.createElement("span");
        share.className = "asset-share";
        name.append(document.createTextNode(assetName(asset)), share);
        const value = document.createElement("span");
        value.className = "asset-value";
        const bar = document.createElement("span");
        bar.className = "asset-bar";
        bar.setAttribute("aria-hidden", "true");
        bar.append(document.createElement("span"));
        row.append(name, value, bar);
        list.append(row);
      });
    }
    visible.forEach((asset, index) => {
      const row = list.children[index];
      const ratio = total > 0 ? clamp(Number(asset.usd_value) / total) : 0;
      const share = row.querySelector(".asset-share"), value = row.querySelector(".asset-value");
      const shareText = total > 0 ? `${number(ratio * 100, 1)}%` : "", valueText = money(asset.usd_value);
      const title = finite(asset.quantity) ? `${assetName(asset)} 持仓 ${number(asset.quantity, 8)}，估值 ${valueText}` : `${assetName(asset)} 估值 ${valueText}`;
      if (share.textContent !== shareText) share.textContent = shareText;
      if (value.textContent !== valueText) value.textContent = valueText;
      if (row.title !== title) row.title = title;
      const fill = row.querySelector(".asset-bar > span");
      requestAnimationFrame(() => setStyle(fill, "transform", `scaleX(${ratio})`));
    });
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "inline-empty";
      empty.textContent = wallet.status === "offline" ? "钱包连接恢复后显示资产明细" : "暂时没有可显示的资产明细";
      list.append(empty);
    }
    const scopeNote = typeof wallet.scopeNote === "string" ? wallet.scopeNote : "";
    // The coverage note shows only while the valuation is incomplete; otherwise it is the total's tooltip.
    const walletNote = wallet.status === "offline" ? "钱包服务暂未连接，可重试同步或独立打开。" : wallet.complete === false ? `当前资产估值不完整。${scopeNote || "部分账户或资产暂未计入。"}` : "";
    const metric = $("wallet-usd").parentElement;
    if (metric.title !== scopeNote) metric.title = scopeNote;
    text("wallet-note", walletNote);
    $("wallet-note").hidden = !walletNote;
    text("wallet-module-updated", `加密钱包 · ${wallet.updatedAt ? `更新于 ${timestamp(wallet.updatedAt, true)}` : "尚未同步"}`);
  }

  const tone = (value) => finite(value) ? Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "" : "";
  function signedCell(id, value, suffix = "", empty = "—") {
    const element = $(id);
    if (element.className !== tone(value)) element.className = tone(value);
    text(id, finite(value) ? `${signed(value)}${suffix}` : empty);
  }

  function renderPnl(pnl) {
    const metrics = pnl && typeof pnl === "object" ? pnl : {};
    text("wallet-avg-cost", fixed(metrics.averageCost));
    signedCell("wallet-unrealized", metrics.unrealized);
    signedCell("wallet-return", metrics.returnPct, "%", "");
  }

  // Lifetime result of the whole crypto portfolio: market value plus everything
  // withdrawn minus everything put in (realized and unrealized together).
  function renderTotalProfit(total) {
    const data = total && typeof total === "object" ? total : {};
    const profit = finite(data.profit_usdt) ? Number(data.profit_usdt) : null;
    const contributed = finite(data.contributed_usdt) ? Number(data.contributed_usdt) : null;
    signedCell("wallet-total-profit", profit);
    signedCell("wallet-total-return", profit !== null && contributed > 0 ? (profit / contributed * 100).toFixed(2) : null, "%", "");
    const cell = $("wallet-total-cell");
    const title = profit === null
      ? (typeof data.reason === "string" && data.reason ? data.reason : local ? "本机终端不核算累计盈亏，请在云端终端查看。" : "累计盈亏需要已核对的投入、提出记录。")
      : `当前市值 ${fixed(data.market_value_usdt)} + 已提出 ${fixed(data.withdrawn_usdt)} − 累计投入 ${fixed(data.contributed_usdt)}（USDT）`;
    if (cell.title !== title) cell.title = title;
  }

  const locationColors = { offline: "var(--accent)", okx: "var(--text)", binance: "var(--amber)" };
  function renderLocations(locations, wallet) {
    const rows = locations.filter((row) => row && typeof row.label === "string" && finite(row.usd_value) && Number(row.usd_value) > 0);
    const total = rows.reduce((sum, row) => sum + Number(row.usd_value), 0);
    const split = $("wallet-locations");
    const legend = $("wallet-location-legend");
    if (split.dataset.signature !== rows.map((row) => row.id).join("|")) {
      split.dataset.signature = rows.map((row) => row.id).join("|");
      split.replaceChildren(...rows.map((row) => {
        const segment = document.createElement("span");
        segment.style.background = locationColors[row.id] || "var(--faint)";
        return segment;
      }));
    }
    rows.forEach((row, index) => {
      const segment = split.children[index];
      requestAnimationFrame(() => setStyle(segment, "width", `calc((100% - ${(rows.length - 1) * 2}px) * ${Number(row.usd_value) / total})`));
    });
    const signature = JSON.stringify([wallet.status, rows.map((row) => [row.id, row.label, row.usd_value])]);
    if (legend.dataset.signature !== signature) {
      legend.dataset.signature = signature;
      legend.replaceChildren(...rows.map((row) => {
        const item = document.createElement("li");
        item.style.setProperty("--c", locationColors[row.id] || "var(--faint)");
        const label = document.createElement("span");
        label.textContent = row.label;
        const value = document.createElement("strong");
        value.textContent = money(row.usd_value, 0);
        const share = document.createElement("small");
        share.textContent = `${number(Number(row.usd_value) / total * 100, 1)}%`;
        value.append(share);
        item.append(label, value);
        return item;
      }));
      if (!rows.length) {
        const empty = document.createElement("li");
        empty.className = "inline-empty";
        empty.textContent = wallet.status === "offline" ? "钱包服务未连接" : "暂无可核实的存放位置";
        legend.append(empty);
      }
    }
    const sources = Array.isArray(wallet.sources) ? wallet.sources.filter((source) => source && typeof source === "object") : [];
    const connected = sources.filter((source) => source.status === "connected").length;
    text("wallet-location-note", sources.length ? `${connected}/${sources.length} 个来源已连接` : "");
  }

  let sparkDrawn = false;
  function renderSparkline(points, open, tip) {
    const chart = $("alerts-chart");
    const valid = (Array.isArray(points) ? points : []).filter((point) => Array.isArray(point) && finite(point[0]) && finite(point[1])).map((point) => [Number(point[0]), Number(point[1])]);
    // The live price extends the minute chart, so the end of the line follows each tick.
    if (tip && valid.length) {
      const last = valid[valid.length - 1];
      if (tip[0] > last[0]) valid.push(tip);
      else valid[valid.length - 1] = [last[0], tip[1]];
    }
    setData(chart, "empty", valid.length < 2);
    if (valid.length < 2) { text("alerts-chart-caption", ""); return; }
    const prices = valid.map((point) => point[1]);
    const bounds = finite(open) ? [...prices, Number(open)] : prices;
    const low = Math.min(...bounds), high = Math.max(...bounds);
    const span = high - low || 1, start = valid[0][0], end = valid[valid.length - 1][0], width = end - start || 1;
    const x = (time) => ((time - start) / width * 300).toFixed(1);
    const y = (price) => (76 - (price - low) / span * 72).toFixed(1);
    const line = valid.map((point, index) => `${index ? "L" : "M"}${x(point[0])},${y(point[1])}`).join("");
    const svg = chart.querySelector("svg"), path = svg.querySelector(".spark-line");
    if (path.getAttribute("d") !== line) {
      path.setAttribute("d", line);
      svg.querySelector(".spark-area").setAttribute("d", `${line}L300,80L0,80Z`);
    }
    const openLine = svg.querySelector(".spark-open");
    setStyle(openLine, "display", finite(open) ? "" : "none");
    if (finite(open) && openLine.getAttribute("y1") !== y(Number(open))) { openLine.setAttribute("y1", y(Number(open))); openLine.setAttribute("y2", y(Number(open))); }
    setData(chart, "trend", finite(open) ? prices[prices.length - 1] >= Number(open) ? "up" : "down" : "flat");
    const hours = (end - start) / 3600000;
    text("alerts-chart-caption", `近 ${hours >= 1 ? `${number(hours, 0)} 小时` : `${number(hours * 60, 0)} 分钟`}${finite(open) ? " · 虚线为开盘价" : ""}`);
    // The line draws itself in once (and again whenever the overview reappears);
    // later updates only reshape it.
    if (!sparkDrawn && !reducedMotion.matches) { chart.dataset.draw = "true"; sparkDrawn = true; }
  }

  function flashPrice(previous, next) {
    if (!finite(previous) || !finite(next) || Number(previous) === Number(next) || reducedMotion.matches || document.hidden) return;
    const metric = $("alerts-price").parentElement;
    metric.classList.remove("tick-up", "tick-down");
    metric.classList.add(Number(next) > Number(previous) ? "tick-up" : "tick-down");
    // Two frames let the instant colour paint before it fades back.
    requestAnimationFrame(() => requestAnimationFrame(() => metric.classList.remove("tick-up", "tick-down")));
  }

  // Runs for the minute overview and for every live tick, so each part only
  // touches the DOM when its value changes.
  function renderAlerts(alerts = {}) {
    setModuleStatus("alerts", alerts.status || "offline");
    flashPrice($("alerts-price").dataset.value, alerts.price);
    animateNumber("alerts-price", alerts.price, 2, { cents: true, duration: 600 });
    const rangeMode = ["day_range", "amplitude"].includes(alerts.metric || alerts.settings?.metric);
    const changeValue = rangeMode ? alerts.rangePct : alerts.changePct;
    const change = $("alerts-change");
    const changeClass = `change-badge${finite(changeValue) ? Number(changeValue) >= 0 ? " positive" : " negative" : ""}`;
    if (change.className !== changeClass) change.className = changeClass;
    text("alerts-change", finite(changeValue) ? `${rangeMode ? fixed(changeValue) : signed(changeValue)}%` : "—");
    text("alerts-change-label", rangeMode ? "北京时间今日振幅" : "北京时间今日涨跌");
    text("alerts-threshold-label", rangeMode ? "当日振幅警报" : "当日涨跌幅警报");
    text("alerts-low", money(alerts.dayLow));
    text("alerts-high", money(alerts.dayHigh));
    text("alerts-open", money(alerts.dayOpen));
    renderRecentAlerts(Array.isArray(alerts.recent) ? alerts.recent : [], alerts.status);
    const tipAt = alerts.updatedAt ? Date.parse(alerts.updatedAt) : NaN;
    renderSparkline(alerts.chart, alerts.dayOpen, finite(alerts.price) && Number.isFinite(tipAt) ? [tipAt, Number(alerts.price)] : null);
    const range = $("alerts-range");
    const hasRange = finite(alerts.price) && finite(alerts.dayLow) && finite(alerts.dayHigh) && Number(alerts.dayHigh) > Number(alerts.dayLow);
    setData(range, "ready", hasRange);
    if (hasRange) setStyle(range, "--pos", String(clamp((Number(alerts.price) - Number(alerts.dayLow)) / (Number(alerts.dayHigh) - Number(alerts.dayLow)))));
    const enabled = alerts.enabled ?? alerts.settings?.enabled;
    text("alerts-enabled", enabled === true ? "已开启" : enabled === false ? "已暂停" : "未读取");
    setData($("alerts-enabled"), "enabled", enabled);
    const thresholds = (Array.isArray(alerts.thresholds) ? alerts.thresholds : Array.isArray(alerts.settings?.thresholds_pct) ? alerts.settings.thresholds_pct : []).filter(finite).map(Number);
    const current = finite(changeValue) ? Math.abs(Number(changeValue)) : null;
    renderThresholds(thresholds, current, rangeMode);
    renderMeter(thresholds, current);
    text("alerts-note", alerts.status === "offline" ? "行情服务暂未连接，可独立打开检查连接。" : alerts.stale || alerts.status === "stale" ? "行情已延迟，当前价格为最近一次收到的数据。" : enabled === false ? "价格警报已暂停，可在警报页重新开启。" : rangeMode ? "当日振幅 =（最高价 − 最低价）÷ 今日开盘价。" : "以北京时间 00:00 为当日涨跌幅基准。");
    text("alerts-module-updated", `Binance Spot · ${alerts.updatedAt ? `更新于 ${timestamp(alerts.updatedAt, true)}` : "尚未同步"}`);
  }

  function renderThresholds(thresholds, current, rangeMode) {
    const list = $("alerts-thresholds");
    const signature = JSON.stringify([rangeMode, thresholds]);
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren(...thresholds.map((threshold) => {
        const chip = document.createElement("span");
        chip.className = "threshold-chip";
        chip.textContent = `${rangeMode ? "" : "± "}${number(threshold, 2)}%`;
        chip.title = rangeMode ? `当日振幅达到 ${number(threshold, 2)}% 时触发警报` : `当日涨跌幅达到正负 ${number(threshold, 2)}% 时触发警报`;
        return chip;
      }));
      if (!thresholds.length) {
        const empty = document.createElement("span");
        empty.className = "inline-empty";
        empty.textContent = "暂无可读取的警报阈值";
        list.append(empty);
      }
    }
    thresholds.forEach((threshold, index) => setData(list.children[index], "hit", current !== null && current >= threshold));
  }

  // Local snapshots list alerts oldest first and the cloud newest first, so rows go by time.
  const newestAlerts = (alerts, count) => (Array.isArray(alerts) ? alerts : []).filter((alert) => alert && typeof alert === "object")
    .sort((a, b) => (finite(b.at_ms) ? Number(b.at_ms) : 0) - (finite(a.at_ms) ? Number(a.at_ms) : 0)).slice(0, count);

  function renderRecentAlerts(recent, status) {
    const list = $("alerts-recent");
    const rows = newestAlerts(recent, 4);
    text("alerts-recent-count", recent.length ? `共 ${number(recent.length)} 条` : "");
    // Live ticks repeat the same alerts every second; rows change only with a new alert.
    const signature = JSON.stringify([rows.length ? "" : status === "offline", rows.map((alert) => [alert.at_ms, alert.kind, alert.metric, alert.threshold_pct, alert.change_pct, alert.range_pct, alert.price])]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    list.replaceChildren();
    rows.forEach((alert, index) => {
      const row = document.createElement("li");
      row.style.setProperty("--d", index);
      const time = document.createElement("span");
      time.className = "alert-time";
      const at = finite(alert.at_ms) ? new Date(Number(alert.at_ms)) : null;
      time.textContent = at ? dateFormat("alert-time", "zh-CN", { timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at) : "—";
      const range = alert.metric === "day_range" || alert.metric === "amplitude";
      const value = range ? alert.range_pct : alert.change_pct;
      const change = document.createElement("span");
      change.className = `alert-change${!range && finite(value) ? Number(value) >= 0 ? " positive" : " negative" : ""}`;
      change.textContent = finite(value) ? `${range ? fixed(value) : signed(value)}%` : "—";
      const tier = document.createElement("span");
      tier.className = "alert-tier";
      tier.textContent = finite(alert.threshold_pct) ? `${number(alert.threshold_pct, 2)}% 档${alert.kind === "test" ? " · 测试" : ""}` : alert.kind === "test" ? "测试警报" : "";
      const price = document.createElement("span");
      price.className = "alert-price";
      price.textContent = money(alert.price);
      row.append(time, change, tier, price);
      list.append(row);
    });
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "inline-empty";
      empty.textContent = status === "offline" ? "行情服务未连接" : "暂无警报记录";
      list.append(empty);
    }
  }

  function renderMeter(thresholds, current) {
    // The meter shows today's move against the alert lines, which appear as ticks.
    const meter = $("alerts-meter");
    const scale = Math.max(...thresholds, current ?? 0, 0) * 1.2 || 1;
    let ticks = meter.querySelectorAll(".meter-tick");
    if (ticks.length !== thresholds.length) {
      ticks.forEach((tick) => tick.remove());
      meter.append(...thresholds.map(() => Object.assign(document.createElement("span"), { className: "meter-tick" })));
      ticks = meter.querySelectorAll(".meter-tick");
    }
    thresholds.forEach((threshold, index) => setStyle(ticks[index], "left", `${clamp(threshold / scale) * 100}%`));
    const lowest = thresholds.length ? Math.min(...thresholds) : null;
    setData(meter, "level", current === null || lowest === null ? "none" : current >= lowest ? "hit" : current >= lowest * .75 ? "near" : "calm");
    const fill = meter.querySelector(".meter-fill");
    requestAnimationFrame(() => setStyle(fill, "transform", `scaleX(${current === null ? 0 : clamp(current / scale)})`));
  }

  function applyLinks(links = {}) {
    for (const key of ["wallet", "alerts"]) {
      if (typeof links[key] !== "string") continue;
      // Keep all embedded project routes on this origin; credentials never enter the client.
      try {
        const url = new URL(links[key], location.origin);
        if (url.origin === location.origin && /^\/btc(\/|$)/.test(url.pathname)) views[key].url = url.pathname + url.search + url.hash;
      } catch { /* Keep the working default route. */ }
    }
    $("btc-source-link").href = views.alerts.url;
    if (state.view !== "overview") $("open-project").href = projectUrl(state.view);
  }

  function renderOverview(data) {
    applyLinks(data.links);
    renderWallet(data.wallet);
    renderAlerts(withLive(data.alerts));
    renderServiceNotice();
    const btcService = data.services?.btc || {};
    setSource("btc", btcService.status || data.alerts?.status || data.wallet?.status || "offline", latestDate([data.wallet?.updatedAt, data.alerts?.updatedAt]));
    text("last-sync", demo ? "演示模式：数据为示例，不是真实账户。去掉地址中的 ?demo 即显示真实数据。" : `总览同步于 ${timestamp(data.updatedAt || state.lastSuccess, true)} · 北京时间 · 每分钟自动刷新`);
    updateConnection();
    updateProjectHint();
  }

  function latestDate(values) {
    const dates = values.filter((value) => value && !Number.isNaN(new Date(value).getTime()));
    return dates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
  }

  function updateConnection() {
    let status = "online";
    let label = "数据已同步";
    if (state.failed) { status = state.data ? "stale" : "offline"; label = state.data ? "同步已中断" : "暂时无法同步"; }
    else if (!state.data) { status = "loading"; label = "正在同步"; }
    else {
      const statuses = [state.data.wallet?.status, state.data.alerts?.status];
      if (statuses.every((value) => value === "offline")) { status = "offline"; label = "项目未连接"; }
      else if (statuses.some((value) => value === "stale" || value === "offline")) { status = "stale"; label = "部分数据待同步"; }
      else label = `已同步 ${timestamp(state.data.updatedAt || state.lastSuccess).slice(0, 5)}`;
    }
    if (demo && state.data && !state.failed) { status = "demo"; label = "演示数据"; }
    setData($("connection"), "status", status);
    text("connection-text", label);
  }

  // Live price: while the overview is on screen it follows the BTC terminal's
  // lean market stream (no chart history, about 1 KB a second), so the price,
  // day change, range, alert meter and chart tip move every second between the
  // minute refreshes. The public demo simulates the same ticks.
  const live = { source: null, alerts: null, at: 0, retries: 0, retry: 0, idle: 0, demo: 0 };
  const liveFresh = () => Boolean(live.alerts) && Date.now() - live.at < 15000;
  // The minute overview keeps its chart; fresher live fields win, except
  // empty ones (a feed still connecting must not erase the last known price).
  const withLive = (alerts = {}) => liveFresh() ? { ...alerts, ...Object.fromEntries(Object.entries(live.alerts).filter(([, value]) => value !== null && value !== undefined)) } : alerts;

  function liveAlerts(snapshot) {
    const market = snapshot.market, settings = snapshot.settings && typeof snapshot.settings === "object" ? snapshot.settings : {};
    const streaming = market.status === "live";
    return {
      status: streaming ? "online" : "stale", stale: !streaming,
      updatedAt: finite(market.event_ms) ? new Date(Number(market.event_ms)).toISOString() : null,
      price: market.price, changePct: market.change_pct, rangePct: market.range_pct,
      dayOpen: market.day_open, dayHigh: market.day_high, dayLow: market.day_low,
      enabled: settings.enabled, thresholds: Array.isArray(settings.thresholds_pct) ? settings.thresholds_pct : [], metric: settings.metric, settings,
      recent: newestAlerts(snapshot.alerts, 8),
    };
  }

  function acceptLive(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || !snapshot.market || typeof snapshot.market !== "object") return;
    const recovered = !liveFresh() && state.data?.alerts?.status === "offline";
    live.alerts = liveAlerts(snapshot);
    live.at = Date.now();
    live.retries = 0;
    setLiveBadge(live.alerts.status === "online");
    if (state.data) renderAlerts(withLive(state.data.alerts));
    updateTitle();
    // The BTC service came back: bring the wallet and connection details up to date too.
    if (recovered) refresh();
  }

  function setLiveBadge(on) {
    const badge = $("alerts-live");
    if (badge.hidden === on) badge.hidden = !on;
  }

  function startLive() {
    clearTimeout(live.idle);
    if (state.view !== "overview" || document.hidden) return;
    if (demo) {
      if (!live.demo) live.demo = setInterval(() => { if (state.data) import("/demo.js").then((module) => acceptLive(module.demoMarket()), () => {}); }, 2000);
      return;
    }
    if (live.source || live.retry || typeof EventSource !== "function") return;
    const source = new EventSource("/btc/api/terminal/events?view=market");
    live.source = source;
    source.addEventListener("snapshot", (event) => {
      try { acceptLive(JSON.parse(event.data)); } catch { /* A malformed frame waits for the next one. */ }
    });
    source.addEventListener("error", () => {
      // The browser reconnects a dropped stream by itself (and the badge goes
      // out if that takes long). An error response — the BTC service is down —
      // closes the stream instead: retry with a growing delay.
      if (source.readyState !== EventSource.CLOSED) return;
      stopLive();
      live.retry = setTimeout(() => { live.retry = 0; startLive(); }, Math.min(60000, 2000 * 2 ** live.retries++));
    });
  }

  function stopLive() {
    live.source?.close();
    live.source = null;
    clearTimeout(live.retry);
    clearInterval(live.demo);
    live.retry = live.demo = 0;
    setLiveBadge(false);
    updateTitle();
  }

  // Checked by the clock each second: a stalled stream stops looking live.
  function watchLive() {
    if (live.alerts && !liveFresh() && !$("alerts-live").hidden) { setLiveBadge(false); updateTitle(); }
  }

  // The tab shows the live price while the overview is open, even in the background.
  function updateTitle() {
    const view = views[state.view] || views.overview;
    const price = state.view === "overview" && liveFresh() ? live.alerts.price : null;
    const title = finite(price) ? `BTC ${fixed(price)} · XHY Terminal` : `XHY Terminal · ${state.view === "overview" ? "个人总终端" : view.title}`;
    if (document.title !== title) document.title = title;
  }

  // One click asks the portal to start whichever local service is down; the
  // overview then checks back until both answer.
  const recovery = { running: false, timer: 0 };
  function offlineServices() {
    if (demo || !local || !state.data?.services) return [];
    return state.data.services.btc?.status === "offline" ? ["比特币终端"] : [];
  }

  // The overview shows a notice; a project page whose service is down says the
  // same inside its frame, so both report progress and the outcome.
  function renderServiceNotice(message) {
    const missing = offlineServices();
    const notice = $("service-notice");
    const show = Boolean(message) || recovery.running || missing.length > 0;
    if (notice.hidden === show) notice.hidden = !show;
    if (show) text("service-notice-text", message || (recovery.running ? `正在启动${missing.join("、") || "本机服务"}…` : `${missing.join("、")}未运行。`));
    for (const [key, entry] of state.frames) {
      if (!entry.failed) continue;
      entry.message.textContent = startable(key) && (message || recovery.running) ? message || `正在启动${serviceNames[key]}…` : frameFailure(key, entry);
    }
    for (const button of document.querySelectorAll("[data-start-services]")) {
      button.disabled = recovery.running;
      button.setAttribute("aria-busy", String(recovery.running));
    }
  }

  async function startServices() {
    if (recovery.running || demo || !local) return;
    recovery.running = true;
    clearTimeout(recovery.timer);
    renderServiceNotice();
    try {
      const response = await fetch("/api/services/ensure", { method: "POST", headers: { "X-Terminal-Request": "1" }, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      recovery.running = false;
      renderServiceNotice("无法从网页启动本机服务，请在电脑上运行 launch.py。");
      return;
    }
    text("announcer", "正在启动本机服务。");
    const deadline = Date.now() + 45000;
    const check = async () => {
      await refresh();
      const done = !offlineServices().length && !state.failed;
      if (done || Date.now() > deadline) {
        recovery.running = false;
        renderServiceNotice(done ? "" : "服务启动时间较长，请在电脑上运行 launch.py 检查。");
        if (done) { text("announcer", "本机服务已恢复。"); reloadFailedFrames(); stopLive(); live.retries = 0; startLive(); }
        return;
      }
      recovery.timer = setTimeout(check, 2500);
    };
    recovery.timer = setTimeout(check, 1500);
  }

  function reloadFailedFrames() {
    for (const [key, entry] of state.frames) {
      if (!entry.failed || !startable(key)) continue;
      loadFrame(key, true);
      if (state.view === key) showOnlyFrame(key);
    }
  }

  async function refresh(manual = false) {
    if (state.refreshing) return;
    state.refreshing = true;
    const button = $("refresh");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      let data;
      if (demo) data = (await import("/demo.js")).demoOverview();
      else {
        const response = await fetch("/api/overview", { headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
      }
      if (!data || typeof data !== "object" || !["wallet", "alerts"].some((key) => data[key] && typeof data[key] === "object")) throw new Error("Invalid overview response");
      state.data = data;
      state.failed = false;
      state.lastSuccess = new Date().toISOString();
      $("global-notice").hidden = true;
      renderOverview(data);
      if (manual) text("announcer", "总览数据已刷新。");
    } catch {
      state.failed = true;
      text("global-notice", state.data ? "总览暂时无法同步，当前保留最近一次显示的数据。可重试刷新，或打开对应项目。" : "暂时无法读取项目数据。可重试刷新，或打开对应项目检查连接。");
      $("global-notice").hidden = false;
      if (!state.data) {
        renderWallet({ status: "offline" });
        renderAlerts({ status: "offline" });
        setSource("btc", "offline", null);
      } else {
        for (const key of ["wallet", "alerts"]) setModuleStatus(key, "stale");
        setSource("btc", "stale", latestDate([state.data.wallet?.updatedAt, state.data.alerts?.updatedAt]));
      }
      updateConnection();
      updateProjectHint();
      if (manual) text("announcer", "数据同步失败，请稍后重试。");
    } finally {
      clearTimeout(timeout);
      // A manual refresh keeps its spinner for one full turn so it never flickers.
      const rest = manual ? Math.max(0, 600 - (performance.now() - started)) : 0;
      setTimeout(() => {
        state.refreshing = false;
        button.disabled = false;
        button.setAttribute("aria-busy", "false");
      }, rest);
    }
  }

  function projectStatus(key) {
    if (key === "travel") return "online";
    if (!state.data) return state.failed ? "offline" : "loading";
    if (state.failed) return "stale";
    return state.data.services?.btc?.status || state.data[key === "wallet" ? "wallet" : "alerts"]?.status;
  }

  function updateProjectHint() {
    if (state.view === "overview") return;
    const status = projectStatus(state.view);
    const hint = $("project-hint");
    hint.dataset.status = status || "loading";
    hint.textContent = status === "offline" ? "暂未连接，请重新加载或独立打开。" : status === "stale" ? "数据同步稍有延迟，可独立打开检查。" : status === "loading" ? "正在加载…" : "";
  }

  function projectUrl(key) {
    return views[key === "wallet" ? state.financeSection : key].url;
  }

  function setFinanceSection(entry, url) {
    entry.pendingUrl = url;
    if (!entry.loaded) return;
    try {
      const target = new URL(url, location.origin);
      const current = entry.iframe.contentWindow.location;
      if (current.pathname === target.pathname && current.search === target.search) {
        if (current.hash !== target.hash) current.hash = target.hash;
      } else entry.iframe.src = url;
    } catch { entry.iframe.src = url; }
  }

  function hideOverlay(overlay) {
    if (overlay.hidden) return;
    if (reducedMotion.matches || !overlay.animate) { overlay.hidden = true; return; }
    overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease" }).finished.then(() => { overlay.hidden = true; }, () => { overlay.hidden = true; });
  }

  const demoNotes = {
    wallet: ["加密资产", "欧易、币安与离线钱包的合计持仓、定投成本与浮盈，以及比特币价格警报。"],
    travel: ["快速出境", "从附近机场出发，比较来得及赶上的国际直飞候选，并附入境说明。"],
  };
  function loadDemoFrame(key) {
    if (state.frames.has(key)) return;
    const wrapper = document.createElement("div");
    wrapper.className = "project-frame demo-frame";
    const box = document.createElement("div");
    box.className = "demo-placeholder";
    const [title, description] = demoNotes[key];
    const kicker = document.createElement("p");
    kicker.className = "demo-kicker";
    kicker.textContent = "演示模式";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = description;
    const note = document.createElement("p");
    note.className = "demo-note";
    note.textContent = "演示模式不打开真实项目；去掉地址中的 ?demo 即可使用。";
    const back = document.createElement("a");
    back.className = "button";
    back.href = "#overview";
    back.textContent = "返回总览";
    box.append(kicker, heading, body, note, back);
    wrapper.append(box);
    state.frames.set(key, { wrapper, iframe: null, timeout: null, loaded: true, pendingUrl: "" });
    $("project-frames").append(wrapper);
  }

  function loadFrame(key, reload = false) {
    if (demo) { loadDemoFrame(key); return; }
    // Both finance routes own the same iframe, avoiding duplicate monitoring,
    // wallet requests, and independent tab states behind one visible workspace.
    const url = projectUrl(key);
    if (state.frames.has(key) && !reload) {
      if (key === "wallet") setFinanceSection(state.frames.get(key), url);
      return;
    }
    const old = state.frames.get(key);
    if (old) { clearTimeout(old.timeout); old.wrapper.remove(); }
    const wrapper = document.createElement("div");
    wrapper.className = "project-frame";
    wrapper.dataset.project = key;
    const overlay = document.createElement("div");
    overlay.className = "frame-loading";
    overlay.setAttribute("role", "status");
    const spinner = document.createElement("span");
    spinner.className = "frame-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const message = document.createElement("p");
    message.textContent = `正在打开${views[key].title}…`;
    overlay.append(spinner, message);
    const iframe = document.createElement("iframe");
    iframe.title = `${views[key].title}项目工作区`;
    iframe.setAttribute("allow", "clipboard-write");
    iframe.addEventListener("load", () => {
      try {
        const current = iframe.contentWindow.location;
        const requested = new URL(entry.pendingUrl, location.origin);
        // Appending an iframe can emit about:blank's load before its src is
        // ready. Only the actual local project may complete loading or route.
        if (current.origin !== location.origin || current.pathname !== requested.pathname || current.search !== requested.search) return;
      } catch { return; }
      clearTimeout(entry.timeout);
      // A stopped local service, or an unavailable cloud backend, answers with a
      // JSON error. Show its message and a way forward, not the raw response.
      entry.failed = false;
      entry.reason = "";
      try {
        const page = iframe.contentDocument;
        if (page.contentType === "application/json") {
          entry.failed = true;
          const error = JSON.parse(page.body?.textContent || "null")?.error;
          entry.reason = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
        }
      } catch { /* An unreadable error keeps the generic message. */ }
      if (entry.failed) {
        overlay.classList.add("is-slow");
        overlay.querySelector(".frame-loading-actions")?.remove();
        const cloudOnly = local && key === "travel";
        overlay.append(frameActions(key, overlay, { start: startable(key), retry: !cloudOnly, open: !cloudOnly, back: cloudOnly }));
        renderServiceNotice();
        return;
      }
      hideOverlay(overlay);
      entry.loaded = true;
      window.XHYMotion?.enter(iframe, { y: 10, duration: 420 });
      if (key === "wallet") {
        setFinanceSection(entry, entry.pendingUrl);
        try {
          const syncSection = () => {
            const hash = iframe.contentWindow.location.hash;
            if (!["#wallet", "#wallet-panel", "#alerts"].includes(hash)) return;
            state.financeSection = hash === "#alerts" ? "alerts" : "wallet";
            entry.pendingUrl = projectUrl("wallet");
            if (state.view === "wallet") {
              $("open-project").href = entry.pendingUrl;
              history.replaceState(null, "", `${location.pathname}${location.search}#${state.financeSection}`);
            }
          };
          iframe.contentWindow.addEventListener("hashchange", syncSection);
          syncSection();
        } catch { /* The portal only embeds the same-origin finance project. */ }
      }
    });
    const entry = { wrapper, iframe, message, timeout: null, loaded: false, failed: false, reason: "", pendingUrl: url };
    state.frames.set(key, entry);
    wrapper.append(overlay, iframe);
    $("project-frames").append(wrapper);
    entry.timeout = setTimeout(() => {
      overlay.classList.add("is-slow");
      message.textContent = "项目加载时间较长。可以重试，或在独立窗口中打开。";
      overlay.append(frameActions(key, overlay, { reveal: true }));
    }, 15000);
    iframe.src = url;
  }

  const serviceNames = { wallet: "比特币终端", travel: "快速出境" };
  // The BTC service runs on the owner's computer and can be started from here;
  // the cloud runs everything itself.
  const startable = (key) => local && !demo && key !== "travel";
  // 快速出境 keeps its flight source and settings in the cloud database only.
  const frameFailure = (key, entry) => local && key === "travel" ? "快速出境在云端终端中使用：航班数据源和出行设置保存在云端。" : entry.reason || `${serviceNames[key]}暂时无法打开。`;
  function frameActions(key, overlay, { start = false, reveal = false, retry = true, open = true, back = false } = {}) {
    const actions = document.createElement("div");
    actions.className = "frame-loading-actions";
    const button = (label, onClick, className = "button") => {
      const element = document.createElement("button");
      element.className = className;
      element.type = "button";
      element.textContent = label;
      element.addEventListener("click", onClick);
      return element;
    };
    if (start) {
      const launch = button("启动本机服务", startServices, "button button-primary");
      launch.dataset.startServices = "";
      launch.disabled = recovery.running;
      actions.append(launch);
    }
    if (retry) actions.append(button("重试加载", () => { loadFrame(key, true); showOnlyFrame(key); }));
    if (open) {
      const link = document.createElement("a");
      link.className = "button";
      link.href = projectUrl(key);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "独立打开 ↗";
      actions.append(link);
    }
    if (back) actions.append(Object.assign(document.createElement("a"), { className: "button", href: "#overview", textContent: "返回总览" }));
    if (reveal) actions.append(button("继续查看", () => hideOverlay(overlay)));
    return actions;
  }

  function showOnlyFrame(key) {
    for (const [name, entry] of state.frames) entry.wrapper.hidden = name !== key;
  }

  function navigate({ focus = true } = {}) {
    const key = location.hash.slice(1) || "overview";
    const route = Object.hasOwn(views, key) ? key : "overview";
    // Keep legacy #alerts and the overview's market links working within
    // 加密资产, sharing one finance workspace.
    const next = route === "alerts" ? "wallet" : route;
    const changed = state.view !== next;
    if (route !== key) history.replaceState(null, "", `${location.pathname}${location.search}#${next}`);
    if (next === "wallet") state.financeSection = route === "alerts" ? "alerts" : "wallet";
    state.view = next;
    const view = views[next];
    // The overview alone follows the live price; the finance project runs its own stream.
    if (next === "overview") startLive(); else stopLive();
    updateTitle();
    text("page-title", view.title);
    text("page-description", view.description);
    for (const item of document.querySelectorAll("[data-nav]")) {
      if (item.dataset.nav === next) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    $("overview-view").hidden = next !== "overview";
    $("project-view").hidden = next === "overview";
    $("project-actions").hidden = next === "overview";
    $("refresh").hidden = next !== "overview";
    document.documentElement.dataset.view = next;
    moveNavigationIndicator(changed);
    if (next !== "overview") {
      $("open-project").href = projectUrl(next);
      $("open-project").setAttribute("aria-label", `在新窗口独立打开${view.title}`);
      loadFrame(next);
      showOnlyFrame(next);
      updateProjectHint();
    }
    if (focus) {
      $("page-title").focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    if (changed) {
      window.XHYMotion?.cancelAll();
      // Overview cards run their own staggered entrance whenever they are shown.
      if (next !== "overview") window.XHYMotion?.enter($("project-view"), { y: 10, duration: 420 });
    }
  }

  // The connection popover closes like a menu: outside click or Escape.
  const syncMenu = $("sync-menu");
  // On phones the sheet's dimmed backdrop is the menu's own ::before, so a tap
  // on it targets the menu element itself.
  document.addEventListener("click", (event) => { if (syncMenu.open && (!syncMenu.contains(event.target) || event.target === syncMenu)) syncMenu.open = false; });

  // 界面 switch: auto follows the device; a fixed choice is remembered per browser.
  const uiChoice = document.documentElement.dataset.uiPref || "auto";
  function chooseUi(choice) {
    try { if (choice === "auto") localStorage.removeItem("xhy-ui"); else localStorage.setItem("xhy-ui", choice); } catch {}
    if (choice === uiChoice) return;
    const url = new URL(location.href);
    url.searchParams.delete("ui");
    location.replace(url);
  }
  for (const button of document.querySelectorAll("button[data-ui-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.uiChoice === uiChoice));
    button.addEventListener("click", () => chooseUi(button.dataset.uiChoice));
  }

  // Command palette (⌘K / Ctrl+K, / or ?): every page and action by name, with
  // single keys for the common ones. Shortcuts never fire while typing.
  const go = (key) => { location.hash = key; };
  const commands = [
    { title: "总览", hint: "资产与行情", keys: ["1"], terms: "overview home zonglan zl", run: () => go("overview") },
    { title: "加密资产", hint: "持仓、走势与钱包", keys: ["2"], terms: "wallet assets crypto zichan zc qianbao", run: () => go("wallet") },
    { title: "快速出境", hint: "附近机场与直飞时刻", keys: ["3"], terms: "travel flight airport plane chujing kuaisu cj ks feiji", run: () => go("travel") },
    { title: "价格警报", hint: "比特币行情与提醒", terms: "alerts price btc bitcoin jingbao jb hangqing", run: () => go("alerts") },
    { title: "刷新总览", keys: ["R"], terms: "refresh sync shuaxin sx", when: () => state.view === "overview", run: () => refresh(true) },
    { title: "重新加载当前项目", terms: "reload project chongxin jiazai", when: () => state.view !== "overview" && !demo, run: () => $("reload-project").click() },
    { title: "在新窗口打开当前项目", terms: "open window dakai xinchuangkou", when: () => state.view !== "overview" && !demo, run: () => window.open(projectUrl(state.view), "_blank", "noopener") },
    { title: "启动本机服务", hint: () => `${offlineServices().join("、")}未运行`, terms: "start services launch qidong fuwu", when: () => offlineServices().length > 0 && !recovery.running, run: startServices },
    { title: () => document.documentElement.dataset.theme === "dark" ? "切换到白天模式" : "切换到黑夜模式", keys: ["T"], terms: "theme dark light mode zhuti heiye baitian", run: toggleTheme },
    { title: "连接详情", terms: "connection sync status lianjie xiangqing", run: () => { syncMenu.open = true; } },
    { title: "切换到手机界面", terms: "ui mobile phone jiemian shouji", when: () => document.documentElement.dataset.ui !== "mobile", run: () => chooseUi("mobile") },
    { title: "切换到电脑界面", terms: "ui desktop computer jiemian diannao", when: () => document.documentElement.dataset.ui !== "desktop", run: () => chooseUi("desktop") },
    { title: "界面跟随设备", terms: "ui auto device jiemian zidong", when: () => uiChoice !== "auto", run: () => chooseUi("auto") },
  ];
  const resolve = (value) => typeof value === "function" ? value() : value;
  const palette = $("palette"), paletteInput = $("palette-input"), paletteList = $("palette-list");
  let paletteItems = [], paletteIndex = 0;

  function renderPalette() {
    const query = paletteInput.value.trim().toLowerCase().replace(/\s+/g, " ");
    paletteItems = commands.filter((command) => (!command.when || command.when())
      && (!query || `${resolve(command.title)} ${resolve(command.hint) || ""} ${command.terms} ${(command.keys || []).join(" ")}`.toLowerCase().includes(query)));
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
    paletteList.replaceChildren(...paletteItems.map((command, index) => {
      const item = document.createElement("li");
      item.id = `palette-option-${index}`;
      item.setAttribute("role", "option");
      item.dataset.index = index;
      const title = document.createElement("span");
      title.className = "palette-title";
      title.textContent = resolve(command.title);
      item.append(title);
      const hint = resolve(command.hint);
      if (hint) {
        const note = document.createElement("span");
        note.className = "palette-hint";
        note.textContent = hint;
        item.append(note);
      }
      if (command.keys) {
        const keys = document.createElement("span");
        keys.className = "palette-keys";
        keys.append(...command.keys.map((key) => Object.assign(document.createElement("kbd"), { textContent: key })));
        item.append(keys);
      }
      return item;
    }));
    if (!paletteItems.length) {
      const empty = document.createElement("li");
      empty.className = "palette-empty";
      empty.textContent = "没有匹配的页面或操作";
      paletteList.append(empty);
    }
    highlightPalette();
  }

  function highlightPalette() {
    for (const item of paletteList.children) item.setAttribute("aria-selected", String(Number(item.dataset.index) === paletteIndex));
    const active = paletteItems.length ? $(`palette-option-${paletteIndex}`) : null;
    if (active) { paletteInput.setAttribute("aria-activedescendant", active.id); active.scrollIntoView({ block: "nearest" }); }
    else paletteInput.removeAttribute("aria-activedescendant");
  }

  function openPalette() {
    if (palette.open) { paletteInput.select(); return; }
    syncMenu.open = false;
    paletteInput.value = "";
    paletteIndex = 0;
    renderPalette();
    palette.showModal();
    paletteInput.focus();
  }

  function runPalette(index) {
    const command = paletteItems[index];
    if (!command) return;
    palette.close();
    // After the click or key that chose it has finished, so menus it opens stay open.
    setTimeout(command.run, 0);
  }

  paletteInput.addEventListener("input", () => { paletteIndex = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!paletteItems.length) return;
      paletteIndex = (paletteIndex + (event.key === "ArrowDown" ? 1 : -1) + paletteItems.length) % paletteItems.length;
      highlightPalette();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runPalette(paletteIndex);
    }
  });
  paletteList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-index]");
    if (item) runPalette(Number(item.dataset.index));
  });
  paletteList.addEventListener("pointermove", (event) => {
    const item = event.target.closest("[data-index]");
    if (item && Number(item.dataset.index) !== paletteIndex) { paletteIndex = Number(item.dataset.index); highlightPalette(); }
  });
  // The dialog element itself is only hit through its dimmed backdrop.
  palette.addEventListener("click", (event) => { if (event.target === palette) palette.close(); });
  $("palette-open").addEventListener("click", openPalette);

  const commandKey = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
  for (const element of document.querySelectorAll("[data-command-key]")) element.textContent = commandKey;
  $("palette-open").title = `命令面板 · ${commandKey === "⌘" ? "⌘K" : "Ctrl+K"}`;
  const isPaletteKey = (event) => (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
  const typing = (target) => target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
  const shortcuts = { "1": () => go("overview"), "2": () => go("wallet"), "3": () => go("travel"), r: () => { if (state.view === "overview") refresh(true); }, t: toggleTheme, "/": openPalette, "?": openPalette };
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && syncMenu.open) { syncMenu.open = false; $("connection").focus(); return; }
    if (isPaletteKey(event)) { event.preventDefault(); openPalette(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.repeat || palette.open || typing(event.target)) return;
    const action = shortcuts[event.key.length === 1 ? event.key.toLowerCase() : ""];
    if (!action) return;
    event.preventDefault();
    action();
  });

  $("theme-toggle").addEventListener("click", toggleTheme);
  preferredTheme.addEventListener("change", (event) => {
    let saved;
    try { saved = localStorage.getItem("xhy-theme"); } catch {}
    if (saved !== "light" && saved !== "dark") setTheme(event.matches ? "dark" : "light", false);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "xhy-theme") setTheme(event.newValue === "light" || event.newValue === "dark" ? event.newValue : preferredTheme.matches ? "dark" : "light", false);
  });
  setTheme(document.documentElement.dataset.theme, false);
  $("refresh").addEventListener("click", () => refresh(true));
  for (const button of document.querySelectorAll("[data-start-services]")) button.addEventListener("click", startServices);
  $("reload-project").addEventListener("click", () => {
    if (state.view === "overview") return;
    loadFrame(state.view, true);
    showOnlyFrame(state.view);
    text("announcer", `正在重新加载${views[state.view].title}。`);
  });
  window.addEventListener("hashchange", () => navigate());
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.type === "xhy:frame-height" && Number.isFinite(event.data.height)) {
      const entry = [...state.frames.values()].find(item => item.iframe && event.source === item.iframe.contentWindow);
      if (entry && event.data.height >= 1 && event.data.height <= 50000) {
        entry.iframe.style.setProperty("--xhy-frame-height", `${Math.ceil(event.data.height)}px`);
      }
      return;
    }
    // Project pages forward the portal's shortcut keys, so they work wherever focus is.
    if (event.data?.type === "xhy:shortcut") {
      const key = String(event.data.key);
      if (key === "palette") openPalette();
      else if (!palette.open && Object.hasOwn(shortcuts, key)) shortcuts[key]();
    }
  });
  document.addEventListener("visibilitychange", () => {
    tick();
    if (document.hidden) {
      // A background tab keeps its live title for a while, then lets the stream
      // go (browsers allow only six connections per host across all tabs).
      clearTimeout(live.idle);
      live.idle = setTimeout(stopLive, 5 * 60000);
      return;
    }
    refresh();
    startLive();
  });
  tick();
  navigate({ focus: false });
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
})();
