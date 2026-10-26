"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const text = (id, value) => { $(id).textContent = value; };
  const zone = "Asia/Shanghai";
  const number = (value, digits = 0) => Number.isFinite(Number(value)) && value !== null && value !== "" && typeof value !== "boolean"
    ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Number(value)) : "—";
  const finite = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value));
  const money = (value, digits = 2) => finite(value) ? `$${number(value, digits)}` : "—";
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
  const navigation = document.querySelector(".navigation");
  const indicator = document.createElement("span");
  indicator.className = "nav-indicator";
  indicator.setAttribute("aria-hidden", "true");
  navigation.prepend(indicator);
  let indicatorAnimation = null, indicatorReady = false;
  function moveNavigationIndicator(animate = true) {
    const active = navigation.querySelector('[aria-current="page"]');
    if (!active) return;
    const before = getComputedStyle(indicator);
    const from = { transform: before.transform, width: before.width, height: before.height };
    const to = { transform: `translate3d(${active.offsetLeft}px,${active.offsetTop}px,0)`, width: `${active.offsetWidth}px`, height: `${active.offsetHeight}px` };
    indicatorAnimation?.cancel();
    Object.assign(indicator.style, to);
    if (animate && indicatorReady && !reducedMotion.matches) indicatorAnimation = indicator.animate([from, to], { duration: 280, easing: "cubic-bezier(.22,1,.36,1)" });
    navigation.dataset.indicatorReady = "true";
    indicatorReady = true;
  }
  new ResizeObserver(() => moveNavigationIndicator(false)).observe(navigation);
  document.fonts?.ready.then(() => moveNavigationIndicator(false));
  reducedMotion.addEventListener("change", () => { indicatorAnimation?.cancel(); moveNavigationIndicator(false); });
  let shift = "summer";
  try { if (localStorage.getItem("xhy-work-shift") === "winter") shift = "winter"; } catch {}

  function setTheme(theme, persist = true) {
    window.XHYMotion?.cancelAll();
    const next = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    document.querySelector('meta[name="theme-color"]').content = next === "dark" ? "#161617" : "#f5f5f7";
    $("theme-toggle").setAttribute("aria-pressed", String(next === "dark"));
    $("theme-toggle").setAttribute("aria-label", `当前${next === "dark" ? "黑夜" : "白天"}模式，切换至${next === "dark" ? "白天" : "黑夜"}模式`);
    text("theme-icon", next === "dark" ? "☾" : "☼");
    text("theme-label", next === "dark" ? "黑夜模式" : "白天模式");
    if (persist) { try { localStorage.setItem("xhy-theme", next); } catch {} }
    window.dispatchEvent(new CustomEvent("xhy:theme-change", { detail: { theme: next } }));
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
    $("work-dot").dataset.working = String(working);
    for (const button of document.querySelectorAll("[data-shift]")) button.setAttribute("aria-pressed", String(button.dataset.shift === shift));
  }

  function timestamp(value, includeDate = false) {
    if (!value) return "尚未同步";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "尚未同步";
    return new Intl.DateTimeFormat("zh-CN", { timeZone: zone, ...(includeDate ? { month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
  }

  function localDate(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }

  function updateClock() {
    const now = new Date();
    $("clock").dateTime = now.toISOString();
    text("clock", new Intl.DateTimeFormat("zh-CN", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now));
    $("gmt-clock").dateTime = now.toISOString();
    text("gmt-clock", new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now));
    $("gmt-clock").title = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now) + " · 格林尼治时间 UTC+0";
    text("today", new Intl.DateTimeFormat("zh-CN", { timeZone: zone, month: "long", day: "numeric", weekday: "long" }).format(now));
    updateWorkSchedule(now);
  }

  function setModuleStatus(key, value) {
    const status = statusLabels[value] ? value : "offline";
    const element = $(`${key}-status`);
    element.dataset.status = status;
    element.lastElementChild.textContent = statusLabels[status];
  }

  function setSource(key, status, updatedAt) {
    const element = $(`${key}-source-state`);
    element.dataset.status = status;
    element.textContent = status === "online" ? "连接正常" : status === "empty" ? "已连接 · 暂无记录" : statusLabels[status] || "未连接";
    text(`${key}-updated`, updatedAt ? `更新于 ${timestamp(updatedAt, true)}` : "尚未同步");
  }

  function renderDiet(diet = {}) {
    const today = diet.today || {};
    const totals = today.totals || {};
    const recorded = today.recorded === true || diet.recorded === true;
    setModuleStatus("diet", diet.status || "offline");
    text("diet-date", (today.date || diet.date || localDate()).replaceAll("-", "."));
    text("diet-kcal", recorded ? number(totals.kcal) : "—");
    for (const key of ["protein", "carbs", "fat"]) text(`diet-${key}`, recorded ? number(totals[key], 1) : "—");
    let context = recorded ? `${number(today.mealCount)} 餐已记录${finite(today.itemCount) ? ` · ${number(today.itemCount)} 项食物` : ""}` : "今天还没有饮食记录";
    if (diet.status === "offline") context = recorded ? "显示最近保存的饮食记录" : "暂时无法读取饮食记录";
    text("diet-context", context);
    const week = diet.week || {};
    text("diet-week-summary", finite(week.recordedDays) ? `${number(week.recordedDays)} 天已记录` : "暂无记录");
    renderWeek(Array.isArray(week.days) ? week.days : []);
    text("diet-note", diet.status === "offline" ? "饮食服务暂未连接，可重试同步或独立打开日记。" : "在日记中用自然语言记录或修改饮食。");
    text("diet-module-updated", `Diet · ${diet.updatedAt ? `更新于 ${timestamp(diet.updatedAt, true)}` : "尚未同步"}`);
  }

  function renderWeek(days) {
    const today = localDate();
    const map = new Map(days.filter((day) => day && typeof day.date === "string").map((day) => [day.date, day]));
    const end = new Date(`${today}T12:00:00+08:00`);
    const entries = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(end.getTime() - (6 - index) * 86400000);
      const key = localDate(date);
      return { date: key, recorded: false, ...(map.get(key) || {}) };
    });
    const max = Math.max(1, ...entries.filter((day) => day.recorded && finite(day.totals?.kcal)).map((day) => Number(day.totals.kcal)));
    const chart = $("diet-week");
    chart.replaceChildren();
    const descriptions = [];
    for (const day of entries) {
      const hasValue = day.recorded === true && finite(day.totals?.kcal);
      const label = `${day.date.slice(5).replace("-", "/")} ${hasValue ? `${number(day.totals.kcal)} kcal` : "未记录"}`;
      descriptions.push(label);
      const column = document.createElement("div");
      column.className = "week-day";
      column.dataset.today = String(day.date === today);
      column.dataset.recorded = String(hasValue);
      column.title = label;
      column.setAttribute("aria-hidden", "true");
      const track = document.createElement("div");
      track.className = "week-bar-track";
      const bar = document.createElement("div");
      bar.className = "week-bar";
      bar.style.height = hasValue ? `${Math.max(3, Number(day.totals.kcal) / max * 100)}%` : "2px";
      track.append(bar);
      const caption = document.createElement("span");
      caption.className = "week-label";
      caption.textContent = day.date === today ? "今天" : day.date.slice(5).replace("-", "/");
      column.append(track, caption);
      chart.append(column);
    }
    chart.setAttribute("aria-label", `过去七天热量摄入：${descriptions.join("；")}`);
  }

  function renderWallet(wallet = {}) {
    setModuleStatus("wallet", wallet.status || "offline");
    text("wallet-usd", number(wallet.totalUsd, 2));
    text("wallet-cny", finite(wallet.totalCny) ? `约 ¥${number(wallet.totalCny, 2)} CNY` : wallet.status === "offline" ? "暂时无法读取钱包估值" : "连接账户后显示资产总估值");
    const btc = $("wallet-btc");
    btc.replaceChildren(document.createTextNode(number(wallet.btcHoldings, 8) + " "));
    const unit = document.createElement("small");
    unit.textContent = "BTC";
    btc.append(unit);
    text("wallet-btc-label", `BTC 实际持仓${finite(wallet.btcHoldings) && wallet.btcHoldingsStale ? " · 已延迟" : ""}`);
    const list = $("wallet-assets");
    list.replaceChildren();
    const assets = (Array.isArray(wallet.assets) ? wallet.assets : []).filter((asset) => asset && typeof asset.ccy === "string" && finite(asset.usd_value));
    for (const asset of assets.slice(0, 3)) {
      const row = document.createElement("div");
      row.className = "asset-row";
      const name = document.createElement("span");
      name.className = "asset-name";
      const marker = document.createElement("span");
      marker.className = "asset-marker";
      marker.setAttribute("aria-hidden", "true");
      name.append(marker, document.createTextNode(asset.ccy));
      const value = document.createElement("span");
      value.className = "asset-value";
      value.textContent = money(asset.usd_value);
      row.append(name, value);
      row.title = `${asset.ccy} 持仓 ${number(asset.quantity, 8)}，估值 ${money(asset.usd_value)}`;
      list.append(row);
    }
    if (!assets.length) {
      const empty = document.createElement("div");
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

  function renderAlerts(alerts = {}) {
    setModuleStatus("alerts", alerts.status || "offline");
    text("alerts-price", number(alerts.price, 2));
    const rangeMode = ["day_range", "amplitude"].includes(alerts.metric || alerts.settings?.metric);
    const changeValue = rangeMode ? alerts.rangePct : alerts.changePct;
    const change = $("alerts-change");
    change.className = finite(changeValue) ? Number(changeValue) >= 0 ? "positive" : "negative" : "";
    change.textContent = finite(changeValue) ? `${!rangeMode && Number(changeValue) > 0 ? "+" : ""}${number(changeValue, 2)}%` : "—";
    text("alerts-change-label", rangeMode ? "北京时间今日振幅" : "北京时间今日涨跌");
    text("alerts-threshold-label", rangeMode ? "当日振幅警报" : "当日涨跌幅警报");
    text("alerts-low", money(alerts.dayLow));
    text("alerts-high", money(alerts.dayHigh));
    const enabled = alerts.enabled ?? alerts.settings?.enabled;
    text("alerts-enabled", enabled === true ? "已开启" : enabled === false ? "已暂停" : "未读取");
    const thresholds = Array.isArray(alerts.thresholds) ? alerts.thresholds : Array.isArray(alerts.settings?.thresholds_pct) ? alerts.settings.thresholds_pct : [];
    const list = $("alerts-thresholds");
    list.replaceChildren();
    for (const threshold of thresholds.filter(finite)) {
      const chip = document.createElement("span");
      chip.className = "threshold-chip";
      chip.textContent = `${rangeMode ? "" : "± "}${number(threshold, 2)}%`;
      chip.title = rangeMode ? `当日振幅达到 ${number(threshold, 2)}% 时触发警报` : `当日涨跌幅达到正负 ${number(threshold, 2)}% 时触发警报`;
      list.append(chip);
    }
    if (!list.children.length) {
      const empty = document.createElement("span");
      empty.className = "inline-empty";
      empty.textContent = "暂无可读取的警报阈值";
      list.append(empty);
    }
    text("alerts-note", alerts.status === "offline" ? "行情服务暂未连接，可独立打开检查连接。" : alerts.stale || alerts.status === "stale" ? "行情已延迟，当前价格为最近一次收到的数据。" : enabled === false ? "价格警报已暂停，可在警报页重新开启。" : rangeMode ? "当日振幅 =（最高价 − 最低价）÷ 今日开盘价。" : "以北京时间 00:00 为当日涨跌幅基准。");
    text("alerts-module-updated", `Binance Spot · ${alerts.updatedAt ? `更新于 ${timestamp(alerts.updatedAt, true)}` : "尚未同步"}`);
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
    renderAlerts(data.alerts);
    const dietService = data.services?.diet || data.diet || {};
    const btcService = data.services?.btc || {};
    setSource("diet", dietService.status || data.diet?.status || "offline", data.diet?.updatedAt);
    setSource("btc", btcService.status || data.alerts?.status || data.wallet?.status || "offline", latestDate([data.wallet?.updatedAt, data.alerts?.updatedAt]));
    text("last-sync", `总览同步于 ${timestamp(data.updatedAt || state.lastSuccess, true)} · 北京时间`);
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
    }
    $("connection").dataset.status = status;
    text("connection-text", label);
  }

  async function refresh(manual = false) {
    if (state.refreshing) return;
    state.refreshing = true;
    const button = $("refresh");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/api/overview", { headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
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
      state.refreshing = false;
      button.disabled = false;
      button.setAttribute("aria-busy", "false");
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

  function loadFrame(key, reload = false) {
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
      overlay.hidden = true;
      entry.loaded = true;
      window.XHYMotion?.enter(wrapper);
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
    const entry = { wrapper, iframe, timeout: null, loaded: false, pendingUrl: url };
    state.frames.set(key, entry);
    wrapper.append(overlay, iframe);
    $("project-frames").append(wrapper);
    entry.timeout = setTimeout(() => {
      overlay.classList.add("is-slow");
      message.textContent = "项目加载时间较长。可以重试，或在独立窗口中打开。";
      const actions = document.createElement("div");
      actions.className = "frame-loading-actions";
      const retry = document.createElement("button");
      retry.className = "button";
      retry.type = "button";
      retry.textContent = "重试加载";
      retry.addEventListener("click", () => { loadFrame(key, true); showOnlyFrame(key); });
      const open = document.createElement("a");
      open.className = "button";
      open.href = projectUrl(key);
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = "独立打开 ↗";
      const reveal = document.createElement("button");
      reveal.className = "button";
      reveal.type = "button";
      reveal.textContent = "继续查看";
      reveal.addEventListener("click", () => { overlay.hidden = true; });
      actions.append(retry, open, reveal);
      overlay.append(actions);
    }, 15000);
    iframe.src = url;
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
    document.title = `XHY Terminal · ${next === "overview" ? "个人总终端" : view.title}`;
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
      window.XHYMotion?.enter($(next === "overview" ? "overview-view" : "project-view"));
    }
  }

  $("theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
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
    updateClock();
    text("announcer", `已切换${shift === "winter" ? "冬季 00:00 至 08:00" : "夏季 23:00 至 07:00"}工作班次，均为北京时间。`);
  });
  setTheme(document.documentElement.dataset.theme, false);
  $("refresh").addEventListener("click", () => refresh(true));
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
      const entry = [...state.frames.values()].find(item => event.source === item.iframe.contentWindow);
      if (entry && event.data.height >= 1 && event.data.height <= 50000) {
        entry.iframe.style.setProperty("--xhy-frame-height", `${Math.ceil(event.data.height)}px`);
      }
      return;
    }
    const dietFrame = state.frames.get("diet")?.iframe;
    if (dietFrame && event.source === dietFrame.contentWindow && event.data?.type === "xhy:diary-updated") refresh();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { updateClock(); refresh(); } });
  updateClock();
  setInterval(updateClock, 1000);
  renderWeek([]);
  navigate({ focus: false });
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
})();
