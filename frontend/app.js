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
    overview: { title: "总览", description: "饮食、资产与比特币行情。" },
    diet: { title: "饮食日记", description: "按日期查看和记录饮食。", url: "/diet/" },
    wallet: { title: "加密资产", description: "持仓、走势与价格警报。", url: "/btc/#wallet" },
    alerts: { title: "价格警报", description: "比特币行情与价格提醒。", url: "/btc/#alerts" },
  };
  const state = { data: null, view: "overview", financeSection: "wallet", refreshing: false, failed: false, frames: new Map(), lastSuccess: null };
  const statusLabels = { online: "已同步", stale: "数据延迟", offline: "未连接", empty: "暂无记录", loading: "读取中" };
  const preferredTheme = matchMedia("(prefers-color-scheme: dark)");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const easeOut = "cubic-bezier(.22,1,.36,1)";
  // Away from the owner's computer (the public Cloudflare copy) there is no
  // local API, so the portal shows labelled sample data instead.
  const demo = !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  document.documentElement.dataset.demo = String(demo);

  // Segmented controls (main navigation and work shift) share one sliding pill.
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
  const moveShiftIndicator = segmentIndicator(document.querySelector(".shift-toggle"), '[aria-pressed="true"]');

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

  let shift = "summer";
  try { if (localStorage.getItem("xhy-work-shift") === "winter") shift = "winter"; } catch {}

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

  function updateWorkSchedule(now) {
    // Both shifts use Beijing time; GMT stays fixed at UTC+0 throughout the year.
    const beijing = new Date(now.getTime() + 8 * 3600000);
    const seconds = beijing.getUTCHours() * 3600 + beijing.getUTCMinutes() * 60 + beijing.getUTCSeconds();
    const start = shift === "winter" ? 0 : 23 * 3600;
    const end = shift === "winter" ? 8 * 3600 : 7 * 3600;
    const working = start === 0 ? seconds < end : seconds >= start || seconds < end;
    const remaining = working ? (end - seconds + 86400) % 86400 : (start - seconds + 86400) % 86400;
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor(remaining % 3600 / 60);
    text("work-status", working ? "工作中" : "休息时间");
    text("work-countdown", `${working ? "距下班" : "距开工"} ${hours} 小时 ${String(minutes).padStart(2, "0")} 分`);
    setData($("work-dot"), "working", working);
  }

  function renderShift() {
    for (const button of document.querySelectorAll("[data-shift]")) button.setAttribute("aria-pressed", String(button.dataset.shift === shift));
  }

  function timestamp(value, includeDate = false) {
    if (!value) return "尚未同步";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "尚未同步";
    return dateFormat(includeDate ? "stamp-date" : "stamp", "zh-CN", { timeZone: zone, ...(includeDate ? { month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
  }

  // Diary days run on UTC+0 (they change at 08:00 Beijing time); clocks and market days stay on Beijing time.
  function diaryDate(date = new Date()) {
    return dateFormat("diary", "en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }

  // The clock text is itself a valid time string, so <time> needs no
  // per-second datetime attribute; dates and titles change once a day.
  function updateClock() {
    const now = new Date();
    text("clock", dateFormat("clock", "zh-CN", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now));
    text("gmt-clock", dateFormat("gmt", "en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now));
    const gmtTitle = `${dateFormat("gmt-date", "zh-CN", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)} · 格林尼治时间 UTC+0`;
    if ($("gmt-clock").title !== gmtTitle) $("gmt-clock").title = gmtTitle;
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
    if (demo) { setData(element, "status", "demo"); text(element.id, "示例数据"); text(`${key}-updated`, "公开站点不连接本机服务"); return; }
    setData(element, "status", status);
    text(element.id, status === "online" ? "连接正常" : status === "empty" ? "已连接 · 暂无记录" : statusLabels[status] || "未连接");
    text(`${key}-updated`, updatedAt ? `更新于 ${timestamp(updatedAt, true)}` : "尚未同步");
  }

  function renderDiet(diet = {}) {
    const today = diet.today || {};
    const totals = today.totals || {};
    const recorded = today.recorded === true || diet.recorded === true;
    setModuleStatus("diet", diet.status || "offline");
    text("diet-date", `${(today.date || diet.date || diaryDate()).replaceAll("-", ".")} UTC`);
    animateNumber("diet-kcal", recorded ? totals.kcal : null);
    for (const key of ["protein", "carbs", "fat", "fiber"]) animateNumber(`diet-${key}`, recorded ? totals[key] : null, 1);
    renderMacroSplit(recorded ? totals : {});
    let context = recorded ? `${number(today.mealCount)} 餐已记录${finite(today.itemCount) ? ` · ${number(today.itemCount)} 项食物` : ""}` : "今天还没有饮食记录";
    if (diet.status === "offline") context = recorded ? "显示最近保存的饮食记录" : "暂时无法读取饮食记录";
    text("diet-context", context);
    const week = diet.week || {};
    const weekDays = Array.isArray(week.days) ? week.days : [];
    const recordedKcal = weekDays.filter((day) => day?.recorded && finite(day.totals?.kcal)).map((day) => Number(day.totals.kcal));
    const average = recordedKcal.length ? recordedKcal.reduce((sum, value) => sum + value, 0) / recordedKcal.length : null;
    text("diet-week-summary", finite(week.recordedDays) ? `${number(week.recordedDays)}/7 天${finite(average) ? ` · 日均 ${number(average)} kcal` : ""}` : "暂无记录");
    renderWeek(weekDays);
    renderMeals(recorded && Array.isArray(today.meals) ? today.meals : [], diet.status);
    text("diet-note", diet.status === "offline" ? "饮食服务暂未连接，可刷新或独立打开日记。" : "");
    $("diet-note").hidden = diet.status !== "offline";
    text("diet-module-updated", `Diet · ${diet.updatedAt ? `更新于 ${timestamp(diet.updatedAt, true)}` : "尚未同步"}`);
  }

  const mealNames = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐" };
  function renderMeals(meals, status) {
    const list = $("diet-meals");
    // Rows are rebuilt only when the meals change, so the minute refresh does
    // not replay their entrance.
    const signature = JSON.stringify([status, meals.map((meal) => [meal?.type, meal?.title, meal?.kcal])]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    list.replaceChildren();
    meals.forEach((meal, index) => {
      const row = document.createElement("li");
      row.style.setProperty("--d", index);
      const type = document.createElement("span");
      type.className = "meal-type";
      type.textContent = mealNames[meal?.type] || "餐食";
      const title = document.createElement("span");
      title.className = "meal-title";
      title.textContent = typeof meal?.title === "string" ? meal.title : "";
      title.title = title.textContent;
      const kcal = document.createElement("span");
      kcal.className = "meal-kcal";
      kcal.textContent = finite(meal?.kcal) ? `${number(meal.kcal)} kcal` : "—";
      row.append(type, title, kcal);
      list.append(row);
    });
    if (!meals.length) {
      const empty = document.createElement("li");
      empty.className = "inline-empty";
      empty.textContent = status === "offline" ? "饮食服务未连接" : "今天还没有记录餐食";
      list.append(empty);
    }
    text("diet-meal-total", meals.length ? `${number(meals.length)} 餐` : "");
  }

  function renderMacroSplit(totals) {
    // Energy share: protein and carbohydrate 4 kcal/g, fat 9 kcal/g.
    const energy = { protein: Number(totals.protein) * 4, carbs: Number(totals.carbs) * 4, fat: Number(totals.fat) * 9 };
    const valid = Object.values(energy).every((value) => Number.isFinite(value) && value >= 0);
    const sum = valid ? energy.protein + energy.carbs + energy.fat : 0;
    const split = $("diet-split");
    split.dataset.empty = String(!sum);
    for (const segment of split.children) {
      segment.style.width = sum ? `calc((100% - 6px) * ${energy[segment.dataset.macro] / sum})` : "";
    }
  }

  function renderWeek(days) {
    const today = diaryDate();
    const map = new Map(days.filter((day) => day && typeof day.date === "string").map((day) => [day.date, day]));
    const end = new Date(`${today}T12:00:00Z`);
    const entries = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(end.getTime() - (6 - index) * 86400000);
      const key = diaryDate(date);
      return { date: key, recorded: false, ...(map.get(key) || {}) };
    });
    const max = Math.max(1, ...entries.filter((day) => day.recorded && finite(day.totals?.kcal)).map((day) => Number(day.totals.kcal)));
    const chart = $("diet-week");
    // Columns are created once and then updated in place so bars ease to new heights.
    if (chart.children.length !== 7) {
      chart.replaceChildren(...entries.map((_, index) => {
        const column = document.createElement("div");
        column.className = "week-day";
        column.setAttribute("aria-hidden", "true");
        column.style.setProperty("--d", index);
        const value = document.createElement("span");
        value.className = "week-value";
        const track = document.createElement("div");
        track.className = "week-bar-track";
        const bar = document.createElement("div");
        bar.className = "week-bar";
        track.append(bar, value);
        const caption = document.createElement("span");
        caption.className = "week-label";
        column.append(track, caption);
        return column;
      }));
    }
    const descriptions = [];
    entries.forEach((day, index) => {
      const column = chart.children[index];
      const hasValue = day.recorded === true && finite(day.totals?.kcal);
      const label = `${day.date.slice(5).replace("-", "/")} ${hasValue ? `${number(day.totals.kcal)} kcal` : "未记录"}`;
      descriptions.push(label);
      setData(column, "today", day.date === today);
      setData(column, "recorded", hasValue);
      if (column.title !== label) column.title = label;
      const value = column.querySelector(".week-value"), caption = column.querySelector(".week-label");
      const valueText = hasValue ? number(day.totals.kcal) : "", captionText = day.date === today ? "今天" : day.date.slice(5).replace("-", "/");
      if (value.textContent !== valueText) value.textContent = valueText;
      if (caption.textContent !== captionText) caption.textContent = captionText;
      const scale = hasValue ? Math.max(.03, Number(day.totals.kcal) / max) : 0;
      const bar = column.querySelector(".week-bar");
      requestAnimationFrame(() => { setStyle(bar, "transform", `scaleY(${scale})`); setStyle(column, "--h", String(scale)); });
    });
    const description = `过去七天热量摄入：${descriptions.join("；")}`;
    if (chart.getAttribute("aria-label") !== description) chart.setAttribute("aria-label", description);
  }

  function renderWallet(wallet = {}) {
    setModuleStatus("wallet", wallet.status || "offline");
    animateNumber("wallet-usd", wallet.totalUsd, 2, { cents: true });
    text("wallet-cny", finite(wallet.totalCny) ? `约 ¥${fixed(wallet.totalCny, 2)} CNY` : wallet.status === "offline" ? "暂时无法读取钱包估值" : "连接账户后显示资产总估值");
    animateNumber("wallet-btc", wallet.btcHoldings, 8);
    text("wallet-btc-label", `BTC 实际持仓${finite(wallet.btcHoldings) && wallet.btcHoldingsStale ? " · 已延迟" : ""}`);
    const list = $("wallet-assets");
    const assets = (Array.isArray(wallet.assets) ? wallet.assets : []).filter((asset) => asset && typeof asset.ccy === "string" && finite(asset.usd_value));
    const visible = assets.slice(0, 6);
    renderPnl(wallet.pnl);
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
        name.append(document.createTextNode(asset.ccy), share);
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
      const title = `${asset.ccy} 持仓 ${number(asset.quantity, 8)}，估值 ${valueText}`;
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
    const walletNote = wallet.status === "offline" ? "钱包服务暂未连接，可重试同步或独立打开。" : `${wallet.complete === false ? "当前资产估值不完整。" : ""}${scopeNote || (wallet.complete === false ? "部分账户或资产暂未计入。" : "")}`;
    text("wallet-note", walletNote);
    $("wallet-note").hidden = !walletNote;
    text("wallet-module-updated", `加密钱包 · ${wallet.updatedAt ? `更新于 ${timestamp(wallet.updatedAt, true)}` : "尚未同步"}`);
  }

  function renderPnl(pnl) {
    const metrics = pnl && typeof pnl === "object" ? pnl : {};
    text("wallet-avg-cost", fixed(metrics.averageCost));
    const sign = (value) => finite(value) ? Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "" : "";
    for (const [id, value, suffix] of [["wallet-unrealized", metrics.unrealized, ""], ["wallet-return", metrics.returnPct, "%"]]) {
      const element = $(id);
      if (element.className !== sign(value)) element.className = sign(value);
      text(id, finite(value) ? `${signed(value)}${suffix}` : "—");
    }
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

  function renderRecentAlerts(recent, status) {
    const list = $("alerts-recent");
    const rows = recent.filter((alert) => alert && typeof alert === "object").slice(-4).reverse();
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
    for (const key of ["diet", "wallet", "alerts"]) {
      if (typeof links[key] !== "string") continue;
      // Keep all embedded project routes on this origin; credentials never enter the client.
      try {
        const url = new URL(links[key], location.origin);
        if (url.origin === location.origin && /^\/(diet|btc)(\/|$)/.test(url.pathname)) views[key].url = url.pathname + url.search + url.hash;
      } catch { /* Keep the working default route. */ }
    }
    $("diet-source-link").href = views.diet.url;
    $("btc-source-link").href = views.alerts.url;
    if (state.view !== "overview") $("open-project").href = projectUrl(state.view);
  }

  function renderOverview(data) {
    applyLinks(data.links);
    renderDiet(data.diet);
    renderWallet(data.wallet);
    renderAlerts(withLive(data.alerts));
    renderServiceNotice();
    const dietService = data.services?.diet || data.diet || {};
    const btcService = data.services?.btc || {};
    setSource("diet", dietService.status || data.diet?.status || "offline", data.diet?.updatedAt);
    setSource("btc", btcService.status || data.alerts?.status || data.wallet?.status || "offline", latestDate([data.wallet?.updatedAt, data.alerts?.updatedAt]));
    text("last-sync", demo ? "公开演示站点：数据为示例，不是真实账户。真实数据只在本机终端显示。" : `总览同步于 ${timestamp(data.updatedAt || state.lastSuccess, true)} · 北京时间 · 每分钟自动刷新`);
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
      const statuses = [state.data.diet?.status, state.data.wallet?.status, state.data.alerts?.status];
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
  const liveFresh = () => Boolean(live.alerts) && Date.now() - live.at < 8000;
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
      recent: Array.isArray(snapshot.alerts) ? snapshot.alerts.slice(-8) : [],
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
    if (demo || !state.data?.services) return [];
    return [["diet", "饮食日记"], ["btc", "比特币终端"]].filter(([key]) => state.data.services[key]?.status === "offline").map(([, label]) => label);
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
      if (entry.failed) entry.message.textContent = message || (recovery.running ? `正在启动${serviceNames[key]}…` : `${serviceNames[key]}服务未运行。`);
    }
    for (const button of document.querySelectorAll("[data-start-services]")) {
      button.disabled = recovery.running;
      button.setAttribute("aria-busy", String(recovery.running));
    }
  }

  async function startServices() {
    if (recovery.running || demo) return;
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
      if (!entry.failed) continue;
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
      if (!data || typeof data !== "object" || !["diet", "wallet", "alerts"].some((key) => data[key] && typeof data[key] === "object")) throw new Error("Invalid overview response");
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
        renderDiet({ status: "offline" });
        renderWallet({ status: "offline" });
        renderAlerts({ status: "offline" });
        setSource("diet", "offline", null);
        setSource("btc", "offline", null);
      } else {
        for (const key of ["diet", "wallet", "alerts"]) setModuleStatus(key, "stale");
        setSource("diet", "stale", state.data.diet?.updatedAt);
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
    if (!state.data) return state.failed ? "offline" : "loading";
    if (state.failed) return "stale";
    return key === "diet" ? state.data.services?.diet?.status || state.data.diet?.status : state.data.services?.btc?.status || state.data[key === "wallet" ? "wallet" : "alerts"]?.status;
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
    diet: ["饮食日记", "按日历查看每天吃了什么，营养自动估算，也可以用 AI 对话记录或修改。"],
    wallet: ["加密资产", "欧易、币安与离线钱包的合计持仓、定投成本与浮盈，以及比特币价格警报。"],
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
    kicker.textContent = "本机功能";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = description;
    const note = document.createElement("p");
    note.className = "demo-note";
    note.textContent = "这部分直接读取私人数据和账户，只在主人的电脑上运行，公开站点不提供。";
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
      // A stopped service comes back from the portal as a JSON error. Offer to
      // start it rather than showing the raw response.
      try { entry.failed = iframe.contentDocument.contentType === "application/json"; } catch { entry.failed = false; }
      if (entry.failed) {
        overlay.classList.add("is-slow");
        overlay.querySelector(".frame-loading-actions")?.remove();
        overlay.append(frameActions(key, overlay, { start: true }));
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
    const entry = { wrapper, iframe, message, timeout: null, loaded: false, failed: false, pendingUrl: url };
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

  const serviceNames = { diet: "饮食日记", wallet: "比特币终端" };
  function frameActions(key, overlay, { start = false, reveal = false } = {}) {
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
    actions.append(button("重试加载", () => { loadFrame(key, true); showOnlyFrame(key); }));
    const open = document.createElement("a");
    open.className = "button";
    open.href = projectUrl(key);
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "独立打开 ↗";
    actions.append(open);
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
    // 加密资产, while the global navigation stays a three-item index.
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
    { title: "总览", hint: "饮食、资产与行情", keys: ["1"], terms: "overview home zonglan zl", run: () => go("overview") },
    { title: "饮食日记", hint: "按日期查看和记录", keys: ["2"], terms: "diet food meal yinshi ys riji", run: () => go("diet") },
    { title: "加密资产", hint: "持仓、走势与钱包", keys: ["3"], terms: "wallet assets crypto zichan zc qianbao", run: () => go("wallet") },
    { title: "价格警报", hint: "比特币行情与提醒", terms: "alerts price btc bitcoin jingbao jb hangqing", run: () => go("alerts") },
    { title: "刷新总览", keys: ["R"], terms: "refresh sync shuaxin sx", when: () => state.view === "overview", run: () => refresh(true) },
    { title: "重新加载当前项目", terms: "reload project chongxin jiazai", when: () => state.view !== "overview" && !demo, run: () => $("reload-project").click() },
    { title: "在新窗口打开当前项目", terms: "open window dakai xinchuangkou", when: () => state.view !== "overview" && !demo, run: () => window.open(projectUrl(state.view), "_blank", "noopener") },
    { title: "启动本机服务", hint: () => `${offlineServices().join("、")}未运行`, terms: "start services launch qidong fuwu", when: () => offlineServices().length > 0 && !recovery.running, run: startServices },
    { title: () => document.documentElement.dataset.theme === "dark" ? "切换到白天模式" : "切换到黑夜模式", keys: ["T"], terms: "theme dark light mode zhuti heiye baitian", run: toggleTheme },
    { title: () => `切换到${shift === "winter" ? "夏季 23–07" : "冬季 00–08"} 班次`, hint: "北京时间", terms: "shift work schedule banci", run: () => document.querySelector(`[data-shift="${shift === "winter" ? "summer" : "winter"}"]`).click() },
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
  const shortcuts = { "1": () => go("overview"), "2": () => go("diet"), "3": () => go("wallet"), r: () => { if (state.view === "overview") refresh(true); }, t: toggleTheme, "/": openPalette, "?": openPalette };
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
  for (const button of document.querySelectorAll("[data-shift]")) button.addEventListener("click", () => {
    shift = button.dataset.shift === "winter" ? "winter" : "summer";
    try { localStorage.setItem("xhy-work-shift", shift); } catch {}
    renderShift();
    updateClock();
    moveShiftIndicator();
    text("announcer", `已切换${shift === "winter" ? "冬季 00:00 至 08:00" : "夏季 23:00 至 07:00"}工作班次，均为北京时间。`);
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
      return;
    }
    const dietFrame = state.frames.get("diet")?.iframe;
    if (dietFrame && event.source === dietFrame.contentWindow && event.data?.type === "xhy:diary-updated") refresh();
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
  renderShift();
  tick();
  moveShiftIndicator(false);
  renderWeek([]);
  navigate({ focus: false });
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
})();
