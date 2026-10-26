"use strict";

(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SellPutUI = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  const DEFAULTS = Object.freeze({balance: 1000, reserve: 0, quantityMode: "maxMargin", quantity: .1,
    minDays: 10, maxDays: 20, minStrikeRatio: .75, maxStrikeRatio: .8, maxSpreadPct: 50,
    feeRate: .00024, exerciseFeeRate: .00015, feeCap: .1, stressElapsedDays: 1, sort: "expiry"});
  const CALL_DEFAULTS = Object.freeze({...DEFAULTS, minStrikeRatio: 1.2, maxStrikeRatio: 1.25});
  const PROFILES = Object.freeze({PUT: {label: "Put", defaults: DEFAULTS, recordKey: "btc-options-sell-put-trials-v1"},
    CALL: {label: "Call", defaults: CALL_DEFAULTS, recordKey: "btc-options-sell-call-trials-v1"}});
  const FIELDS = {balance: "Balance", reserve: "Reserve", quantityMode: "QuantityMode", quantity: "Quantity",
    minDays: "MinDays", maxDays: "MaxDays", minStrikeRatio: "MinStrikeRatio", maxStrikeRatio: "MaxStrikeRatio",
    maxSpreadPct: "MaxSpreadPct", feeRate: "FeeRate", exerciseFeeRate: "ExerciseFeeRate", feeCap: "FeeCap",
    stressElapsedDays: "StressElapsedDays", sort: "Sort"};
  const PERCENT_INPUTS = new Set(["minStrikeRatio", "maxStrikeRatio", "feeRate", "exerciseFeeRate", "feeCap"]);
  const LABELS = {balance:"余额",reserve:"预留金额",quantity:"手工数量",minDays:"最少天数",maxDays:"最多天数",minStrikeRatio:"行权价比例下限",maxStrikeRatio:"行权价比例上限",maxSpreadPct:"价差上限",feeRate:"开仓费率",exerciseFeeRate:"行权费率",feeCap:"费用封顶比例",stressElapsedDays:"压力情景经过天数"};
  const numeric = (value) => typeof value === "number" ? Number.isFinite(value) ? value : null : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
  const fmt = new Intl.NumberFormat("en-US", {maximumFractionDigits: 6});
  const dateFmt = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
  const dayFmt = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"});
  const timeFmt = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
  const format = (value) => numeric(value) === null ? "—" : Math.abs(numeric(value)) > 0 && Math.abs(numeric(value)) < .000001 ? numeric(value).toExponential(3) : fmt.format(numeric(value));
  const pct = value => numeric(value) === null ? "—" : `${format(value)}%`;
  const ratioPct = value => numeric(value) === null ? "—" : pct(numeric(value) * 100);
  const signed = value => numeric(value) === null ? "—" : `${numeric(value) > 0 ? "+" : ""}${format(value)}`;
  const pnlClass = value => numeric(value) > 0 ? "sp-positive" : numeric(value) < 0 ? "sp-negative" : "";
  const message = value => typeof value === "string" ? value : value?.message ?? value?.code ?? "计算条件尚未满足";
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const stamp = value => numeric(value) ?? (typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);
  const beijing = value => stamp(value) !== null ? `${dateFmt.format(new Date(stamp(value)))}（北京）` : "时间未知";
  const expiryDate = entry => numeric(entry.expiryMs) !== null ? dayFmt.format(new Date(entry.expiryMs)) : entry.row?.expiry_beijing?.slice(0, 10) ?? "";

  function parseSettings(raw = {}, side = raw.side ?? "PUT") {
    const settings = {}, errors = [];
    if (!Object.hasOwn(PROFILES, side)) {errors.push("请选择有效的卖出方向。"); side = "PUT";}
    const manualQuantity = raw.quantityMode === "manual";
    for (const [key, fallback] of Object.entries(PROFILES[side].defaults)) {
      const value = raw[key];
      if (["quantityMode", "sort"].includes(key)) {settings[key] = typeof value === "string" && value.trim() ? value : fallback; continue;}
      // Automatic sizing does not use the disabled manual quantity field.
      if (key === "quantity" && !manualQuantity && numeric(value) === null) {settings[key] = fallback; continue;}
      if (value === undefined) {settings[key] = fallback; continue;}
      if (value === null || typeof value === "string" && !value.trim()) {errors.push(`${LABELS[key] ?? key}不能为空。`); settings[key] = fallback; continue;}
      const number = numeric(value);
      if (number === null) {errors.push(`${LABELS[key] ?? key}需要填写有效数字。`); settings[key] = fallback; continue;}
      settings[key] = PERCENT_INPUTS.has(key) ? number / 100 : number;
    }
    if (!(settings.balance > 0)) errors.push("余额需要大于 0。");
    if (settings.reserve < 0 || settings.reserve >= settings.balance) errors.push("预留金额需要非负且小于余额。");
    if (!["maxMargin", "manual", "cashSecured"].includes(settings.quantityMode)) errors.push("请选择有效的数量方式。");
    if (side === "CALL" && settings.quantityMode === "cashSecured") errors.push("裸卖 Call 无有限足额赔付模式，请选择保证金理论数量或手工数量。");
    if (settings.quantityMode === "manual" && !(settings.quantity > 0)) errors.push("手工数量需要大于 0。");
    if (settings.minDays < 0 || settings.maxDays < settings.minDays) errors.push("剩余天数区间需要非负，且最少不大于最多。");
    if (side === "CALL" ? settings.minStrikeRatio < 1 || settings.maxStrikeRatio < settings.minStrikeRatio : !(settings.minStrikeRatio > 0) || settings.maxStrikeRatio > 1 || settings.maxStrikeRatio < settings.minStrikeRatio) errors.push(side === "CALL" ? "Call 行权价 / 现价区间需不低于 100%，且下限不大于上限。" : "行权价 / 现价区间需大于 0%、不超过 100%，且下限不大于上限。");
    if (settings.maxSpreadPct < 0) errors.push("价差上限需要非负。");
    if (settings.stressElapsedDays < 0) errors.push("压力情景经过天数需要非负。");
    if (settings.feeRate < 0 || settings.feeRate > 1 || settings.exerciseFeeRate < 0 || settings.exerciseFeeRate > 1 || settings.feeCap < 0 || settings.feeCap > 1) errors.push("费率与封顶比例需在 0% 到 100% 之间。");
    if (!["expiry", "accountAnnual", "stress", "spread"].includes(settings.sort)) errors.push("请选择有效的排序方式。");
    settings.side = side;
    return {settings, errors};
  }

  function createSession(getSnapshot, now = () => Date.now()) {
    let active = false, paused = false, snapshot = null, at = null;
    const read = () => {
      if (!active) return null;
      if (!paused) {snapshot = clone(getSnapshot()); at = now();}
      return {snapshot, at, mode: paused ? "paused" : "live"};
    };
    return {
      open() {active = true; paused = false; return read();},
      close() {active = false;},
      read,
      pause() {if (active && !paused) read(); paused = true; return read();},
      resume() {paused = false; return read();},
      isPaused: () => paused,
    };
  }

  // Renew a short-lived interest list on the local server. This never contacts
  // Binance from the browser and never changes the engine's freshness checks.
  function createMarkWatch(getContext, send, now = () => Date.now()) {
    let pending = false, sentAt = -Infinity, sentSelected = null;
    const candidatesFor = context => [...new Set([context.selectedSymbol, ...(context.entries ?? []).map(entry => entry.symbol ?? entry.row?.symbol)]
      .filter(symbol => typeof symbol === "string" && /^BTC-\d{6}-\d+(?:\.\d+)?-[PC]$/.test(symbol)))].slice(0, 8);
    function poll() {
      const context = getContext();
      if (!context?.active || context.hidden || context.paused || typeof send !== "function") return;
      const symbols = candidatesFor(context);
      if (!symbols.length || pending) return;
      const selected = symbols[0], changed = selected !== sentSelected;
      if (!changed && now() - sentAt < 10000) return;
      pending = true; sentAt = now(); sentSelected = selected;
      let request;
      try {request = send("/api/mark-watch?symbols=" + encodeURIComponent(symbols.join(",")), {cache: "no-store", credentials: "same-origin"});}
      catch {request = null;}
      Promise.resolve(request).catch(() => {}).finally(() => {
        pending = false;
        // A selection made while the local request was pending takes priority.
        const latest = getContext();
        if (latest && candidatesFor(latest)[0] !== sentSelected) poll();
      });
    }
    return {poll};
  }

  // These are presentation states only. The engine remains the sole authority
  // for whether a current quote can be calculated, recorded or exported.
  function isTemporaryDataIssue(issue, entry = {}) {
    if (typeof issue !== "string" || !issue) return false;
    const row = entry.row ?? {};
    if (/无有效买一报价/.test(issue)) return numeric(row.bid_price) === null;
    if (/无有效卖一报价/.test(issue)) return numeric(row.ask_price) === null;
    return /^(?:报价|深度|指数)(?:已陈旧|时间未知|时间异常)/.test(issue) ||
      /^(?:标记价\/IV(?:已陈旧|更新时间未知或异常)|盘口快照待核验|BTC 指数缺失|报价深度未知|合约可交易状态未知|合约规则核验过旧或时间未知|合约保证金\/数量规则缺失，等待目录核验|行情待更新|等待有效BTC公开行情|行情元数据缺失)/.test(issue);
  }
  function issueLabel(issue, mode = "live", detail = false, entry = {}) {
    if (!isTemporaryDataIssue(issue, entry)) return issue;
    if (mode === "paused") return "固定快照待更新，请恢复跟随行情";
    return detail ? "行情同步中，恢复后自动继续计算。" : "行情同步中";
  }
  const settingsKey = settings => JSON.stringify(Object.keys(settings ?? {}).sort().map(key => [key, settings[key]]));
  function currentTradeIssue(entry, settings, clock) {
    const row = entry.row ?? {}, bid = numeric(row.bid_price), ask = numeric(row.ask_price), depth = numeric(row.bid_quantity);
    if (numeric(entry.expiryMs) !== null && entry.expiryMs <= clock) return "合约已到期";
    if (row.status && row.status !== "TRADING") return "合约当前非可交易状态";
    if (numeric(row.unit) !== null && numeric(row.unit) !== 1 || row.quote_asset && row.quote_asset !== "USDT") return "合约乘数或结算币种不支持";
    if (bid !== null && bid <= 0) return "无有效买一报价";
    if (ask !== null && ask <= 0) return "无有效卖一报价";
    if (bid !== null && ask !== null && bid > ask) return "买卖报价交叉，待核验";
    if (bid > 0 && ask >= bid && (ask - bid) / bid * 100 > settings.maxSpreadPct + 1e-10) return "买卖价差超过筛选上限";
    if (depth !== null && (depth <= 0 || numeric(row.min_qty) !== null && depth < numeric(row.min_qty) - 1e-10 || settings.quantityMode === "manual" && depth < settings.quantity - 1e-10)) return "买卖一深度不足";
    return null;
  }
  const hasHardCurrentCondition = (entry, settings, clock) => Boolean(currentTradeIssue(entry, settings, clock));
  function createReferenceStore(maxAge = 300000) {
    const saved = new Map(); let key = null;
    function reset() {saved.clear(); key = null;}
    function prepare(settings) {const next = settingsKey(settings); if (key !== next) {saved.clear(); key = next;}}
    function alive(item, sample, now) {
      const clock = now + (numeric(sample?.snapshot?.exchange_clock_offset_ms) ?? 0);
      return item && now >= item.savedAt && now - item.savedAt <= maxAge && item.entry.expiryMs > clock;
    }
    function update(rows, settings, sample, now = Date.now()) {
      prepare(settings);
      for (const [symbol, item] of saved) if (!alive(item, sample, now)) saved.delete(symbol);
      if (sample?.mode === "paused") return;
      for (const entry of rows) {
        const symbol = entry.symbol ?? entry.row?.symbol;
        if (!symbol) continue;
        if (hasHardCurrentCondition(entry, settings, now + (numeric(sample?.snapshot?.exchange_clock_offset_ms) ?? 0))) {saved.delete(symbol); continue;}
        if (entry.metrics && !entry.issue) {
          const {options, ...referenceSnapshot} = sample?.snapshot ?? {};
          saved.set(symbol, {entry: clone(entry), sample: clone({...sample, snapshot: referenceSnapshot}), savedAt: now});
        }
        else if (!isTemporaryDataIssue(entry.issue, entry)) saved.delete(symbol);
      }
    }
    function present(entry, settings, sample, now = Date.now()) {
      prepare(settings);
      const item = saved.get(entry.symbol ?? entry.row?.symbol);
      const condition = sample?.mode === "paused" ? null : currentTradeIssue(entry, settings, now + (numeric(sample?.snapshot?.exchange_clock_offset_ms) ?? 0));
      const issue = condition ?? entry.issue, syncing = !condition && isTemporaryDataIssue(entry.issue, entry);
      const retained = Boolean(sample?.mode !== "paused" && syncing && alive(item, sample, now));
      return {entry: retained ? item.entry : entry, sample: retained ? item.sample : sample, retained, syncing, issue};
    }
    function pendingRows(issue, settings, sample, now = Date.now()) {
      prepare(settings);
      if (sample?.mode === "paused" || !isTemporaryDataIssue(issue)) return [];
      const current = new Map((sample?.snapshot?.options ?? []).map(row => [row.symbol, row]));
      return [...saved.values()].filter(item => alive(item, sample, now)).map(item => ({...clone(item.entry), row: clone(current.get(item.entry.symbol) ?? {}), issue, metrics: null, stress: []}));
    }
    return {update, present, pendingRows, reset};
  }

  function filterVisible(rows, {onlyCalculated = false, expiry = "ALL", chainExpiry = null} = {}) {
    const date = expiry === "CHAIN" ? chainExpiry : expiry;
    return (Array.isArray(rows) ? rows : []).filter(entry => (!onlyCalculated || entry.metrics && !entry.issue) &&
      (!date || date === "ALL" || expiryDate(entry) === date));
  }

  function csvCell(value) {
    let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function exportRows(rows, settings, snapshot, meta = {}) {
    const side = meta.side ?? settings.side ?? rows[0]?.row?.side ?? (/-C$/.test(rows[0]?.symbol ?? "") ? "CALL" : "PUT"), isCall = side === "CALL";
    const headers = ["试算性质", "导出时间UTC", "快照试算时间UTC", "状态模式", "手工输入JSON", "BTC指数", "指数更新时间", "合约", "到期时间UTC", "剩余天数", "行权价", "K/现价", "买一单价", "卖一单价", "买一数量", "卖一数量", "标记IV", "数量张", "乘数", "毛权利金", "开仓费", "净权利金", "下单IM", "持仓IM", "维持保证金", "调整后权益", "盯市净值", "MM/调整后权益", "账户日化%", "账户单利年化%", "订单保证金日化%", "订单保证金单利年化%", isCall ? "现货名义参考日化%" : "足额赔付日化%", isCall ? "现货名义参考单利年化%" : "足额赔付单利年化%", isCall ? "现货名义参考资金基数" : "足额赔付资金基数", "到期最大损失", "状态", "警告", "压力情景JSON", "展示状态", "最近有效参考快照UTC", "期权方向", "最大亏损无上限", "第三收益口径说明"];
    const iso = value => stamp(value) === null ? "" : new Date(stamp(value)).toISOString();
    const lines = [headers];
    rows.forEach(entry => {
      const row = entry.row ?? {}, m = entry.metrics ?? {}, reference = meta.references?.get(entry.symbol ?? row.symbol);
      lines.push(["手工模拟，非实盘成交", iso(meta.exportedAt ?? Date.now()), iso(meta.at), meta.mode === "paused" ? "固定历史试算" : "自动跟随公开行情", settings, snapshot?.btc_index_price, snapshot?.index_updated_at,
        entry.symbol ?? row.symbol, iso(entry.expiryMs), entry.days, entry.strike, entry.strikeRatio,
        row.bid_price, row.ask_price, row.bid_quantity, row.ask_quantity, row.mark_iv, m.quantity, row.unit,
        m.grossPremium, m.entryFee, m.netPremium, m.orderMargin, m.positionMargin, m.maintenanceMargin,
        m.adjustedEquity, m.equity, m.marginRatio, m.accountDailyPct, m.accountAnnualPct,
        m.orderDailyPct, m.orderAnnualPct, isCall ? m.notionalDailyPct : m.cashDailyPct, isCall ? m.notionalAnnualPct : m.cashAnnualPct, isCall ? m.notionalCapital : m.cashSecuredCapital, m.lossUnbounded ? "无限" : m.maxExpiryLoss,
        entry.issue ?? (entry.metrics ? "可算 · 单笔理论" : "不可算"), (entry.warnings ?? []).map(message).join("；"), entry.stress ?? [],
        reference?.retained ? "页面保留历史参考；当前行情不可算，历史金额未作为当前结果导出" : "当前试算状态", reference?.retained ? iso(reference.sample?.at) : "", side, m.lossUnbounded ?? "", isCall ? "现货名义金额参考；不是有限赔付覆盖，也不是USDT保证金信用" : "行权价×数量的足额赔付资金"]);
    });
    return "\uFEFF" + lines.map(line => line.map(csvCell).join(",")).join("\r\n");
  }

  function stressMatrix(entry) {
    const points = Array.isArray(entry.stress) ? entry.stress : [];
    const firstMove = numeric(points[0]?.movePct);
    const columns = points.filter(point => firstMove !== null && numeric(point.movePct) === firstMove).map(point => numeric(point.vol));
    const moves = [...new Set(points.map(point => numeric(point.movePct)).filter(value => value !== null))];
    const states = {normal: "未触发", "margin-call": "触及预警条件", liquidation: "触及强平条件", unknown: "无法判断", settled: "已到期现金结算"};
    const labels = ["当前 IV", "+20 点", "+60 点"];
    const heading = `<tr><th scope="col">BTC 变动</th>${columns.map((vol, i) => `<th scope="col">${labels[i] ?? "IV 情景"} · ${ratioPct(vol)}</th>`).join("")}</tr>`;
    const body = moves.map(move => `<tr><th scope="row">${move > 0 ? "+" : ""}${ratioPct(move)}</th>${columns.map(vol => {
      const point = (entry.stress ?? []).find(item => numeric(vol) !== null && numeric(item.vol) !== null && Math.abs(item.vol - vol) < 1e-8 && Math.abs(item.movePct - move) < 1e-8);
      const state = point && Object.hasOwn(states, point.state) ? point.state : "unknown";
      return `<td data-state="${state}"><strong class="${pnlClass(point?.pnl)}">${signed(point?.pnl)} <small>USDT</small></strong><small>MM / 调整后权益 ${ratioPct(point?.marginRatio)}</small><small>理论回购价 ${format(point?.mark)}</small><span class="sp-state">${states[state]}</span>${state === "settled" ? '<small>不保证此前能持有到期</small>' : ""}</td>`;
    }).join("")}</tr>`).join("");
    return `<table class="sp-matrix"><thead>${heading}</thead><tbody>${body}</tbody></table>`;
  }

  let hooks, session, markWatch, initialized = false, timer = null, inputTimer = null, trigger = null;
  let sample = null, settings = null, entries = [], visible = [], selectedSymbol = null;
  let tableHtml = "", detailHtml = "", expiryKey = null, restoredExpiry = null, orderKey = "", stableOrder = [];
  let sourceDetailsSymbol = null, sourceDetailsOpen = false;
  let referenceStore = createReferenceStore(), presentations = new Map(), activeSide = "PUT";
  const sideStates = new Map();
  const $ = id => document.getElementById(id);
  function rawSettings() {return Object.fromEntries(Object.entries(FIELDS).map(([key, suffix]) => [key, $("sellPut" + suffix).value]));}
  function resetInputs() {
    const defaults = PROFILES[activeSide].defaults;
    for (const [key, suffix] of Object.entries(FIELDS)) $("sellPut" + suffix).value = PERCENT_INPUTS.has(key) ? defaults[key] * 100 : defaults[key];
    $("sellPutExpiry").value = "ALL"; $("sellPutOnlyCalculated").checked = false;
  }
  function setText(id, text) {$(id).textContent = text;}
  function profileChrome() {
    const label = PROFILES[activeSide].label, isCall = activeSide === "CALL";
    $("sellPutSide").value = activeSide;
    setText("sellPutHeading", `卖 ${label} 工作台`);
    $("sellPutClose").setAttribute("aria-label", `关闭卖 ${label} 工作台`);
    setText("sellPutIntro", isCall ? "先看上涨压力，再看权利金。裸卖 Call 最大亏损无上限。" : "先看能承担多少，再看权利金。余额来自手工输入。");
    setText("sellPutCaption", `卖 ${label} 候选，按手工账户余额与单笔保证金口径估算。点击合约查看压力情景。`);
    $("sellPutCashMode").disabled = isCall; $("sellPutCashMode").hidden = isCall;
    for (const suffix of ["MinStrikeRatio", "MaxStrikeRatio"]) {
      $("sellPut" + suffix).min = isCall ? "100" : "0"; $("sellPut" + suffix).max = isCall ? "" : "100";
      $("sellPut" + suffix).placeholder = String(PROFILES[activeSide].defaults[suffix === "MinStrikeRatio" ? "minStrikeRatio" : "maxStrikeRatio"] * 100);
    }
    setText("sellPutCaution", (isCall ? "裸卖 Call 最大亏损无上限，不存在有限足额现金赔付覆盖。现货名义金额参考不是 USDT 保证金信用。" : "") + "“尽量用满”是空仓、单笔、买一深度足够时的理论上限；浮亏和保证金要求变化会迅速减少余量。各行独立试算，数量不能相加作为组合。");
    setText("sellPutAssumptions", "仅使用公开行情与手工假设。三种收益率都是持有到期的权利金口径，不是历史收益、每日到账或保证收益。" + (isCall ? "第三口径为现货名义金额参考，不是有限赔付覆盖，也不是 USDT 保证金信用。" : "") + "理论估值非可成交回购价；未模拟逐路径 / 精确强平价格。");
  }
  function rememberSide() {
    const sources = $("sellPutDetail").querySelector?.("details.sp-source-details");
    sideStates.set(activeSide, {raw: rawSettings(), expiry: $("sellPutExpiry").value, onlyCalculated: $("sellPutOnlyCalculated").checked,
      session, referenceStore, selectedSymbol, stableOrder, orderKey, sourceDetailsSymbol,
      sourceDetailsOpen: sources ? sources.open : sourceDetailsOpen, recordStatus: $("sellPutRecordStatus").textContent,
      scrollLeft: $("sellPutTableScroll").scrollLeft, scrollTop: $("sellPutTableScroll").scrollTop});
  }
  function switchSide(next) {
    if (!initialized || !Object.hasOwn(PROFILES, next) || next === activeSide) return;
    if (inputTimer !== null) clearTimeout(inputTimer); inputTimer = null;
    rememberSide(); activeSide = next;
    const saved = sideStates.get(next);
    session = saved?.session ?? createSession(hooks.getSnapshot);
    referenceStore = saved?.referenceStore ?? createReferenceStore();
    selectedSymbol = saved?.selectedSymbol ?? null; stableOrder = saved?.stableOrder ?? []; orderKey = saved?.orderKey ?? "";
    sourceDetailsSymbol = saved?.sourceDetailsSymbol ?? null; sourceDetailsOpen = saved?.sourceDetailsOpen ?? false;
    sample = settings = null; entries = []; visible = []; presentations = new Map();
    tableHtml = detailHtml = ""; expiryKey = null; restoredExpiry = saved?.expiry ?? "ALL";
    $("sellPutRows").innerHTML = ""; $("sellPutDetail").innerHTML = "";
    if (saved) {
      for (const [key, suffix] of Object.entries(FIELDS)) $("sellPut" + suffix).value = saved.raw[key];
      $("sellPutExpiry").value = saved.expiry; $("sellPutOnlyCalculated").checked = saved.onlyCalculated;
    } else resetInputs();
    setText("sellPutRecordStatus", saved?.recordStatus ?? "仅保存手工模拟和假设，不是实盘成交。");
    $("sellPutTableScroll").scrollLeft = saved?.scrollLeft ?? 0; $("sellPutTableScroll").scrollTop = saved?.scrollTop ?? 0;
    profileChrome();
    if ($("sellPutDialog").open) {if (!session.read()) session.open(); render();}
  }
  function showError(errors) {$("sellPutError").hidden = !errors.length; setText("sellPutError", errors.join(" "));}
  function updateExpiryOptions() {
    const dates = [...new Set(entries.map(expiryDate).filter(Boolean))].sort(), key = dates.join("|");
    if (key === expiryKey) return;
    const before = restoredExpiry ?? $("sellPutExpiry").value; restoredExpiry = null;
    $("sellPutExpiry").innerHTML = '<option value="ALL">全部符合期限的到期日</option><option value="CHAIN">跟随期权链所选到期日</option>' + dates.map(date => `<option value="${esc(date)}">${esc(date)}</option>`).join("");
    $("sellPutExpiry").value = ["ALL", "CHAIN", ...dates].includes(before) ? before : "ALL"; expiryKey = key;
  }
  function paintTable() {
    const scope = {expiry: $("sellPutExpiry").value, chainExpiry: hooks.getExpiry?.()};
    visible = filterVisible(entries, {...scope, onlyCalculated: $("sellPutOnlyCalculated").checked});
    presentations = new Map(entries.map(entry => [entry.symbol ?? entry.row?.symbol, referenceStore.present(entry, settings, sample)]));
    const selected = entries.find(entry => (entry.symbol ?? entry.row?.symbol) === selectedSymbol);
    const holdSelection = selected && filterVisible([selected], scope).length && isTemporaryDataIssue(selected.issue, selected) && !hasHardCurrentCondition(selected, settings, Date.now() + (numeric(sample?.snapshot?.exchange_clock_offset_ms) ?? 0));
    if (!holdSelection && !visible.some(entry => (entry.symbol ?? entry.row?.symbol) === selectedSymbol)) selectedSymbol = (visible.find(entry => entry.metrics && !entry.issue) ?? visible[0])?.symbol ?? visible[0]?.row?.symbol ?? null;
    const html = visible.map(entry => {
      const symbol = entry.symbol ?? entry.row?.symbol, view = presentations.get(symbol), shown = view?.entry ?? entry;
      const row = shown.row ?? {}, m = shown.metrics, warning = (shown.warnings ?? []).map(message).join("；");
      const status = view?.retained ? `参考快照 · ${timeFmt.format(new Date(view.sample.at))}` : issueLabel(view?.issue, sample?.mode, false, entry) ?? (m ? "可算 · 单笔理论" : "计算条件不足");
      return `<tr class="${symbol === selectedSymbol ? "is-selected" : ""}${view?.retained ? " sp-reference-row" : ""}" data-sp-row="${esc(symbol)}"><th scope="row"><button class="sp-contract" data-sp-symbol="${esc(symbol)}" aria-pressed="${symbol === selectedSymbol}">${esc(symbol)}<span>${esc(expiryDate(shown))} · 剩余 ${format(shown.days)} 天${view?.retained ? " · 历史参考" : ""}</span></button></th><td>${format(shown.strike)}<small>${ratioPct(shown.strikeRatio)}</small></td><td>${format(row.bid_price)} / ${format(row.ask_price)}<small>买 ${format(row.bid_quantity)} / 卖 ${format(row.ask_quantity)} 张</small></td><td>${ratioPct(row.mark_iv)}</td><td>${format(m?.quantity)}<small>${settings.quantityMode === "maxMargin" ? "保证金 / 深度约束" : settings.quantityMode === "cashSecured" ? "足额覆盖" : "手工量"}</small></td><td>${format(m?.netPremium)}<small>毛 ${format(m?.grossPremium)} USDT</small></td><td>${format(m?.orderMargin)}</td><td>${ratioPct(m?.marginRatio)}<small>MM / 调整后权益</small></td><td>${pct(m?.accountDailyPct)}</td><td>${pct(m?.accountAnnualPct)}</td><td class="sp-status ${view?.syncing ? "sp-syncing" : entry.issue || !m ? "sp-unavailable" : ""}" title="${esc(entry.issue ?? "")}">${esc(status)}${view?.retained ? '<small>等待最新行情；非当前可成交结果</small>' : ""}${warning ? `<small>${esc(warning)}</small>` : ""}</td></tr>`;
    }).join("");
    if (html !== tableHtml) {
      const focusSymbol = document.activeElement?.dataset?.spSymbol;
      const scroller = $("sellPutTableScroll"), left = scroller.scrollLeft, top = scroller.scrollTop;
      $("sellPutRows").innerHTML = html; tableHtml = html;
      scroller.scrollLeft = left; scroller.scrollTop = top;
      if (focusSymbol) [...$("sellPutRows").querySelectorAll("button[data-sp-symbol]")].find(button => button.dataset.spSymbol === focusSymbol)?.focus({preventScroll: true});
    }
    const calculated = entries.filter(entry => entry.metrics && !entry.issue).length;
    const syncing = [...presentations.values()].filter(view => view.syncing).length;
    setText("sellPutCount", `${visible.length} 个显示 / ${entries.length} 个候选 · ${calculated} 个可算${syncing ? ` · ${syncing} 个同步中` : ""}${entries.length - calculated - syncing ? ` · ${entries.length - calculated - syncing} 个条件未满足` : ""}`);
    $("sellPutEmpty").hidden = Boolean(visible.length);
    setText("sellPutEmpty", entries.length ? "暂无匹配结果。可取消“仅显示可算”或调整到期日查看原因。" : "该期限与行权价区间暂无候选，或行情尚未满足计算条件。");
    $("sellPutExport").disabled = !visible.length;
    paintDetail();
    markWatch?.poll();
  }
  function paintDetail() {
    const previousSources = $("sellPutDetail").querySelector?.("details.sp-source-details");
    if (sourceDetailsSymbol !== selectedSymbol) {sourceDetailsSymbol = selectedSymbol; sourceDetailsOpen = false;}
    else if (previousSources) sourceDetailsOpen = previousSources.open;
    const entry = visible.find(item => (item.symbol ?? item.row?.symbol) === selectedSymbol) ?? entries.find(item => (item.symbol ?? item.row?.symbol) === selectedSymbol && isTemporaryDataIssue(item.issue, item));
    $("sellPutRecord").disabled = !entry?.metrics || Boolean(entry?.issue) || numeric(entry?.expiryMs) !== null && entry.expiryMs <= Date.now() + (numeric(sample?.snapshot?.exchange_clock_offset_ms) ?? 0);
    let html = "";
    if (entry) {
      const view = presentations.get(selectedSymbol) ?? {entry, sample}, shown = view.entry, sourceSample = view.sample;
      const row = shown.row ?? {}, m = shown.metrics, issue = view.issue ?? entry.issue;
      const offset = numeric(sample?.snapshot?.exchange_clock_offset_ms) ?? 0;
      const expired = numeric(entry.expiryMs) !== null && entry.expiryMs <= Date.now() + offset;
      html = `<div class="sp-detail-heading"><h3>${esc(entry.symbol ?? row.symbol)}</h3><p>${view.retained ? "参考快照" : sample?.mode === "paused" ? "固定历史试算" : "自动跟随行情"} · ${beijing(sourceSample?.at)}</p></div>${expired ? '<p class="sp-expired">该合约按当前时间已到期；固定结果仅供历史试算。</p>' : ""}`;
      if (view.syncing) html += `<p class="sp-sync-status" role="status" title="${esc(issue)}"><span class="sp-sync-dot" aria-hidden="true"></span>${view.retained ? `行情同步中 · 最近有效参考 ${esc(timeFmt.format(new Date(sourceSample.at)))}<small>参考快照，等待最新行情；当前不可记录为有效试算。</small>` : esc(issueLabel(issue, sample?.mode, true, entry))}</p>`;
      html += `<details class="sp-source-details"${sourceDetailsOpen ? " open" : ""}><summary>${view.retained ? "参考快照" : "行情"}来源与时间</summary><p class="sp-note sp-sources">盘口 ${esc(beijing(row.quote_updated_at))} · ${esc(row.quote_source ?? "来源未知")}<br>标记价 ${format(row.mark_price)} · ${esc(beijing(row.field_updated_at?.mark_price ?? row.mark_updated_at))} · ${esc(row.field_source?.mark_price ?? row.mark_source ?? "来源未知")}<br>指数 ${esc(beijing(sourceSample?.snapshot?.index_updated_at))} · 合约规则 ${esc(beijing(sourceSample?.snapshot?.catalog_updated_at))}</p></details>`;
      if ((!m || issue) && !view.retained) {
        if (!view.syncing) html += `<p class="sp-error">${esc(issue ?? "当前条件无法计算，请等待有效报价与合约元数据。")}</p>`;
      } else {
        const isCall = activeSide === "CALL";
        const yields = [["整个手工账户", settings.balance, m.accountDailyPct, m.accountAnnualPct], ["订单保证金", m.orderMargin, m.orderDailyPct, m.orderAnnualPct], isCall ? ["现货名义金额参考", m.notionalCapital, m.notionalDailyPct, m.notionalAnnualPct] : ["足额赔付资金", m.cashSecuredCapital, m.cashDailyPct, m.cashAnnualPct]];
        html += `<div class="sp-yields">${yields.map(([label, base, daily, annual]) => `<div class="sp-yield"><h4>${label} · 基数 ${numeric(base) === null ? isCall && label === "现货名义金额参考" ? "当前指数 × 数量" : "行权价 × 数量" : format(base) + " USDT"}</h4><strong>${pct(annual)}<small>单利年化</small></strong><p>平均日化 ${pct(daily)}</p></div>`).join("")}</div>`;
        if (isCall) html += '<p class="sp-call-risk">裸卖 Call 到期最大亏损：<strong>无限</strong>。现货名义金额参考 = 当前指数 × 数量；不是有限赔付覆盖，也不是 USDT 保证金信用。</p>';
        html += `<div class="sp-detail-grid${view.retained ? " sp-reference-view" : ""}"><section><h4>${view.retained ? "参考快照 · " : ""}保证金压力 · 经过 ${format(settings.stressElapsedDays)} 天</h4><div class="sp-matrix-scroll">${stressMatrix(shown)}</div><p class="sp-note">IV 为当前值 / 增加 20 个百分点 / 增加 60 个百分点，最高 500%。单元格为模拟回购净盈亏和维持率；到期后改为现金结算，不保证此前能持有到期。</p><p class="sp-note">理论估值非可成交回购价；未模拟逐路径 / 精确强平价格。当前标记价锚定，BS 变化量重估，利率 r = 0。</p></section><aside class="sp-order"><h4>${view.retained ? "参考" : ""}订单摘要 · 不是成交记录</h4><p class="sp-equation">${format(row.bid_price)} USDT × ${format(m.quantity)} 张 × ${format(row.unit)}<br>= ${format(m.grossPremium)} USDT 毛权利金<br>− ${format(m.entryFee)} 开仓费 = ${format(m.netPremium)} USDT 净权利金</p><dl>${[["买一价差", pct(m.spreadPct)], ["理论订单保证金 IM", format(m.orderMargin)], ["持仓 IM", format(m.positionMargin)], ["MM · 含清算费准备", format(m.maintenanceMargin)], ["调整后权益 · MM 分母", format(m.adjustedEquity)], ["盯市净值 · 独立展示", format(m.equity)], ["开仓后可用", format(m.availableAfterEntry)], ["保证金理论上限（张）", format(m.maxMarginQuantity)], [isCall ? "足额赔付模式" : "足额覆盖上限（张）", isCall ? "不适用（亏损无上限）" : format(m.cashSecuredQuantity)], ["买一深度上限（张）", format(m.depthQuantity)], ["到期盈亏平衡价", format(m.breakEven)], ["到期最大损失", m.lossUnbounded ? "无限" : format(m.maxExpiryLoss)]].map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("")}</dl><p class="sp-sensitivities">头寸敏感度（API 单位）<br>Δ ${format(m.entryDelta)} · Γ ${format(m.entryGamma)}<br>Vega ${format(m.entryVega)} · Theta ${format(m.entryTheta)}</p></aside></div>`;
      }
    }
    if (html !== detailHtml) {$("sellPutDetail").innerHTML = html; detailHtml = html;}
  }
  function render() {
    if (!$("sellPutDialog").open || document.hidden) return;
    const parsed = parseSettings(rawSettings(), activeSide); settings = parsed.settings;
    $("sellPutQuantity").disabled = settings.quantityMode !== "manual";
    sample = session.read();
    const paused = sample?.mode === "paused";
    setText("sellPutMode", paused ? "固定历史试算" : "自动跟随行情"); $("sellPutMode").classList.toggle("is-paused", paused);
    setText("sellPutPause", paused ? "恢复跟随行情" : "暂停 / 固定快照"); $("sellPutPause").setAttribute("aria-pressed", String(paused));
    setText("sellPutSnapshot", sample?.snapshot ? `试算 ${beijing(sample.at)} · BTC ${format(sample.snapshot.btc_index_price)} USDT${paused ? " · 已暂停更新" : " · 按字段时效校验"}` : "等待公开行情");
    let errors = parsed.errors;
    if (!errors.length && typeof root.SellPutEngine?.evaluate !== "function") errors = [`卖 ${PROFILES[activeSide].label} 计算模块尚未载入，请刷新页面。`]; 
    let result = {rows: [], issues: []};
    if (!errors.length) {
      try {result = root.SellPutEngine.evaluate(sample?.snapshot, settings, sample?.at ?? Date.now(), activeSide);}
      catch {errors = ["试算暂不可用，请检查输入和公开行情状态。"];}
    }
    showError(errors);
    entries = !errors.length && Array.isArray(result?.rows) ? result.rows : [];
    const issues = Array.isArray(result?.issues) ? result.issues.map(message) : [];
    if (errors.length) {referenceStore.reset(); stableOrder = []; orderKey = "";}
    else {
      referenceStore.update(entries, settings, sample);
      if (!entries.length && issues.length && issues.every(issue => isTemporaryDataIssue(issue))) entries = referenceStore.pendingRows(issues[0], settings, sample);
      const nextKey = settingsKey(settings), symbols = entries.map(entry => entry.symbol ?? entry.row?.symbol);
      if (nextKey !== orderKey || !entries.some(entry => isTemporaryDataIssue(entry.issue, entry))) stableOrder = [...symbols];
      else {
        const ranks = new Map(stableOrder.map((symbol, index) => [symbol, index]));
        entries = [...entries].sort((a, b) => (ranks.get(a.symbol) ?? Infinity) - (ranks.get(b.symbol) ?? Infinity));
        stableOrder = [...new Set([...stableOrder, ...symbols])].filter(symbol => symbols.includes(symbol));
      }
      orderKey = nextKey;
    }
    $("sellPutIssues").hidden = !issues.length;
    setText("sellPutIssues", issues.map(issue => issueLabel(issue, sample?.mode, true)).join("；"));
    $("sellPutIssues").title = issues.join("；");
    updateExpiryOptions(); paintTable();
  }
  function queueRender() {if (inputTimer !== null) clearTimeout(inputTimer); inputTimer = setTimeout(() => {inputTimer = null; render();}, 120);}
  function close() {$("sellPutDialog")?.close();}
  function open(button, side = "PUT") {
    if (!initialized) return;
    switchSide(side);
    trigger = button ?? document.activeElement; selectedSymbol = null;
    session.open(); if (!$("sellPutDialog").open) $("sellPutDialog").showModal(); render();
    if (timer !== null) clearInterval(timer);
    timer = setInterval(render, 1000);
  }
  function initialize(options) {
    if (initialized || typeof document === "undefined" || !$("sellPutDialog")) return;
    if (typeof options?.getSnapshot !== "function") return;
    initialized = true; hooks = options; session = createSession(hooks.getSnapshot);
    profileChrome();
    markWatch = createMarkWatch(() => ({active: $("sellPutDialog").open, hidden: document.hidden, paused: session.isPaused(), selectedSymbol, entries}),
      typeof root.fetch === "function" ? (url, request) => root.fetch(url, request) : null);
    ["sellPutButton", "focusSellPutButton"].forEach(id => $(id)?.addEventListener("click", () => open($(id), "PUT")));
    ["sellCallButton", "focusSellCallButton"].forEach(id => $(id)?.addEventListener("click", () => open($(id), "CALL")));
    $("sellPutSide")?.addEventListener("change", () => switchSide($("sellPutSide").value));
    $("sellPutClose").addEventListener("click", close);
    $("sellPutDialog").addEventListener("cancel", event => {event.preventDefault(); event.stopPropagation(); close();});
    $("sellPutDialog").addEventListener("keydown", event => {if (event.key === "Escape") event.stopPropagation();});
    $("sellPutDialog").addEventListener("close", () => {
      session.close(); if (timer !== null) clearInterval(timer); timer = null;
      if (inputTimer !== null) clearTimeout(inputTimer); inputTimer = null;
      trigger?.focus?.({preventScroll: true});
    });
    $("sellPutForm").addEventListener("submit", event => event.preventDefault());
    $("sellPutForm").addEventListener("input", queueRender);
    $("sellPutForm").addEventListener("change", render);
    $("sellPutOnlyCalculated").addEventListener("change", paintTable);
    $("sellPutPause").addEventListener("click", () => {if (session.isPaused()) session.resume(); else session.pause(); render();});
    $("sellPutReset").addEventListener("click", () => {resetInputs(); render();});
    $("sellPutRows").addEventListener("click", event => {
      const button = event.target.closest("button[data-sp-symbol]"); if (!button) return;
      selectedSymbol = button.dataset.spSymbol; paintTable();
    });
    $("sellPutExport").addEventListener("click", () => {
      render(); if (!visible.length || !$("sellPutError").hidden) return;
      const content = exportRows(visible, settings, sample.snapshot, {...sample, side: activeSide, exportedAt: Date.now(), references: presentations});
      const url = URL.createObjectURL(new Blob([content], {type: "text/csv;charset=utf-8"})), link = document.createElement("a");
      link.href = url; link.download = `BTC-卖${PROFILES[activeSide].label}-手工试算-${new Date(sample.at).toISOString().replace(/[:.]/g, "-")}.csv`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $("sellPutRecord").addEventListener("click", () => {
      // Inputs use a short debounce and market updates arrive independently.
      // Saving must validate the displayed settings and latest feed now.
      render();
      if (!$("sellPutDialog").open || $("sellPutRecord").disabled || !$("sellPutError").hidden) return;
      const entry = visible.find(item => (item.symbol ?? item.row?.symbol) === selectedSymbol);
      if (!entry?.metrics || entry.issue) return;
      try {
        const key = PROFILES[activeSide].recordKey, saved = JSON.parse(localStorage.getItem(key) ?? "[]");
        const records = Array.isArray(saved) ? saved : [];
        records.push({kind: "手工试算，非实盘成交", side: activeSide, recordedAt: new Date().toISOString(), snapshotAt: new Date(sample.at).toISOString(), mode: sample.mode, settings, entry});
        localStorage.setItem(key, JSON.stringify(records.slice(-50)));
        setText("sellPutRecordStatus", "已保存到本机（最多 50 次），不是实盘成交。");
      } catch {setText("sellPutRecordStatus", "本机存储不可用，未保存试算。");}
    });
    document.addEventListener("visibilitychange", () => {if (!document.hidden && $("sellPutDialog").open) render();});
  }
  return {initialize, open, openCall: button => open(button, "CALL"), close, switchSide, getSide: () => activeSide, parseSettings, createSession, createMarkWatch, issueLabel, isTemporaryDataIssue, createReferenceStore, filterVisible, exportRows, stressMatrix, DEFAULTS, CALL_DEFAULTS};
});
