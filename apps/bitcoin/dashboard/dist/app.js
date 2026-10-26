"use strict";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
const number = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const numberFormatters = new Map();
const format = (value, decimals = 2) => {if (number(value) === null) return "—"; if (!numberFormatters.has(decimals)) numberFormatters.set(decimals, new Intl.NumberFormat("en-US", {minimumFractionDigits: 0, maximumFractionDigits: decimals})); return numberFormatters.get(decimals).format(number(value));};
const ivFormatter = new Intl.NumberFormat("en-US", {style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2});
const ivFormat = (value) => number(value) === null || number(value) < 0 ? "—" : ivFormatter.format(number(value));
const compact = (value) => number(value) === null ? "—" : number(value) >= 1e6 ? `${format(number(value) / 1e6, 2)}M` : number(value) >= 1e4 ? `${format(number(value) / 1e3, 2)}K` : format(value, 2);
const timeMs = (value) => typeof value === "number" ? (Number.isFinite(value) && value > 0 ? value : null) : value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const timeFormatters = [false, true].map((date) => new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", ...(date ? {year: "numeric", month: "2-digit", day: "2-digit"} : {}), hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false}));
const beijingTime = (value, date = false) => timeMs(value) === null ? "—" : timeFormatters[Number(date)].format(new Date(timeMs(value)));
const loadStorage = (key, fallback) => {try {return JSON.parse(localStorage.getItem(key)) ?? fallback;} catch {return fallback;}};
const saveStorage = (key, value) => {try {localStorage.setItem(key, JSON.stringify(value));} catch {}};
const storedFavorites = loadStorage("btc-options-favorites", []);
const state = {snapshot: null, expiry: null, side: "ALL", search: "", atm: false, favoritesOnly: false, greeks: false, selected: null, favorites: new Set(Array.isArray(storedFavorites) ? storedFavorites.filter((item) => typeof item === "string") : []), fetching: false, initial: true, apiError: null, lastFetch: 0, streamConnected: false, streamLastAt: 0, stream: null, chainKey: "", expiryKey: "", lastOverview: 0, pendingSnapshot: null, scheduledRender: false};
const basicLeft = ["volume", "delta", "ask", "mark", "bid"];
const basicRight = ["bid", "mark", "ask", "delta", "volume"];
const labels = {volume: "成交量", delta: "Delta", gamma: "Gamma", theta: "Theta", vega: "Vega", ask: "卖价 / IV", mark: "标记价 / IV", bid: "买价 / IV"};
const combo = {active: false, expiry: null, legs: new Map(), error: null, trayKey: ""};
const optionMs = (row) => number(row.expiry_ms) ?? Date.parse(row.expiry_beijing);
const marketNow = () => Date.now() + (number(state.snapshot?.exchange_clock_offset_ms) ?? 0);
const optionDateFormatter = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"});
const optionDates = new Map();
const optionDate = (row) => {
  const expiry = optionMs(row);
  if (!Number.isFinite(expiry) || Math.abs(expiry) > 8640000000000000) return "";
  if (!optionDates.has(expiry)) {
    if (optionDates.size >= 128) optionDates.clear();
    optionDates.set(expiry, optionDateFormatter.format(new Date(expiry)));
  }
  return optionDates.get(expiry);
};
const valueDecimals = (value) => {const [mantissa, exponent = "0"] = String(value ?? "").toLowerCase().split("e"); return Math.max(0, Math.min(12, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent)));};
// priceScale describes order ticks; mark prices may carry finer official precision.
const priceFormat = (_row, value) => format(value, valueDecimals(value));
const rawFormat = (value) => format(value, valueDecimals(value));
const fieldTime = (row, group, key = null) => (key ? row?.field_updated_at?.[key] : null) ?? row?.[`${group}_updated_at`] ?? state.snapshot?.fetched_at;
const fieldSource = (row, group, key = null) => (key ? row?.field_source?.[key] : null) ?? row?.[`${group}_source`] ?? "rest";
const fieldDescription = (row, group, key = null) => {const live = fieldSource(row, group, key) === "websocket"; const eventTime = (key ? row?.field_event_ms?.[key] : null) ?? row?.[`${group}_event_ms`]; return live ? `WebSocket · 源时间 ${beijingTime(eventTime, true)} · 本机接收 ${beijingTime(fieldTime(row, group, key))}` : `REST 本机接收 ${beijingTime(fieldTime(row, group, key), true)}`;};
const groupForColumn = (column) => column === "volume" ? "ticker" : ["bid", "ask"].includes(column) ? "quote" : "mark";
const fieldForColumn = (column) => column === "volume" ? "volume_24h_contracts" : ["bid", "ask", "mark"].includes(column) ? `${column}_price` : column;
const quoteAction = (row, column) => {const action = column === "ask" ? `按卖一价模拟买入 ${row.side === "CALL" ? "Call" : "Put"}` : column === "bid" ? `按买一价模拟卖出 ${row.side === "CALL" ? "Call" : "Put"}` : "查看合约详情"; return action + (["ask", "bid"].includes(column) ? combo.active ? "，点击选中或取消组合腿" : "，查看到期盈亏" : "");};
const comboKey = (symbol, direction) => `${symbol}:${direction}`;
const comboOptions = () => {const date = combo.active ? combo.expiry : state.expiry; return allOptions().filter((row) => !date || date === "ALL" || optionDate(row) === date);};
const daysLeft = (row) => (optionMs(row) - marketNow()) / 86400000;
const otmPct = (row) => {const index = number(state.snapshot?.btc_index_price); return index ? (row.side === "PUT" ? (1 - number(row.strike_price) / index) : (number(row.strike_price) / index - 1)) * 100 : null;};
const allOptions = () => (state.snapshot?.options ?? []).filter((row) => Number.isFinite(optionMs(row)) && optionMs(row) > marketNow());
const expiryDates = () => [...new Set(allOptions().map(optionDate))].sort();
const atmStrike = (rows) => {const index = number(state.snapshot?.btc_index_price); const strikes = [...new Set(rows.map((row) => number(row.strike_price)).filter((strike) => strike !== null))]; return strikes.length && index ? strikes.reduce((a, b) => Math.abs(a - index) <= Math.abs(b - index) ? a : b) : null;};
const countDuration = (rows) => {if (!rows.length) return "—"; const total = Math.max(0, optionMs(rows[0]) - marketNow()); const days = Math.floor(total / 86400000); const hours = Math.floor(total % 86400000 / 3600000); const minutes = Math.floor(total % 3600000 / 60000); return days ? `${days}天 ${hours}小时` : `${hours}小时 ${minutes}分`;};

function filteredOptions() {
  const index = number(state.snapshot?.btc_index_price);
  return allOptions().filter((row) => {
    if (state.expiry !== "ALL" && optionDate(row) !== state.expiry) return false;
    if (state.side !== "ALL" && row.side !== state.side) return false;
    if (state.atm && (!index || Math.abs(number(row.strike_price) / index - 1) > 0.1)) return false;
    if (state.favoritesOnly && !state.favorites.has(row.symbol)) return false;
    return !state.search || row.symbol.toLowerCase().includes(state.search.toLowerCase()) || format(row.strike_price, 0).replace(/,/g, "").includes(state.search.replace(/,/g, ""));
  });
}

function setButtonState(id, active) {$(id).classList.toggle("active", active); $(id).setAttribute("aria-pressed", String(active));}
function renderFilters() {
  document.querySelectorAll("#sideButtons button").forEach((button) => {button.classList.toggle("active", button.dataset.side === state.side); button.setAttribute("aria-pressed", String(button.dataset.side === state.side));});
  setButtonState("atmButton", state.atm);
  setButtonState("favoritesButton", state.favoritesOnly); setButtonState("greeksButton", state.greeks);
  $("favoriteCount").textContent = state.favorites.size;
  const filters = [state.side === "ALL" ? "双侧期权链" : state.side === "PUT" ? "看跌 Put" : "看涨 Call"];
  if (state.atm) filters.push("行权价距指数 ±10%"); if (state.favoritesOnly) filters.push("自选"); if (state.search) filters.push(`搜索 ${state.search}`);
  $("filterDescription").textContent = filters.join(" · ");
}

function renderMarket() {
  const rows = allOptions();
  const sum = (key) => {const values = rows.map((row) => number(row[key])).filter((value) => value !== null && value >= 0); return values.length ? compact(values.reduce((total, value) => total + value, 0)) : "—";};
  $("indexPrice").textContent = rawFormat(state.snapshot?.btc_index_price);
  $("marketVolume").textContent = sum("volume_24h_contracts");
  $("marketAmount").textContent = sum("amount_24h_quote");
  $("marketContracts").textContent = rows.length ? `${format(rows.length, 0)} / ${expiryDates().length}` : "— / —";
  renderConnection();
}

function isLiveSnapshot(snapshot) {
  const localLive = state.streamConnected && Date.now() - state.streamLastAt < 25000;
  const health = snapshot?.data_health;
  if (["quote", "mark", "index"].every((group) => typeof health?.[group]?.status === "string")) return localLive && ["quote", "mark", "index"].every((group) => health[group].status === "live");
  const realtime = snapshot?.realtime ?? {};
  const lastMessage = timeMs(realtime.last_message_at) ?? timeMs(realtime.last_event_at) ?? 0;
  return localLive && (realtime.connected === true || realtime.status === "connected") && lastMessage > 0 && Date.now() - lastMessage < 20000;
}

function statisticsHealth(snapshot = state.snapshot, now = Date.now()) {
  const clock = now + (number(snapshot?.exchange_clock_offset_ms) ?? 0);
  const rows = (snapshot?.options ?? []).filter((row) => Number.isFinite(optionMs(row)) && optionMs(row) > clock);
  const fields = rows.flatMap((row) => ["volume_24h_contracts", "amount_24h_quote"].map((key) => ({value: number(row[key]), source: row.field_source?.[key] ?? row.ticker_source ?? "rest", updatedAt: timeMs(row.field_updated_at?.[key] ?? row.ticker_updated_at ?? snapshot.fetched_at)})));
  const present = fields.filter((field) => field.value !== null && field.value >= 0);
  const times = present.map((field) => field.updatedAt).filter((updatedAt) => updatedAt !== null);
  const sources = new Set(present.map((field) => field.source));
  const source = sources.size > 1 ? "mixed" : sources.size ? [...sources][0] : "unavailable";
  const oldestAt = times.length ? Math.min(...times) : null;
  const ageSeconds = oldestAt === null ? null : Math.max(0, (now - oldestAt) / 1000);
  const upstream = snapshot?.data_health?.ticker;
  const restFailed = typeof upstream?.rest_refresh_failed === "boolean" ? upstream.rest_refresh_failed : Boolean(snapshot?.error);
  const missing = present.length < fields.length || times.length < present.length || number(upstream?.missing_fields) > 0;
  const partial = missing || upstream?.status === "partial";
  const hasRest = present.some((field) => field.source !== "websocket");
  // Old services have no connection-generation health. Do not call quiet, old
  // ticker values live merely because another WebSocket channel is connected.
  const verifiedLive = upstream?.status === "live";
  const stale = !verifiedLive && (upstream?.status === "stale" || upstream?.status === "unavailable" || upstream?.status === "partial" && !missing || ageSeconds === null || (hasRest ? ageSeconds > 30 : ageSeconds > 20));
  const status = !present.length ? "unavailable" : partial ? "partial" : stale ? "stale" : verifiedLive ? "live" : "fresh";
  return {status, source, oldestAt, ageSeconds, availableFields: present.length, totalFields: fields.length, missing, restFailed, degraded: status !== "live", stale};
}

function statisticsDescription(health) {
  if (health.status === "unavailable") return "24h 统计：暂无数据";
  const status = health.status === "partial" ? health.missing ? "部分缺失" : "部分旧缓存" : health.stale ? "旧缓存" : health.status === "live" ? "实时" : "已更新";
  const updated = health.oldestAt === null ? "更新时间未知" : `最早更新 ${beijingTime(health.oldestAt, true)}`;
  return `24h 统计：${status} · ${updated}${health.restFailed ? " · 刷新失败" : ""}`;
}

// The quote badge describes executable bid/ask data, not mark/Greeks or index.
// Keep isLiveSnapshot's stricter all-core test for calculation previews above.
function quotationHealth(snapshot = state.snapshot) {
  const localLive = state.streamConnected && Date.now() - state.streamLastAt < 25000;
  const upstream = snapshot?.data_health?.quote;
  const known = ["live", "fresh", "partial", "stale", "unavailable"].includes(upstream?.status);
  const total = number(upstream?.total_fields), fresh = number(upstream?.fresh_fields);
  const coverage = total > 0 && fresh !== null ? `${fresh}/${total} 字段新鲜` : "";
  if (state.currentSnapshotUnavailable) return {status: "stale", text: "报价缓存 · 最新快照不可用", localLive, coverage, upstream};
  if (!localLive) return {status: "stale", text: "报价缓存 · 本地推送中断", localLive, coverage, upstream};
  const status = known ? upstream.status : isLiveSnapshot(snapshot) ? "live" : "stale";
  const label = {live: "报价实时", fresh: "报价近期快照", partial: "报价部分更新", stale: "报价旧缓存", unavailable: "报价暂无数据"}[status];
  return {status, text: label + (status === "partial" && coverage ? `（${coverage}）` : ""), localLive, coverage, upstream};
}

function groupHealthDescription(name, group, localLive) {
  const status = group?.status;
  const label = {live: localLive && !state.currentSnapshotUnavailable ? "实时" : "最近快照", fresh: "近期快照", partial: "部分更新", stale: "旧缓存", unavailable: "暂无数据"}[status] ?? "状态未知";
  return `${name}：${label}${group?.rest_refresh_failed ? " · REST 刷新失败" : ""}`;
}

function renderConnection() {
  const snapshot = state.snapshot;
  const realtime = snapshot?.realtime ?? {};
  const lastMessage = timeMs(realtime.last_message_at) ?? timeMs(realtime.last_event_at) ?? 0;
  const quote = quotationHealth(snapshot);
  const live = quote.status === "live";
  const stale = !live;
  const statistics = statisticsHealth(snapshot);
  const mark = snapshot?.data_health?.mark, index = snapshot?.data_health?.index;
  const catalog = snapshot?.data_health?.catalog;
  const catalogStale = catalog?.status === "stale" || catalog?.status === "unavailable";
  const unavailable = !snapshot || !snapshot.options?.length;
  const refreshing = snapshot?.refreshing || state.fetching;
  const text = unavailable ? "等待行情" : quote.text;
  $("connectionBadge").className = `connection-badge ${unavailable ? "loading" : stale ? "stale" : ""}`;
  const badgeSpan = $("connectionBadge").querySelector("span");
  if (badgeSpan) badgeSpan.textContent = text;
  else $("connectionBadge").innerHTML = `<i></i><span>${text}</span>`;
  const groupIssues = [];
  const warnings = [];
  if (!unavailable) {
    if (!quote.localLive) warnings.push("本地实时推送中断，显示最近接收数据；正在恢复本地连接。");
    else if (state.currentSnapshotUnavailable) warnings.push("最新行情快照不可用，保留最近接收的报价。");
    else if (quote.status === "partial") warnings.push(`买卖报价部分更新${quote.coverage ? `：${quote.coverage}` : ""}；其余字段保留原数据，不能视为全部实时。`);
    else if (quote.status === "stale") warnings.push("买卖报价已是旧缓存，等待盘口数据恢复。");
    else if (quote.status === "fresh") warnings.push("买卖报价为最近快照，尚未验证全部实时推送。");
    else if (quote.status === "unavailable") warnings.push("买卖报价暂无有效数据。");
    for (const [name, shortName, group] of [["标记价 / Greeks", "标记 / Greeks", mark], ["指数", "指数", index]]) {
      if (["partial", "stale", "unavailable"].includes(group?.status)) {
        const issue = groupHealthDescription(name, group, quote.localLive);
        warnings.push(issue + "。");
        groupIssues.push(`${shortName}${group.status === "stale" ? "旧缓存" : group.status === "partial" ? "部分更新" : "缺失"}`);
      }
    }
    // A disconnected mark stream must not imply the independently connected
    // book or index stream is also down. Report only observed channel failures.
    const disconnected = Object.entries(realtime.connection_details ?? {}).filter(([, channel]) => channel?.connected === false);
    const channelNames = [...new Set(disconnected.map(([name]) => name.startsWith("book-") ? "盘口" : name === "market" ? "标记价" : name === "index" ? "指数" : name.startsWith("ticker") ? "24h 统计" : "其他行情"))];
    if (channelNames.length) warnings.push(`${channelNames.join(" / ")}通道中断，自动重连中。`);
  }
  const statisticsIssue = statistics.status === "unavailable" || statistics.missing ? "统计缺失" : statistics.stale ? catalogStale ? "统计 / 目录缓存" : "统计旧缓存" : statistics.restFailed ? "统计刷新失败" : catalogStale ? "目录旧缓存" : "";
  const focusText = unavailable ? "等待行情" : [!live ? quote.status === "partial" ? quote.text : quote.status === "fresh" ? "报价近期快照" : "报价缓存" : "", ...groupIssues, statisticsIssue].filter(Boolean).join(" · ");
  $("focusStatus").textContent = focusText;
  $("focusStatus").className = focusText ? "stale" : "live";
  const catalogText = catalog?.status === "fresh" ? "已核验" : catalog?.status === "stale" ? "旧缓存" : catalog?.status === "unavailable" ? "未核验" : "状态未知";
  $("lastUpdate").textContent = snapshot?.fetched_at ? `服务推送 ${beijingTime(lastMessage)} · 快照 ${beijingTime(snapshot.fetched_at, true)}\n${groupHealthDescription("标记价 / Greeks", mark, quote.localLive)} · ${groupHealthDescription("指数", index, quote.localLive)}\n到期目录：${catalogText}${catalog?.rest_refresh_failed ? " · 刷新失败" : ""}` : "等待行情";
  $("lastUpdate").style.whiteSpace = "pre-line";
  $("statisticsStatus").textContent = statisticsDescription(statistics);
  $("statisticsStatus").className = `statistics-status ${statistics.stale || statistics.status === "partial" || statistics.status === "unavailable" || statistics.restFailed ? "degraded" : ""}`;
  if ($("feedDescription")) $("feedDescription").textContent = "币安 · 北京时间";
  $("footerDot").style.background = stale ? "var(--accent)" : "var(--green)";
  const message = state.apiError || snapshot?.error?.message || realtime.last_error;
  if (unavailable && message) warnings.push(`暂时无法取得行情：${message}`);
  if (!unavailable && snapshot?.error) {
    const labels = {exchange_info: "到期目录", mark: "标记价 / Greeks", index: "指数", ticker: "24h 统计 / REST 备用报价", time: "交易所时间"};
    const failed = Object.keys(snapshot.error.failed_endpoints ?? {});
    warnings.push(`${failed.length ? failed.map((name) => labels[name] ?? "其他公开数据").join("、") + "刷新失败" : "部分数据刷新失败"}${live ? "；报价实时。" : "。"}`);
  }
  if (!unavailable && state.apiError) warnings.push(`本地行情读取失败：${state.apiError}`);
  if (!unavailable && catalogStale) warnings.push(`到期目录缓存 · 核验 ${beijingTime(catalog.last_verified_at ?? snapshot.catalog_updated_at ?? snapshot.fetched_at, true)}`);
  $("noticeBar").hidden = !warnings.length;
  $("noticeBar").textContent = warnings.join(" ");
  $("refreshButton").classList.toggle("busy", !!refreshing);
  $("refreshButton").disabled = state.fetching;
  renderCombo();
}

function renderExpiries() {
  const dates = expiryDates();
  const expiryKey = JSON.stringify([dates.map((date) => [date, Math.max(1, Math.ceil(daysLeft(allOptions().find((row) => optionDate(row) === date))))]), state.expiry]);
  if (expiryKey === state.expiryKey) return;
  state.expiryKey = expiryKey;
  $("expiryTabs").innerHTML = `<button data-expiry="ALL" class="${state.expiry === "ALL" ? "active" : ""}" aria-pressed="${state.expiry === "ALL"}">全部到期日</button>` + dates.map((date) => {
    const row = allOptions().find((option) => optionDate(option) === date);
    const days = Math.max(1, Math.ceil(daysLeft(row)));
    return `<button data-expiry="${date}" class="${state.expiry === date ? "active" : ""}" aria-pressed="${state.expiry === date}">${date}<small>${days}D</small></button>`;
  }).join("");
}

function columnList(side) {
  if (!state.greeks) return side === "CALL" ? basicLeft : basicRight;
  return side === "CALL" ? ["volume", "vega", "theta", "gamma", "delta", "ask", "mark", "bid"] : ["bid", "mark", "ask", "delta", "gamma", "theta", "vega", "volume"];
}

function quoteCell(row, column, side) {
  if (!row) return '<td class="missing-cell">—</td>';
  const index = number(state.snapshot?.btc_index_price);
  const itm = index && (side === "CALL" ? number(row.strike_price) < index : number(row.strike_price) > index);
  const classes = [itm ? "itm" : "", state.selected === row.symbol ? "selected-cell" : "", column === "volume" ? "volume-cell" : "delta-cell"];
  let value;
  if (["ask", "bid", "mark"].includes(column)) {
    classes.pop();
    const price = row[`${column}_price`];
    const iv = column === "mark" ? row.mark_iv : row[`${column}_iv`];
    value = `<span class="quote-price ${column === "mark" ? "" : `${column}-price`}">${priceFormat(row, price)}</span><span class="quote-iv">${ivFormat(iv)}</span>`;
  } else value = column === "volume" ? format(row.volume_24h_contracts, 2) : rawFormat(row[column]);
  if (combo.active && ["bid", "ask"].includes(column) && combo.legs.has(comboKey(row.symbol, column === "ask" ? "BUY" : "SELL"))) classes.push("combo-selected");
  const favorite = state.favorites.has(row.symbol) && column === "mark" ? '<span class="favorite-indicator">★</span>' : "";
  const ivKey = ["bid", "ask", "mark"].includes(column) ? `${column}_iv` : null;
  return `<td class="${classes.join(" ")}" data-symbol="${escapeHtml(row.symbol)}" data-column="${column}" data-value="${escapeHtml(row[fieldForColumn(column)] ?? "")}" data-updated-at="${escapeHtml(fieldTime(row, groupForColumn(column), fieldForColumn(column)) ?? "")}" data-source="${escapeHtml(fieldSource(row, groupForColumn(column), fieldForColumn(column)))}" data-iv="${escapeHtml(ivKey ? row[ivKey] ?? "" : "")}" data-iv-updated-at="${escapeHtml(ivKey ? fieldTime(row, "mark", ivKey) ?? "" : "")}" tabindex="0" role="button" aria-label="${escapeHtml(row.symbol)} ${labels[column]} ${escapeHtml(value.replace(/<[^>]+>/g, " "))} ${quoteAction(row, column)}">${favorite}${value}</td>`;
}

function renderChain(scrollToAtm = false) {
  const focusedCell = document.activeElement?.closest("td[data-symbol]");
  const focusedSymbol = focusedCell?.dataset.symbol, focusedColumn = focusedCell?.dataset.column;
  const rows = filteredOptions(), left = columnList("CALL"), right = columnList("PUT");
  const span = left.length + right.length + 1;
  const scroll = $("chainScroll"), oldScroll = scroll.scrollTop;
  $("optionChain").style.minWidth = state.greeks ? "1450px" : "1000px";
  $("chainHead").innerHTML = `<tr class="wing-head"><th colspan="${left.length}" class="call-title">Call</th><th>行权价（USDT）</th><th colspan="${right.length}" class="put-title">Put</th></tr><tr class="column-head">${left.map((column) => `<th scope="col">${labels[column]}</th>`).join("")}<th scope="col" class="center-head">行权价</th>${right.map((column) => `<th scope="col">${labels[column]}</th>`).join("")}</tr>`;
  const groups = new Map();
  for (const row of rows) {const date = optionDate(row); if (!groups.has(date)) groups.set(date, []); groups.get(date).push(row);}
  let html = "", strikeCount = 0;
  for (const [date, groupRows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const grouped = new Map();
    for (const row of groupRows) {const strike = number(row.strike_price); if (!grouped.has(strike)) grouped.set(strike, {}); grouped.get(strike)[row.side] = row;}
    const nearStrike = atmStrike(groupRows), nearOptions = groupRows.filter((row) => number(row.strike_price) === nearStrike && number(row.mark_iv) !== null);
    const atmIv = nearOptions.length ? nearOptions.reduce((sum, row) => sum + number(row.mark_iv), 0) / nearOptions.length : null;
    const fullExpiryRows = allOptions().filter((row) => optionDate(row) === date);
    const trueAtm = atmStrike(fullExpiryRows);
    html += `<tr class="group-heading" data-expiry-group="${date}"><td colspan="${span}"><strong>${date} 到期</strong><span class="group-meta"><span>指数 <b data-group-value="index">${rawFormat(state.snapshot?.btc_index_price)}</b></span><span>${state.search || state.favoritesOnly ? "所示近端 IV" : "ATM IV"}<b data-group-value="iv">${ivFormat(atmIv)}</b></span><span>剩余 <b data-group-value="duration">${countDuration(groupRows)}</b></span></span><span class="group-count">${groupRows.length} 个合约</span></td></tr>`;
    for (const [strike, pair] of [...grouped].sort(([a], [b]) => a - b)) {
      const isAtm = strike === trueAtm;
      strikeCount++;
      html += `<tr class="quote-row ${isAtm ? "atm-row" : ""}" data-expiry-row="${date}" data-strike="${strike}">${left.map((column) => quoteCell(pair.CALL, column, "CALL")).join("")}<td class="strike-cell ${isAtm ? "atm-strike" : ""}">${format(strike, 8)}${isAtm ? '<small>≈ 指数价格</small>' : ""}</td>${right.map((column) => quoteCell(pair.PUT, column, "PUT")).join("")}</tr>`;
    }
  }
  $("chainBody").innerHTML = html;
  syncComboCells();
  state.chainKey = chainStructureKey(rows);
  const hasData = !!state.snapshot?.options?.length;
  $("tableLoading").hidden = hasData;
  if (state.snapshot && !hasData) $("tableLoading").innerHTML = '<div class="loader"></div><strong>暂无行情，重连中</strong>';
  $("optionChain").hidden = !rows.length;
  $("emptyState").hidden = !hasData || !!rows.length;
  $("footerCount").textContent = `${format(rows.length, 0)} 个合约 · ${format(strikeCount, 0)} 个行权价`;
  if (scrollToAtm && state.expiry !== "ALL") {
    requestAnimationFrame(() => {const near = $("chainBody").querySelector(".atm-row"); if (near) scroll.scrollTop = Math.max(0, near.offsetTop - scroll.clientHeight / 2 + 50);});
  } else scroll.scrollTop = oldScroll;
  if (focusedSymbol) [...$("chainBody").querySelectorAll("td[data-symbol]")].find((cell) => cell.dataset.symbol === focusedSymbol && cell.dataset.column === focusedColumn)?.focus({preventScroll: true});
}

function chainStructureKey(rows = filteredOptions()) {
  return JSON.stringify([state.greeks, rows.map((row) => [row.symbol, row.side, optionMs(row), row.strike_price])]);
}

function updateChain() {
  const rows = filteredOptions();
  if (chainStructureKey(rows) !== state.chainKey) {renderChain(); return;}
  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
  const index = number(state.snapshot?.btc_index_price);
  $("chainBody").querySelectorAll("td[data-symbol]").forEach((cell) => {
    const row = bySymbol.get(cell.dataset.symbol);
    if (!row) return;
    const column = cell.dataset.column;
    cell.classList.toggle("itm", !!index && (row.side === "CALL" ? number(row.strike_price) < index : number(row.strike_price) > index));
    cell.classList.toggle("selected-cell", state.selected === row.symbol);
    const valueRaw = String(row[fieldForColumn(column)] ?? ""), updatedAt = String(fieldTime(row, groupForColumn(column), fieldForColumn(column)) ?? ""), source = fieldSource(row, groupForColumn(column), fieldForColumn(column));
    const ivKey = ["bid", "ask", "mark"].includes(column) ? `${column}_iv` : null;
    const ivRaw = String(ivKey ? row[ivKey] ?? "" : ""), ivAt = String(ivKey ? fieldTime(row, "mark", ivKey) ?? "" : "");
    if (cell.dataset.value === valueRaw && cell.dataset.updatedAt === updatedAt && cell.dataset.source === source && cell.dataset.iv === ivRaw && cell.dataset.ivUpdatedAt === ivAt) return;
    const oldValue = number(cell.dataset.value), nextValue = number(row[fieldForColumn(column)]);
    if (["bid", "ask", "mark"].includes(column) && oldValue !== null && nextValue !== null && oldValue !== nextValue) {
      cell.classList.remove("quote-up", "quote-down");
      cell.classList.add(nextValue > oldValue ? "quote-up" : "quote-down");
      clearTimeout(cell.quoteFlashTimer); cell.quoteFlashTimer = setTimeout(() => cell.classList.remove("quote-up", "quote-down"), 650);
    }
    cell.dataset.value = valueRaw; cell.dataset.updatedAt = updatedAt; cell.dataset.source = source;
    cell.dataset.iv = ivRaw; cell.dataset.ivUpdatedAt = ivAt;
    // Keep the cell itself: keyboard focus and scroll position survive every tick.
    if (["bid", "ask", "mark"].includes(column)) {
      const price = priceFormat(row, row[`${column}_price`]), iv = ivFormat(row[`${column}_iv`]);
      const priceElement = cell.querySelector(".quote-price"), ivElement = cell.querySelector(".quote-iv");
      if (priceElement.textContent !== price) priceElement.textContent = price;
      if (ivElement.textContent !== iv) ivElement.textContent = iv;
    } else {const value = column === "volume" ? format(row.volume_24h_contracts, 2) : rawFormat(row[column]); if (cell.textContent !== value) cell.textContent = value;}
    const ariaLabel = `${row.symbol} ${labels[column]} ${cell.textContent} ${quoteAction(row, column)}`; if (cell.getAttribute("aria-label") !== ariaLabel) cell.setAttribute("aria-label", ariaLabel);
  });
  $("chainBody").querySelectorAll("[data-expiry-group]").forEach((heading) => {
    const groupRows = rows.filter((row) => optionDate(row) === heading.dataset.expiryGroup);
    const near = atmStrike(groupRows), nearOptions = groupRows.filter((row) => number(row.strike_price) === near && number(row.mark_iv) !== null);
    const atmIv = nearOptions.length ? nearOptions.reduce((sum, row) => sum + number(row.mark_iv), 0) / nearOptions.length : null;
    heading.querySelector('[data-group-value="index"]').textContent = rawFormat(state.snapshot?.btc_index_price);
    heading.querySelector('[data-group-value="iv"]').textContent = ivFormat(atmIv);
    heading.querySelector('[data-group-value="duration"]').textContent = countDuration(groupRows);
  });
  const nearByDate = new Map(expiryDates().map((date) => [date, atmStrike(allOptions().filter((row) => optionDate(row) === date))]));
  $("chainBody").querySelectorAll("[data-expiry-row]").forEach((element) => {
    const near = number(element.dataset.strike) === nearByDate.get(element.dataset.expiryRow);
    element.classList.toggle("atm-row", near);
    const strike = element.querySelector(".strike-cell");
    strike.classList.toggle("atm-strike", near);
    if (near && !strike.querySelector("small")) strike.insertAdjacentHTML("beforeend", '<small>≈ 指数价格</small>');
    else if (!near) strike.querySelector("small")?.remove();
  });
}

function renderOverview() {
  const dates = expiryDates();
  const date = state.expiry === "ALL" ? dates[0] : state.expiry;
  const rows = allOptions().filter((row) => optionDate(row) === date);
  $("overviewExpiry").textContent = date ? `${date} 到期${state.expiry === "ALL" ? " · 最近到期日" : ""}` : "—";
  const sumSide = (side) => rows.filter((row) => row.side === side).reduce((sum, row) => sum + (number(row.volume_24h_contracts) ?? 0), 0);
  const call = sumSide("CALL"), put = sumSide("PUT");
  $("callVolume").textContent = format(call); $("putVolume").textContent = format(put);
  $("callVolumeBar").style.width = `${call + put ? call / (call + put) * 100 : 50}%`;
  $("putCallRatio").textContent = `Put / Call ${call > 0 ? format(put / call, 3) : "—"}`;
  const index = number(state.snapshot?.btc_index_price);
  const points = rows.filter((row) => index && Math.abs(number(row.strike_price) / index - 1) <= .35 && number(row.mark_iv) > 0);
  if (points.length < 2) {$("ivChart").textContent = "当前到期日暂无足够的 IV 数据"; return;}
  const strikes = points.map((row) => number(row.strike_price)), ivs = points.map((row) => number(row.mark_iv) * 100);
  const minX = Math.min(...strikes), maxX = Math.max(...strikes), rawMinY = Math.min(...ivs), rawMaxY = Math.max(...ivs);
  const minY = Math.max(0, rawMinY - 5), maxY = rawMaxY + 5;
  const width = 650, height = 123, margin = {left: 33, right: 12, top: 8, bottom: 24};
  const x = (strike) => margin.left + (strike - minX) / Math.max(1, maxX - minX) * (width - margin.left - margin.right);
  const y = (iv) => height - margin.bottom - (iv - minY) / Math.max(1, maxY - minY) * (height - margin.top - margin.bottom);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(date)}到期的 Call 和 Put 隐含波动率曲线">`;
  for (let i = 0; i < 3; i++) {const value = minY + (maxY - minY) * i / 2; svg += `<line class="chart-grid" x1="${margin.left}" y1="${y(value)}" x2="${width - margin.right}" y2="${y(value)}"/><text class="chart-axis" x="0" y="${y(value) + 3}">${format(value, 0)}%</text>`;}
  for (let i = 0; i < 5; i++) {const value = minX + (maxX - minX) * i / 4; svg += `<text class="chart-axis" x="${x(value)}" y="${height - 5}" text-anchor="middle">${format(value / 1000, 1)}k</text>`;}
  if (index >= minX && index <= maxX) svg += `<line x1="${x(index)}" x2="${x(index)}" y1="8" y2="${height - margin.bottom}" stroke="var(--accent)" stroke-dasharray="2 4" stroke-width=".7" opacity=".55"/>`;
  for (const side of ["CALL", "PUT"]) {const set = points.filter((row) => row.side === side).sort((a, b) => number(a.strike_price) - number(b.strike_price)); const color = side === "CALL" ? "var(--green)" : "var(--red)"; svg += `<polyline class="${side === "CALL" ? "chart-call" : "chart-put"}" points="${set.map((row) => `${x(number(row.strike_price))},${y(number(row.mark_iv) * 100)}`).join(" ")}"/>`; for (const row of set) svg += `<circle class="chart-point" cx="${x(number(row.strike_price))}" cy="${y(number(row.mark_iv) * 100)}" r="2" fill="${color}"><title>${escapeHtml(row.symbol)} · IV ${ivFormat(row.mark_iv)}</title></circle>`;}
  $("ivChart").innerHTML = svg + "</svg>";
}

function detailValues(row) {
  const otm = otmPct(row), asset = row.quote_asset ?? "USDT";
  return {expiry: `${beijingTime(optionMs(row), true)} 到期 · 北京时间`, mark_price: priceFormat(row, row.mark_price), bid_price: priceFormat(row, row.bid_price), ask_price: priceFormat(row, row.ask_price), bid_iv: `IV ${ivFormat(row.bid_iv)}`, ask_iv: `IV ${ivFormat(row.ask_iv)}`, strike: `${rawFormat(row.strike_price)} ${asset}`, index: `${rawFormat(state.snapshot?.btc_index_price)} USDT`, duration: countDuration([row]), otm_label: otm !== null && otm < 0 ? "实值幅度" : "虚值幅度", otm: otm === null ? "—" : `${format(Math.abs(otm), 2)}%`, last_price: `${priceFormat(row, row.last_price)} ${asset}`, volume: `${rawFormat(row.volume_24h_contracts)} 张`, contract: `${rawFormat(row.min_qty)} / ${rawFormat(row.unit)}`, mark_iv: ivFormat(row.mark_iv), delta: rawFormat(row.delta), gamma: rawFormat(row.gamma), theta: rawFormat(row.theta), vega: rawFormat(row.vega), last_trade: beijingTime(row.last_trade_beijing), quote_time: fieldDescription(row, "quote"), mark_time: fieldDescription(row, "mark"), ticker_time: fieldDescription(row, "ticker"), index_time: `${state.snapshot?.index_source === "websocket" ? "WebSocket 源时间" : "REST 本机接收"} · ${beijingTime(state.snapshot?.index_event_ms ?? state.snapshot?.index_updated_at ?? state.snapshot?.fetched_at, true)} 北京时间`};
}

function renderDrawer() {
  if (!state.selected) return;
  const row = allOptions().find((option) => option.symbol === state.selected);
  if (!row) {closeDrawer(); return;}
  const values = detailValues(row), content = $("detailContent");
  if (content.dataset.symbol !== row.symbol) {
    const isCall = row.side === "CALL";
    const value = (key, tag = "strong") => `<${tag} data-detail="${key}">${escapeHtml(values[key])}</${tag}>`;
    const keyValue = (label, key) => `<div><dt>${label}</dt>${value(key, "dd")}</div>`;
    content.innerHTML = `<span class="contract-type ${isCall ? "call" : ""}">${isCall ? "Call" : "Put"}</span><h3 class="detail-symbol">${escapeHtml(row.symbol)}</h3><div class="detail-expiry" data-detail="expiry">${escapeHtml(values.expiry)}</div><div class="detail-mark"><label>标记价格</label>${value("mark_price")}<span>${escapeHtml(row.quote_asset ?? "USDT")}</span></div><div class="detail-quotes"><div class="bid"><label>最优买价</label>${value("bid_price")}${value("bid_iv", "small")}</div><div class="ask"><label>最优卖价</label>${value("ask_price")}${value("ask_iv", "small")}</div></div><div class="detail-section"><h3>合约信息</h3><dl>${keyValue("行权价", "strike")}${keyValue("BTC 指数", "index")}${keyValue("剩余期限", "duration")}<div><dt data-detail="otm_label">${values.otm_label}</dt>${value("otm", "dd")}</div>${keyValue("最近成交价", "last_price")}${keyValue("24h 成交量", "volume")}${keyValue("最小数量 / 合约乘数", "contract")}</dl></div><div class="detail-section"><h3>IV / Greeks</h3><div class="detail-greeks"><div><label>标记 IV</label>${value("mark_iv")}</div><div><label>Delta</label>${value("delta")}</div><div><label>Gamma</label>${value("gamma")}</div><div><label>Theta</label>${value("theta")}</div><div><label>Vega</label>${value("vega")}</div><div><label>最近成交时间</label><strong data-detail="last_trade" style="font-size:11px">${values.last_trade}</strong></div></div></div><button class="detail-favorite" id="detailFavorite"></button><details class="detail-note"><summary>更新时间</summary>报价：<span data-detail="quote_time"></span><br>IV / Greeks：<span data-detail="mark_time"></span><br>24h 行情：<span data-detail="ticker_time"></span><br>指数：<span data-detail="index_time"></span></details>`;
    content.dataset.symbol = row.symbol;
    $("detailFavorite").addEventListener("click", () => {if (state.favorites.has(row.symbol)) state.favorites.delete(row.symbol); else state.favorites.add(row.symbol); saveStorage("btc-options-favorites", [...state.favorites]); renderFilters(); renderChain(); renderDrawer();});
  }
  content.querySelectorAll("[data-detail]").forEach((element) => {const next = String(values[element.dataset.detail] ?? "—"); if (element.textContent !== next) element.textContent = next;});
  const detailFields = {mark_iv: "mark", bid_iv: "mark", ask_iv: "mark", delta: "mark", gamma: "mark", theta: "mark", vega: "mark"};
  for (const [key, group] of Object.entries(detailFields)) {const element = content.querySelector(`[data-detail="${key}"]`); if (element) element.title = `API 原值 ${row[key] ?? "—"} · ${fieldDescription(row, group, key)}`;}
  $("detailFavorite").textContent = state.favorites.has(row.symbol) ? "★ 已加入自选 · 点击移除" : "☆ 加入自选";
}

let drawerTrigger = null;
const drawerBackground = new Map();
function setDrawerModal(opened) {
  $("detailDrawer").setAttribute("role", "dialog");
  $("detailDrawer").setAttribute("aria-modal", String(opened));
  if (opened) {
    for (const element of document.body.children) {
      if (element === $("detailDrawer") || element === $("drawerBackdrop") || element.tagName === "DIALOG") continue;
      if (!drawerBackground.has(element)) drawerBackground.set(element, element.inert);
      element.inert = true;
    }
  } else {
    for (const [element, inert] of drawerBackground) element.inert = inert;
    drawerBackground.clear();
  }
}
function openDrawer(symbol, trigger = document.activeElement) {
  drawerTrigger = trigger?.dataset?.symbol ? {symbol: trigger.dataset.symbol, column: trigger.dataset.column} : trigger;
  state.selected = symbol; $("detailDrawer").hidden = false; $("drawerBackdrop").hidden = false;
  renderDrawer();
  if ($("detailDrawer").hidden) return;
  renderChain(); setDrawerModal(true); $("closeDrawer").focus({preventScroll: true});
}
function closeDrawer() {
  const wasOpen = !$("detailDrawer").hidden, trigger = drawerTrigger;
  drawerTrigger = null;
  state.selected = null; $("detailDrawer").hidden = true; $("drawerBackdrop").hidden = true;
  setDrawerModal(false); renderChain();
  if (!wasOpen) return;
  const cell = trigger?.symbol ? [...$("chainBody").querySelectorAll("td[data-symbol]")].find((item) => item.dataset.symbol === trigger.symbol && item.dataset.column === trigger.column) : null;
  const fallback = document.body.classList.contains("quote-focus") ? $("exitFocus") : $("focusButton");
  (cell ?? (trigger?.isConnected ? trigger : fallback))?.focus({preventScroll: true});
}
function comboLegFromQuote(row, column) {
  if (!["bid", "ask"].includes(column) || !Number.isFinite(optionMs(row)) || optionMs(row) <= marketNow()) throw new RangeError("请选择尚未到期的买价或卖价报价。");
  const expiry = combo.expiry ?? (state.expiry !== "ALL" ? state.expiry : null);
  const first = combo.legs.values().next().value;
  if ((expiry && optionDate(row) !== expiry) || (first && optionMs(first.row) !== optionMs(row))) throw new RangeError("组合各腿须属于当前选择的同一到期日和到期时间。");
  if (!row.symbol.startsWith("BTC-") || number(row.unit) !== 1 || !["CALL", "PUT"].includes(row.side)) throw new RangeError("暂仅支持合约乘数为 1 BTC 的期权。");
  const direction = column === "ask" ? "BUY" : "SELL", field = `${column}_price`;
  if (!(number(row[field]) > 0)) throw new RangeError(`该方向当前没有有效${column === "ask" ? "卖一" : "买一"}报价，请选择其他报价。`);
  const quoteSource = fieldSource(row, "quote", field);
  const eventTime = row.field_event_ms && Object.hasOwn(row.field_event_ms, field) ? row.field_event_ms[field] : row.quote_event_ms;
  return {row: JSON.parse(JSON.stringify(row)), direction, premium: row[field], quantity: number(row.min_qty) > 0 ? String(row.min_qty) : "0.01", quoteTime: quoteSource === "websocket" ? eventTime ?? fieldTime(row, "quote", field) : fieldTime(row, "quote", field), quoteSource, quoteDescription: fieldDescription(row, "quote", field)};
}

function syncComboCells() {
  const rows = new Map((state.snapshot?.options ?? []).map((row) => [row.symbol, row]));
  $("chainBody").querySelectorAll('td[data-symbol][data-column="bid"],td[data-symbol][data-column="ask"]').forEach((cell) => {
    const selected = combo.active && combo.legs.has(comboKey(cell.dataset.symbol, cell.dataset.column === "ask" ? "BUY" : "SELL"));
    cell.classList.toggle("combo-selected", selected);
    if (combo.active) cell.setAttribute("aria-pressed", String(selected)); else cell.removeAttribute("aria-pressed");
    const row = rows.get(cell.dataset.symbol);
    if (row) cell.setAttribute("aria-label", `${row.symbol} ${labels[cell.dataset.column]} ${cell.textContent} ${quoteAction(row, cell.dataset.column)}`);
  });
}

function renderCombo() {
  const available = comboOptions().length > 0, legs = [...combo.legs.values()];
  for (const id of ["comboButton", "focusComboButton"]) {
    $(id).disabled = !available && !combo.active;
    $(id).setAttribute("aria-pressed", String(combo.active));
    $(id).classList.toggle("active", combo.active);
    $(id).textContent = combo.active ? "结束多选" : available || !state.snapshot ? "组合多选" : "暂无合约";
  }
  $("comboTray").hidden = !combo.active;
  document.body.classList.toggle("combo-mode", combo.active);
  if (!combo.active) return;
  const firstMs = legs[0] ? optionMs(legs[0].row) : null;
  const alive = legs.every((leg) => optionDate(leg.row) === combo.expiry && optionMs(leg.row) === firstMs && optionMs(leg.row) > marketNow() && allOptions().some((row) => row.symbol === leg.row.symbol));
  const validQuantities = legs.every((leg) => number(leg.quantity) > 0);
  $("comboSummary").textContent = `${combo.expiry} 到期 · 已选 ${legs.length} 腿`;
  $("comboFeedback").textContent = combo.error || (!available || !alive ? "合约已到期或移除" : !validQuantities ? "数量须大于 0" : legs.length < 2 ? "卖价选买入，买价选卖出" : "");
  $("comboFeedback").className = combo.error || !alive || !validQuantities || !available ? "error" : "";
  $("simulateCombo").disabled = legs.length < 2 || !alive || !validQuantities || !available;
  $("clearCombo").disabled = !legs.length;
  const key = JSON.stringify(legs.map((leg) => [leg.row.symbol, leg.direction, leg.premium]));
  if (combo.trayKey !== key) {
    combo.trayKey = key;
    $("comboLegs").innerHTML = legs.length ? legs.map((leg) => {const key = comboKey(leg.row.symbol, leg.direction); return `<div class="combo-leg" data-combo-leg="${escapeHtml(key)}"><b>${leg.direction === "BUY" ? "买入" : "卖出"} ${leg.row.side === "CALL" ? "Call" : "Put"} ${rawFormat(leg.row.strike_price)}</b><span class="combo-leg-price">@ ${rawFormat(leg.premium)}</span><label>数量<input type="number" min="0" step="any" value="${escapeHtml(leg.quantity)}" data-combo-quantity="${escapeHtml(key)}" aria-label="${leg.direction === "BUY" ? "买入" : "卖出"} ${escapeHtml(leg.row.symbol)} 模拟数量"></label><button data-remove-leg="${escapeHtml(key)}" aria-label="移除${leg.direction === "BUY" ? "买入" : "卖出"} ${escapeHtml(leg.row.symbol)}">×</button></div>`;}).join("") : '<span class="combo-empty">选择至少 2 个报价</span>';
  }
  document.body.style.setProperty("--combo-tray-height", `${Math.ceil($("comboTray").getBoundingClientRect().height)}px`);
}

function changeComboExpiry(date) {
  if (combo.expiry !== date) {combo.legs.clear(); combo.error = null;}
  combo.expiry = date;
}

function setComboMode(enabled) {
  if (enabled) {
    const dates = expiryDates();
    const date = state.expiry !== "ALL" && dates.includes(state.expiry) ? state.expiry : dates[0];
    if (!date) return;
    changeComboExpiry(date);
    if ([...combo.legs.values()].some((leg) => optionMs(leg.row) <= marketNow() || !allOptions().some((row) => row.symbol === leg.row.symbol))) combo.legs.clear();
    combo.active = true; combo.error = null;
    state.expiry = date; state.side = "ALL";
    state.atm = false; state.favoritesOnly = false; state.search = ""; $("searchInput").value = "";
    if (!$("detailDrawer").hidden) closeDrawer();
  } else {combo.active = false; combo.error = null;}
  renderCombo(); render(true);
}

function toggleComboQuote(row, column) {
  const key = comboKey(row.symbol, column === "ask" ? "BUY" : "SELL");
  try {
    if (combo.legs.has(key)) combo.legs.delete(key); else combo.legs.set(key, comboLegFromQuote(row, column));
    combo.error = null;
  } catch (error) {combo.error = error.message;}
  renderCombo(); syncComboCells();
}

function openComboPreview() {
  if ($("simulateCombo").disabled) return;
  const legs = [...combo.legs.values()];
  const expiry = combo.expiry, expiryMs = legs[0] ? optionMs(legs[0].row) : null;
  const snapshot = () => ({btc_index_price: state.snapshot.btc_index_price, exchange_clock_offset_ms: state.snapshot.exchange_clock_offset_ms, fetched_at: state.snapshot.fetched_at, stale: Boolean(state.snapshot.stale || state.apiError || !isLiveSnapshot(state.snapshot))});
  window.OptionPortfolioPreview.open({legs, snapshot: snapshot(), getLatest: (requestedLegs = legs) => {
    const requestedKeys = new Set(requestedLegs.map((leg) => comboKey(leg.row.symbol, leg.direction)));
    const currentLegs = legs.filter((leg) => requestedKeys.has(comboKey(leg.row.symbol, leg.direction)));
    const rows = new Map(allOptions().map((row) => [row.symbol, row]));
    if (currentLegs.some((leg) => optionDate(leg.row) !== expiry || optionMs(leg.row) !== expiryMs || optionMs(leg.row) <= marketNow() || !rows.has(leg.row.symbol))) return {error: "所选合约已到期或已从行情移除，请重新选择。", legs: [], snapshot: snapshot()};
    const latest = currentLegs.map((leg) => {
      const row = rows.get(leg.row.symbol), column = leg.direction === "BUY" ? "ask" : "bid", field = `${column}_price`, quoteSource = fieldSource(row, "quote", field);
      const eventTime = row.field_event_ms && Object.hasOwn(row.field_event_ms, field) ? row.field_event_ms[field] : row.quote_event_ms;
      return {...leg, row: JSON.parse(JSON.stringify(row)), premium: row[field], quoteSource, quoteTime: quoteSource === "websocket" ? eventTime ?? fieldTime(row, "quote", field) : fieldTime(row, "quote", field), quoteDescription: fieldDescription(row, "quote", field)};
    });
    return {legs: latest, snapshot: snapshot()};
  }});
}

function activateQuoteCell(cell) {
  if (!["bid", "ask"].includes(cell.dataset.column)) {openDrawer(cell.dataset.symbol, cell); return;}
  const symbol = cell.dataset.symbol;
  const row = allOptions().find((option) => option.symbol === symbol);
  if (!row) return;
  if (combo.active) {toggleComboQuote(row, cell.dataset.column); return;}
  if (!$("detailDrawer").hidden) closeDrawer();
  const previewSnapshot = () => ({...state.snapshot, stale: Boolean(state.snapshot.stale || state.apiError || !isLiveSnapshot(state.snapshot))});
  window.OptionPayoffPreview.open({row, snapshot: previewSnapshot()}, cell.dataset.column === "ask" ? "BUY" : "SELL", () => ({row: allOptions().find((option) => option.symbol === symbol), snapshot: previewSnapshot()}), cell);
}
function render(scrollToAtm = false) {
  renderMarket(); renderExpiries(); renderFilters(); renderChain(scrollToAtm); renderOverview(); state.lastOverview = Date.now(); if (!$("detailDrawer").hidden) renderDrawer();
}

const liveFieldGroups = {quote: ["bid_price", "ask_price", "bid_quantity", "ask_quantity"], mark: ["mark_price", "mark_iv", "bid_iv", "ask_iv", "delta", "gamma", "theta", "vega"], ticker: ["last_price", "volume_24h_contracts", "amount_24h_quote", "last_trade_beijing"]};
function mergeFreshSnapshot(previous, incoming) {
  if (!previous?.options?.length) return incoming;
  const oldRows = new Map(previous.options.map((row) => [row.symbol, row]));
  const options = incoming.options.map((newRow) => {
    const oldRow = oldRows.get(newRow.symbol); if (!oldRow) return newRow;
    const verifiedQuote = window.OptionRiskUI?.isVerifiedBook?.(newRow, Date.now()) === true;
    const row = {...newRow, field_updated_at: {...newRow.field_updated_at}, field_source: {...newRow.field_source}, field_event_ms: {...newRow.field_event_ms}};
    let restoredQuote = false;
    if (Object.hasOwn(newRow, "quote_verification") && !verifiedQuote) {row.quote_verified_at = null; row.quote_verification = null;}
    for (const [group, keys] of Object.entries(liveFieldGroups)) {
      // An authenticated change-only book is one coherent four-field group.
      // Its old change receipts must not invite newer REST fields into it.
      if (group === "quote" && verifiedQuote) continue;
      for (const key of keys) {
        const oldTime = timeMs(oldRow.field_updated_at?.[key] ?? oldRow[`${group}_updated_at`] ?? previous.fetched_at) ?? 0;
        const newTime = timeMs(newRow.field_updated_at?.[key] ?? newRow[`${group}_updated_at`] ?? incoming.fetched_at) ?? 0;
        if (oldTime > newTime) {
          row[key] = oldRow[key]; row.field_updated_at[key] = oldTime;
          row.field_source[key] = oldRow.field_source?.[key] ?? oldRow[`${group}_source`] ?? "rest";
          row.field_event_ms[key] = oldRow.field_event_ms?.[key] ?? oldRow[`${group}_event_ms`] ?? null;
          if (group === "quote") restoredQuote = true;
        }
      }
      if ((timeMs(oldRow[`${group}_updated_at`]) ?? 0) > (timeMs(newRow[`${group}_updated_at`]) ?? 0)) {row[`${group}_updated_at`] = oldRow[`${group}_updated_at`]; row[`${group}_source`] = oldRow[`${group}_source`]; row[`${group}_event_ms`] = oldRow[`${group}_event_ms`];}
    }
    if (restoredQuote) {
      // An older response cannot replace observed liquidity. Independently
      // retained fields also cannot inherit a certificate for another frame.
      row.quote_verified_at = null; row.quote_verification = null;
      const receipts = liveFieldGroups.quote.map(key => timeMs(row.field_updated_at[key] ?? row.quote_updated_at));
      const sources = liveFieldGroups.quote.map(key => row.field_source[key] ?? row.quote_source);
      row.quote_group_valid = newRow.quote_group_valid !== false && receipts[0] !== null && receipts.every(at => at === receipts[0]) && sources.every(source => source === sources[0]);
    }
    return row;
  });
  const merged = {...incoming, options};
  if ((timeMs(previous.index_updated_at) ?? 0) > (timeMs(incoming.index_updated_at) ?? 0)) {for (const key of ["btc_index_price", "index_updated_at", "index_source", "index_event_ms"]) merged[key] = previous[key];}
  return merged;
}

const retiredSnapshotInstances = new Set();
let observedSnapshotVersion = null;
function observeSnapshotVersion(data) {
  const instance = typeof data.instance_id === "string" && data.instance_id ? data.instance_id : null;
  if (instance && retiredSnapshotInstances.has(instance)) return false;
  const references = [observedSnapshotVersion, state.pendingSnapshot, state.snapshot].filter(Boolean);
  const revision = number(data.revision);
  if (references.some(previous => previous.instance_id === data.instance_id && revision !== null && number(previous.revision) !== null && revision < number(previous.revision))) return false;
  if (instance) {
    for (const previous of references) {
      if (typeof previous.instance_id === "string" && previous.instance_id && previous.instance_id !== instance) retiredSnapshotInstances.add(previous.instance_id);
    }
    while (retiredSnapshotInstances.size > 16) retiredSnapshotInstances.delete(retiredSnapshotInstances.values().next().value);
    const previousRevision = observedSnapshotVersion?.instance_id === instance ? observedSnapshotVersion.revision : null;
    observedSnapshotVersion = {instance_id: instance, revision: revision ?? previousRevision};
  }
  return true;
}
function acceptSnapshot(data) {
  if (!data || !Array.isArray(data.options)) throw new Error("行情数据格式异常");
  if (!observeSnapshotVersion(data)) return;
  const hasData = data.options.length > 0 && number(data.btc_index_price) > 0;
  if (!hasData && state.snapshot?.options?.length) {
    state.currentSnapshotUnavailable = true;
    state.apiError = data.error?.message ?? "行情暂时不可用，保留最近数据。";
    state.snapshot = {...state.snapshot, stale: true, error: data.error, realtime: data.realtime ?? state.snapshot.realtime,
      // Keep the received prices as reference, but an unavailable service
      // cannot renew or carry a former connection's book certificate.
      options: state.snapshot.options.map(row => ({...row, quote_verified_at: null, quote_verification: null, quote_group_valid: false}))};
    window.OptionRiskUI?.onSnapshot?.(state.snapshot);

    renderConnection(); return;
  }
  state.snapshot = mergeFreshSnapshot(state.snapshot, data);
  state.currentSnapshotUnavailable = !hasData;
  state.apiError = hasData ? null : data.error?.message ?? null;
  const dates = expiryDates();
  if (state.expiry === null || (state.expiry !== "ALL" && !dates.includes(state.expiry))) {state.expiry = dates[0] ?? "ALL"; if (combo.active && state.expiry !== "ALL") changeComboExpiry(state.expiry);}
  const firstData = state.initial && dates.length > 0;
  if (firstData) state.initial = false;
  window.OptionRiskUI?.onSnapshot?.(state.snapshot);

  if (document.hidden) return;
  if (firstData || !state.chainKey) {render(firstData); return;}
  renderMarket(); renderExpiries(); renderFilters(); updateChain();
  if (Date.now() - state.lastOverview >= 2000 && !document.body.classList.contains("overview-collapsed")) {renderOverview(); state.lastOverview = Date.now();}
  if (!$("detailDrawer").hidden) renderDrawer();
}

function queueSnapshot(data) {
  if (!data || !Array.isArray(data.options)) throw new Error("行情数据格式异常");
  // Fence the instance as soon as it is observed, before the render frame.
  // An old HTTP/SSE callback must not overwrite a pending restarted service.
  if (!observeSnapshotVersion(data)) return;
  state.pendingSnapshot = data;
  if (document.hidden) {acceptSnapshot(data); state.pendingSnapshot = null; return;}
  if (state.scheduledRender) return;
  state.scheduledRender = true;
  requestAnimationFrame(() => {state.scheduledRender = false; const pending = state.pendingSnapshot; state.pendingSnapshot = null; if (pending) acceptSnapshot(pending);});
}

function connectEvents() {
  if (!("EventSource" in window)) {state.apiError = "当前浏览器不支持实时推送，请使用新版浏览器。"; return;}
  if (state.stream) state.stream.close();
  const stream = new EventSource("/api/events"); state.stream = stream;
  stream.onopen = () => {state.streamConnected = true; state.streamLastAt = Date.now(); renderConnection();};
  const receive = (event) => {
    try {const data = JSON.parse(event.data); state.streamConnected = true; state.streamLastAt = Date.now(); queueSnapshot(data);}
    catch {state.apiError = "实时行情格式异常，等待下一次推送。"; renderConnection();}
  };
  stream.addEventListener("snapshot", receive);
  stream.onmessage = receive;
  stream.addEventListener("heartbeat", () => {state.streamConnected = true; state.streamLastAt = Date.now(); renderConnection();});
  stream.onerror = () => {state.streamConnected = false; renderConnection();};
}

async function fetchMarket(refresh = false) {
  if (state.fetching) return;
  state.fetching = true; renderConnection();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/market${refresh ? "?refresh=1" : ""}`, {cache: "no-store", signal: controller.signal});
    if (!response.ok) throw new Error(`本地服务返回 HTTP ${response.status}`);
    const data = await response.json();
    state.lastFetch = Date.now();
    acceptSnapshot(data);
  } catch (error) {
    state.apiError = error.name === "AbortError" ? "本地行情服务响应超时。" : "本地行情服务暂时不可用，请确认看板程序正在运行。";

    renderConnection();
    if (!state.snapshot) {$("tableLoading").innerHTML = `<strong>暂时无法连接行情服务</strong><span>${escapeHtml(state.apiError)}</span><button class="refresh-button" id="retryConnection">重新连接</button>`; $("retryConnection").addEventListener("click", () => fetchMarket());}
  } finally {clearTimeout(timeout); state.fetching = false; renderConnection();}
}

$("expiryTabs").addEventListener("click", (event) => {const button = event.target.closest("button[data-expiry]"); if (!button) return; if (combo.active) {if (button.dataset.expiry === "ALL") {combo.active = false; combo.error = null;} else changeComboExpiry(button.dataset.expiry);} state.expiry = button.dataset.expiry; state.selected = null; closeDrawer(); render(true);});
$("sideButtons").addEventListener("click", (event) => {const button = event.target.closest("button[data-side]"); if (!button) return; state.side = button.dataset.side; render();});
$("searchInput").addEventListener("input", (event) => {state.search = event.target.value.trim(); renderFilters(); renderChain();});
$("atmButton").addEventListener("click", () => {state.atm = !state.atm; render(true);});
$("favoritesButton").addEventListener("click", () => {state.favoritesOnly = !state.favoritesOnly; if (state.favoritesOnly) {state.expiry = "ALL"; combo.active = false;} render();});
$("greeksButton").addEventListener("click", () => {state.greeks = !state.greeks; renderFilters(); renderChain();});
$("refreshButton").addEventListener("click", () => fetchMarket(true));
$("resetButton").addEventListener("click", () => {
  Object.assign(state, {side: "ALL", search: "", atm: false, favoritesOnly: false});
  const dates = expiryDates();
  const preferred = combo.active ? combo.expiry : state.expiry;
  state.expiry = dates.includes(preferred) ? preferred : !combo.active && preferred === "ALL" ? "ALL" : dates[0] ?? "ALL";
  if (combo.active) {changeComboExpiry(state.expiry); if (state.expiry === "ALL") combo.active = false;}
  $("searchInput").value = ""; render(true);
});
$("chainBody").addEventListener("click", (event) => {const cell = event.target.closest("td[data-symbol]"); if (cell) activateQuoteCell(cell);});
$("chainBody").addEventListener("keydown", (event) => {if (event.key === "Enter" || event.key === " ") {const cell = event.target.closest("td[data-symbol]"); if (cell) {event.preventDefault(); activateQuoteCell(cell);}}});
$("closeDrawer").addEventListener("click", closeDrawer); $("drawerBackdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if ($("payoffDialog").open || $("portfolioDialog")?.open || $("helpDialog").open || $("riskDialog")?.open) return;
  if (event.key === "Escape") {
    if (!$("detailDrawer").hidden) {event.preventDefault(); closeDrawer(); return;}
    if (document.body.classList.contains("quote-focus")) {event.preventDefault(); applyQuoteFocus(false);}
  } else if (event.key === "Tab" && !$("detailDrawer").hidden) {
    const targets = [...$("detailDrawer").querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length);
    const first = targets[0], last = targets[targets.length - 1];
    if (targets.length && (!$("detailDrawer").contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus({preventScroll: true});
    }
  }
});
$("comboButton").addEventListener("click", () => setComboMode(!combo.active));
$("focusComboButton").addEventListener("click", () => setComboMode(!combo.active));
$("endCombo").addEventListener("click", () => setComboMode(false));
$("clearCombo").addEventListener("click", () => {combo.legs.clear(); combo.error = null; renderCombo(); syncComboCells();});
$("simulateCombo").addEventListener("click", openComboPreview);
$("comboLegs").addEventListener("click", (event) => {const key = event.target.closest("button[data-remove-leg]")?.dataset.removeLeg; if (!key) return; combo.legs.delete(key); combo.error = null; renderCombo(); syncComboCells();});
$("comboLegs").addEventListener("input", (event) => {const key = event.target.dataset.comboQuantity, leg = combo.legs.get(key); if (!leg) return; leg.quantity = event.target.value; combo.error = null; renderCombo();});
window.addEventListener("resize", () => {if (combo.active) renderCombo();});
$("helpButton").addEventListener("click", () => $("helpDialog").showModal()); $("closeHelp").addEventListener("click", () => $("helpDialog").close()); $("helpDone").addEventListener("click", () => $("helpDialog").close());
function applyTheme(light) {document.body.classList.toggle("dark", !light); $("themeButton").textContent = light ? "☾" : "☼"; $("themeButton").setAttribute("aria-label", light ? "切换深色主题" : "切换浅色主题");}
applyTheme(loadStorage("btc-options-anthropic-light-theme", true));
$("themeButton").addEventListener("click", () => {const light = document.body.classList.contains("dark"); applyTheme(light); saveStorage("btc-options-anthropic-light-theme", light);});
function applyOverview(collapsed) {document.body.classList.toggle("overview-collapsed", collapsed); $("overviewContent").hidden = collapsed; $("toggleOverview").setAttribute("aria-expanded", String(!collapsed)); $("toggleOverview").textContent = collapsed ? "展开市场概况" : "收起市场概况"; if (!collapsed && state.snapshot) renderOverview();}
applyOverview(loadStorage("btc-options-overview-collapsed", false));
$("toggleOverview").addEventListener("click", () => {const collapsed = !document.body.classList.contains("overview-collapsed"); applyOverview(collapsed); saveStorage("btc-options-overview-collapsed", collapsed);});
let beforeFocusScroll = 0;
function applyQuoteFocus(enabled) {
  if (enabled) beforeFocusScroll = window.scrollY;
  document.body.classList.toggle("quote-focus", enabled);
  $("focusControls").hidden = !enabled;
  $("focusButton").setAttribute("aria-pressed", String(enabled));
  if (enabled) $("exitFocus").focus({preventScroll:true});
  else {window.scrollTo({top:beforeFocusScroll,behavior:"instant"}); $("focusButton").focus({preventScroll:true});}
}
$("focusButton").addEventListener("click", () => applyQuoteFocus(true));
$("exitFocus").addEventListener("click", () => applyQuoteFocus(false));
window.OptionRiskUI?.initialize({getSnapshot: () => state.snapshot, getExpiry: () => state.expiry});
window.OptionAIUI?.initialize({
  getSnapshot: () => state.snapshot,
  getExpiry: () => state.expiry,
  onOpenCandidate: async (candidate, context) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let current;
    try {
      const response = await fetch("/api/option-ai/selection", {method: "POST", cache: "no-store",
        headers: {"Content-Type": "application/json", "X-Terminal-Request": "1"},
        body: JSON.stringify({symbol: candidate.symbol, criteria: context.criteria,
          ...(context.risk_profile?.id ? {risk_profile: context.risk_profile.id} : {})}), signal: controller.signal});
      current = await response.json();
      if (!response.ok) throw new Error(current.error ?? "当前合约暂不可用，请更新报价。");
    } catch (error) {
      if (error.name === "AbortError") throw new Error("当前报价校验超时，请重试。");
      throw error;
    } finally {clearTimeout(timer);}
    if (!$("aiDialog").open || context.isCurrent?.() === false) throw new Error("筛选窗口已关闭或需求已变更。");
    if (!current?.row || !current?.candidate || current.row.symbol !== candidate.symbol) throw new Error("当前报价校验失败，请更新报价。");
    combo.active = false; combo.error = null;
    state.expiry = optionDate(current.row); state.side = "ALL"; state.search = ""; state.favoritesOnly = false; state.atm = false;
    $("searchInput").value = "";
    if (!$("detailDrawer").hidden) closeDrawer();
    render();
    const latest = () => ({row: allOptions().find(row => row.symbol === candidate.symbol),
      snapshot: {...state.snapshot, stale: Boolean(state.apiError || !isLiveSnapshot(state.snapshot))}});
    const cell = [...$("chainBody").querySelectorAll("td[data-symbol]")].find(cell => cell.dataset.symbol === candidate.symbol && cell.dataset.column === (candidate.direction === "SELL" ? "bid" : "ask"));
    window.OptionPayoffPreview.open({row: current.row, snapshot: current.snapshot}, candidate.direction, latest,
      cell ?? {dataset: {symbol: candidate.symbol, column: candidate.direction === "SELL" ? "bid" : "ask"}});
    $("payoffQuantity").value = current.candidate.quantity;
    $("payoffQuantity").dispatchEvent(new Event("input", {bubbles: true}));
  }
});
connectEvents();
fetchMarket();
setInterval(() => {if (!document.hidden && (!state.streamConnected || Date.now() - state.streamLastAt > 25000)) fetchMarket();}, 15000);
setInterval(() => {if (!document.hidden) {renderConnection(); if (state.snapshot) updateChain();}}, 1000);
document.addEventListener("visibilitychange", () => {if (!document.hidden) {if (state.snapshot) {renderMarket(); renderExpiries(); renderFilters(); updateChain(); renderOverview(); if (!$("detailDrawer").hidden) renderDrawer();} if (!state.streamConnected || Date.now() - state.streamLastAt > 25000) fetchMarket();}});
