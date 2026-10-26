"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OptionRiskUI = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const numeric = (value) => typeof value === "number" ? Number.isFinite(value) ? value : null : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const stamp = (value) => typeof value === "number" ? Number.isFinite(value) && value > 0 ? value : null : value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const expiryMs = (row) => numeric(row.expiry_ms) ?? stamp(row.expiry_beijing);
  const dateFormatter = new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"});
  const timeFormatter = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
  const rowTimeFormatter = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
  const expiryDate = (row) => Number.isFinite(expiryMs(row)) ? dateFormatter.format(new Date(expiryMs(row))) : "时间无效";
  const fmt = new Intl.NumberFormat("en-US", {maximumFractionDigits: 4});
  const greekFmt = new Intl.NumberFormat("en-US", {maximumFractionDigits: 10});
  const dailyFmt = new Intl.NumberFormat("en-US", {maximumFractionDigits: 8});
  const format = (value) => Number.isFinite(value) ? fmt.format(Math.abs(value) < 1e-10 ? 0 : value) : value === Infinity ? "∞" : "—";
  const dailyFormat = (value) => !Number.isFinite(value) ? "—" : value !== 0 && Math.abs(value) < 1e-8 ? value.toExponential(3) : dailyFmt.format(value);
  const dailyAmountFormat = (value) => Number.isFinite(value) && Math.abs(value) >= .0001 ? format(value) : dailyFormat(value);
  const greekFormat = (value) => {
    const number = numeric(value);
    if (number === null) return "—";
    if (number !== 0 && Math.abs(number) < .00000001) return number.toExponential(5);
    return greekFmt.format(number);
  };
  const percentage = (value) => Number.isFinite(value) ? `${format(value * 100)}%` : "—";
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));
  const quoteField = (settings) => settings.direction === "SELL" ? "bid_price" : "ask_price";
  const receipt = (row, field) => row?.field_updated_at && Object.hasOwn(row.field_updated_at, field) ? row.field_updated_at[field] : row?.quote_updated_at;
  const freshIssue = (value, source, now, label) => {
    const received = stamp(value), limit = source === "websocket" ? 20000 : 30000;
    if (received === null) return `${label}时间未知`;
    if (received > now + 2000) return `${label}时间异常`;
    return now - received > limit ? `${label}已陈旧` : null;
  };
  function verifiedBook(row, now = Date.now()) {
    const proof = row?.quote_verification, verified = row?.quote_verified_at;
    if (!proof || proof.verified !== true || proof.kind !== "bookTicker" || !/^book-\d+$/.test(proof.connection ?? "") || !Number.isInteger(proof.generation) || proof.generation <= 0) return false;
    if (!Number.isFinite(verified) || verified <= 0 || proof.verified_at !== verified || verified > now + 2000 || now - verified > 20000) return false;
    if (!Number.isFinite(proof.baseline_at) || proof.baseline_at <= 0 || proof.baseline_at > now + 2000 || !proof.values || Array.isArray(proof.values)) return false;
    return ["bid_price", "ask_price", "bid_quantity", "ask_quantity"].every((field) => {
      const expected = numeric(proof.values[field]), actual = numeric(row[field]);
      return expected !== null && actual !== null && expected >= 0 && expected === actual;
    });
  }
  function quoteFieldIssue(row, field, now, label) {
    const issue = freshIssue(receipt(row, field), row.field_source?.[field] ?? row.quote_source, now, label);
    return issue?.endsWith("已陈旧") && verifiedBook(row, now) ? null : issue;
  }
  function quoteIssue(snapshot, row, settings, now = Date.now()) {
    const expiry = expiryMs(row), clock = now + (numeric(snapshot?.exchange_clock_offset_ms) ?? 0);
    if (!Number.isFinite(expiry)) return "到期时间无效";
    if (expiry <= clock) return "合约已到期";
    if (row.status !== "TRADING") return row.status ? "合约当前非可交易状态" : "合约可交易状态未知";
    if (!row.symbol?.startsWith("BTC-") || numeric(row.unit) !== 1 || row.quote_asset && row.quote_asset !== "USDT") return "仅支持 BTC / USDT、乘数 1 的合约";
    const quantity = numeric(settings.quantity), min = numeric(row.min_qty), max = numeric(row.max_qty);
    if (!(quantity > 0) || min !== null && quantity < min - 1e-10 || max !== null && quantity > max + 1e-10) return "数量不在合约范围内";
    const scale = numeric(row.quantity_scale);
    if (scale !== null && scale >= 0 && scale <= 12 && Math.abs(quantity * 10 ** scale - Math.round(quantity * 10 ** scale)) > 1e-7) return "数量不符合合约精度";
    const field = quoteField(settings), sizeField = settings.direction === "SELL" ? "bid_quantity" : "ask_quantity";
    if (!(numeric(row[field]) > 0)) return settings.direction === "SELL" ? "无有效买一报价" : "无有效卖一报价";
    const bid = numeric(row.bid_price), ask = numeric(row.ask_price);
    if (bid > 0 && ask > 0 && bid > ask) return "买卖报价交叉，待核验";
    if (row.quote_group_valid === false) return "盘口快照待核验";
    const priceIssue = quoteFieldIssue(row, field, now, "报价");
    if (priceIssue) return priceIssue;
    const sizeIssue = quoteFieldIssue(row, sizeField, now, "深度");
    if (sizeIssue) return sizeIssue;
    const size = numeric(row[sizeField]);
    if (size === null) return "报价深度未知";
    if (size < quantity - 1e-10) return "买卖一深度不足";
    if (!(numeric(snapshot?.btc_index_price) > 0)) return "BTC 指数缺失";
    return freshIssue(snapshot.index_updated_at, snapshot.index_source, now, "指数");
  }
  function evaluateRows(snapshot, settings, now = Date.now(), analyzer, valuationNow = now) {
    const invalid = settingsError(settings);
    if (invalid || !["BUY", "SELL"].includes(settings.direction) || !["CALL", "PUT", "ALL"].includes(settings.type)) throw new RangeError(invalid ?? "模拟方向或期权类型无效");
    const clock = valuationNow + (numeric(snapshot?.exchange_clock_offset_ms) ?? 0);
    const results = (snapshot?.options ?? []).filter((row) => (settings.type === "ALL" || row.side === settings.type) && (settings.expiry === "ALL" || expiryDate(row) === settings.expiry)).map((row) => {
      const source = row.field_source?.[quoteField(settings)] ?? row.quote_source;
      const result = {row, expiry: expiryDate(row), valuationAt: clock, issue: quoteIssue(snapshot, row, settings, now), metrics: null, overBudget: false, quoteLabel: settings.direction === "SELL" ? "买一" : "卖一", sourceLabel: source === "websocket" ? "WebSocket 快照" : "REST 缓存参考"};
      if (!result.issue) {
        try {
          result.metrics = analyzer({type: row.side, direction: settings.direction, strike: numeric(row.strike_price), premium: numeric(row[quoteField(settings)]), quantity: numeric(settings.quantity), unit: numeric(row.unit), spot: numeric(snapshot.btc_index_price), years: (expiryMs(row) - clock) / (365 * 86400000), annualVol: settings.annualVol, annualDrift: settings.annualDrift, additionalFees: 0});
          result.overBudget = result.metrics.lossUnbounded || result.metrics.maxLoss > settings.budget;
        } catch (error) {result.issue = "参数超出计算范围";}
      }
      return result;
    });
    return sortRows(results, settings);
  }
  function sortRows(results, settings) {
    const sorters = {strike: (entry) => numeric(entry.row.strike_price), expected: (entry) => entry.metrics?.model?.expectedPnl, lossProbability: (entry) => entry.metrics?.model?.lossProbability, tail: (entry) => entry.metrics?.model?.es99, rewardRisk: (entry) => entry.metrics?.rewardRiskRatio, dailyReturn: (entry) => entry.metrics?.averageDailyReturnPct, maxLoss: (entry) => entry.metrics?.lossUnbounded ? Infinity : entry.metrics?.maxLoss};
    const selected = sorters[settings.sort] ?? sorters.strike, descending = ["expected", "rewardRisk", "dailyReturn"].includes(settings.sort);
    return results.sort((a, b) => {
      const av = selected(a), bv = selected(b), am = av === null || av === undefined || Number.isNaN(av), bm = bv === null || bv === undefined || Number.isNaN(bv);
      if (am !== bm) return am ? 1 : -1;
      if (!am && av !== bv) return (av < bv ? -1 : 1) * (descending ? -1 : 1);
      return (numeric(a.row.strike_price) ?? 0) - (numeric(b.row.strike_price) ?? 0) || a.expiry.localeCompare(b.expiry) || String(a.row.symbol).localeCompare(String(b.row.symbol));
    });
  }
  function csvCell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function exportRows(entries, settings, snapshot) {
    const header = ["合约", "到期日", "类型", "模拟方向", "数量_张", "行权价_USDT", "参考报价_USDT", "买一_USDT", "卖一_USDT", "IV", "Delta", "Gamma", "Vega", "Theta", "开仓费_USDT", "最大净盈利_USDT", "最大净亏损_USDT", "最大盈利除最大亏损", "盈亏平衡价_USDT", "现金覆盖收益率_百分比", "模型期望净盈亏_USDT", "模型亏损概率", "模型最差1%平均亏损_USDT", "到期下跌20%净盈亏_USDT", "到期下跌30%净盈亏_USDT", "到期上涨20%净盈亏_USDT", "到期上涨30%净盈亏_USDT", "状态", "共同年化波动率", "连续复利年化价格漂移_mu", "风险预算_USDT", "指数参考_USDT", "报价接收时间", "快照参考时间", "模型估值时间_UTC", "模型剩余年限"];
    const records = entries.map((entry) => {const {row, metrics: m} = entry, reference = entry.snapshot ?? snapshot; const scenario = (move) => m?.scenarios?.find((item) => Math.abs(item.movePct - move) < 1e-8)?.pnl; return [row.symbol, entry.expiry, row.side, settings.direction, settings.quantity, numeric(row.strike_price), numeric(row[quoteField(settings)]), numeric(row.bid_price), numeric(row.ask_price), numeric(row.mark_iv), numeric(row.delta), numeric(row.gamma), numeric(row.vega), numeric(row.theta), m?.entryFee, m?.profitUnbounded ? "无限" : m?.maxProfit, m?.lossUnbounded ? "无限" : m?.maxLoss, m?.rewardRiskRatio, m?.breakEven, m?.cashReturnPct, m?.model?.expectedPnl, m?.model?.lossProbability, m?.model?.es99, scenario(-.2), scenario(-.3), scenario(.2), scenario(.3), entry.issue ?? (entry.historical || entry.currentIssue ? `${entry.currentIssue ?? '行情待更新'}；仅固定历史快照试算，不代表当前报价${entry.overBudget ? '；理论最大亏损超预算' : ''}` : entry.overBudget ? "理论最大亏损超预算；快照参考" : entry.cacheReference ? "缓存参考，成交不保证" : "快照参考，成交不保证"), settings.annualVol, settings.annualDrift, settings.budget, numeric(reference?.btc_index_price), receipt(row, quoteField(settings)), reference?.fetched_at, Number.isFinite(entry.valuationAt) && Math.abs(entry.valuationAt) <= 8640000000000000 ? new Date(entry.valuationAt).toISOString() : null, m?.model?.years];});
    header.push("剩余天数", "最高平均日收益_USDT", "最高平均日收益率_百分比", "日收益率资金口径");
    records.forEach((record, index) => {
      const metrics = entries[index].metrics;
      record.push(metrics?.remainingDays, metrics?.averageDailyMaxProfit, metrics?.averageDailyReturnPct, metrics?.dailyReturnBasis);
    });
    return "\uFEFF" + [header, ...records].map((record) => record.map(csvCell).join(",")).join("\r\n");
  }
  let initialized = false, hooks, frozen = null, frozenAt = 0, currentRows = [], visibleRows = [], trigger = null, timer = null, staleKey = "";
  let mode = "live", observed = null, expiryKey = null, catalogSnapshot = null;
  let snapshotTimer = null, lastSource, lastVersion = null;
  const SNAPSHOT_DELAY = 250;
  const lastGood = new Map();
  let renderedRows = new Map();
  const $ = (id) => document.getElementById(id);
  function snapshotVersion(snapshot) {
    if (!Number.isFinite(numeric(snapshot?.revision))) return null;
    return JSON.stringify([snapshot.instance_id ?? null, numeric(snapshot.revision), Boolean(snapshot.stale), snapshot.error?.message ?? null, snapshot.realtime?.connected ?? null, snapshot.realtime?.last_error ?? null]);
  }
  function sameSnapshot(snapshot) {
    const version = snapshotVersion(snapshot);
    return version !== null && lastVersion !== null ? version === lastVersion : snapshot === lastSource;
  }
  function cancelSnapshotUpdate() {
    if (snapshotTimer !== null) clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  function onSnapshot(snapshot) {
    if (!initialized || !$("riskDialog").open || mode !== "live") return;
    if (arguments.length && sameSnapshot(snapshot)) return;
    if (document.hidden || snapshotTimer !== null) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      if (!$("riskDialog").open || mode !== "live") return;
      if (document.hidden) return;
      refresh(true, true);
    }, SNAPSHOT_DELAY);
  }
  const matches = (row, config) => (config.type === "ALL" || row.side === config.type) && (config.expiry === "ALL" || expiryDate(row) === config.expiry);
  const usable = (snapshot, config, at) => snapshot?.options?.some((row) => matches(row, config) && !quoteIssue(snapshot, row, config, at));
  function awaitingData(snapshot, config, at) {
    if (!snapshot?.options?.length) return true;
    const rows = snapshot.options.filter((row) => matches(row, config));
    return rows.some((row) => canRetain(snapshot, row, config, at, quoteIssue(snapshot, row, config, at)));
  }
  // Keep a complete analysis point per contract and direction. A missing REST
  // field or an unrelated empty book must not erase another contract's result.
  // A positively observed market change still invalidates that contract.
  function canRetain(snapshot, row, config, at, issue) {
    if (!row) return true;
    if (issue === "合约已到期" || row.status && row.status !== "TRADING" || numeric(row.unit) !== null && numeric(row.unit) !== 1 || row.quote_asset && row.quote_asset !== "USDT" || /数量不/.test(issue ?? "")) return false;
    const field = quoteField(config), sizeField = config.direction === "SELL" ? "bid_quantity" : "ask_quantity";
    const fresh = (key) => !quoteFieldIssue(row, key, at, "字段");
    if (fresh(field) && numeric(row[field]) !== null && numeric(row[field]) <= 0) return false;
    if (fresh(sizeField) && numeric(row[sizeField]) !== null && numeric(row[sizeField]) < config.quantity - 1e-10) return false;
    if (numeric(row.bid_price) > numeric(row.ask_price) && numeric(row.ask_price) > 0 && fresh("bid_price") && fresh("ask_price")) return false;
    return /陈旧|时间未知|时间异常|指数缺失|深度未知|盘口快照待核验|无有效.*报价|报价交叉|行情待更新|状态未知|到期时间无效/.test(issue ?? "") || issue?.startsWith("仅支持") && numeric(row.unit) === null;
  }
  function analysisPoint(snapshot, row, at) {
    return {at, snapshot: {btc_index_price: snapshot.btc_index_price, index_updated_at: snapshot.index_updated_at, index_source: snapshot.index_source, exchange_clock_offset_ms: snapshot.exchange_clock_offset_ms, fetched_at: snapshot.fetched_at, options: [row]}};
  }
  function invalidateObserved(snapshot, at) {
    const rows = new Map((snapshot?.options ?? []).map((row) => [row.symbol, row]));
    const quantity = numeric($("riskQuantity").value);
    for (const [key, point] of lastGood) {
      const saved = point.snapshot.options[0], row = rows.get(saved.symbol);
      const clock = at + (numeric(snapshot?.exchange_clock_offset_ms) ?? numeric(point.snapshot.exchange_clock_offset_ms) ?? 0);
      if (expiryMs(saved) <= clock) {lastGood.delete(key); continue;}
      if (!row) continue;
      if (row.status && row.status !== "TRADING" || numeric(row.unit) !== null && numeric(row.unit) !== 1 || row.quote_asset && row.quote_asset !== "USDT" || Number.isFinite(expiryMs(row)) && expiryMs(row) <= clock) {lastGood.delete(key); continue;}
      const field = key.endsWith(":SELL") ? "bid_price" : "ask_price", sizeField = key.endsWith(":SELL") ? "bid_quantity" : "ask_quantity";
      const fresh = (name) => !quoteFieldIssue(row, name, at, "字段");
      // Invalidate hidden scopes too. Keep later depth observations even if
      // the index is missing, so a larger future quantity cannot use old depth.
      if (fresh(sizeField) && numeric(row[sizeField]) !== null) point.depthLimit = numeric(row[sizeField]);
      if (fresh(field) && numeric(row[field]) !== null && numeric(row[field]) <= 0 || fresh(sizeField) && point.depthLimit !== undefined && quantity > 0 && point.depthLimit < quantity - 1e-10) lastGood.delete(key);
    }
  }
  function stableRows(config) {
    const result = evaluateRows(frozen, config, frozenAt, window.OptionRisk.analyze), present = new Set(result.map((entry) => entry.row.symbol));
    const latestRows = new Map((frozen?.options ?? []).map((row) => [row.symbol, row]));
    const now = Date.now(), clock = now + (numeric(frozen?.exchange_clock_offset_ms) ?? 0);
    for (const [key, point] of lastGood) {
      const row = point.snapshot.options[0];
      if (mode === "live" && expiryMs(row) <= now + (numeric(point.snapshot.exchange_clock_offset_ms) ?? 0)) {lastGood.delete(key); continue;}
      if (key !== `${row.symbol}:${config.direction}` || !matches(row, config) || present.has(row.symbol)) continue;
      result.push({row, expiry: expiryDate(row), issue: "行情待更新", metrics: null, quoteLabel: config.direction === "SELL" ? "买一" : "卖一"});
    }
    const resolved = result.map((entry) => {
      const key = `${entry.row.symbol}:${config.direction}`;
      if (mode === "live" && Number.isFinite(expiryMs(entry.row)) && expiryMs(entry.row) <= clock) {lastGood.delete(key); return entry;}
      if (entry.metrics) {
        const point = analysisPoint(frozen, entry.row, frozenAt);
        point.depthLimit = numeric(entry.row[config.direction === "SELL" ? "bid_quantity" : "ask_quantity"]);
        lastGood.set(key, point);
        return {...entry, snapshot: point.snapshot, analysisAt: point.at, historical: false};
      }
      const latestRow = latestRows.get(entry.row.symbol);
      if (!canRetain(frozen, latestRow, config, frozenAt, entry.issue)) {lastGood.delete(key); return entry;}
      const point = lastGood.get(key);
      if (!point) return entry;
      if (point.depthLimit !== null && point.depthLimit !== undefined && point.depthLimit < config.quantity - 1e-10) return {...entry, issue: "买卖一深度不足"};
      const saved = evaluateRows(point.snapshot, config, point.at, window.OptionRisk.analyze)[0];
      if (saved?.metrics) return {...saved, snapshot: point.snapshot, analysisAt: point.at, historical: true, currentIssue: entry.issue};
      return saved?.issue ? {...entry, issue: saved.issue} : entry;
    });
    return sortRows(resolved, config);
  }
  function shortIssue(issue) {
    if (/无有效买一/.test(issue ?? "")) return "暂无买盘";
    if (/无有效卖一/.test(issue ?? "")) return "暂无卖盘";
    if (/已到期/.test(issue ?? "")) return "已到期";
    if (/深度不足/.test(issue ?? "")) return "深度不足";
    if (/深度已陈旧|深度未知/.test(issue ?? "")) return "深度待更新";
    if (/当前非可交易/.test(issue ?? "")) return "暂停交易";
    if (/陈旧|时间未知/.test(issue ?? "")) return "报价待更新";
    return issue;
  }
  function settings() {
    return {expiry: $("riskExpiry").value, direction: $("riskDirection").value, type: $("riskType").value, quantity: numeric($("riskQuantity").value), annualVol: numeric($("riskVol").value) === null ? null : numeric($("riskVol").value) / 100, annualDrift: numeric($("riskDrift").value) === null ? null : numeric($("riskDrift").value) / 100, budget: numeric($("riskBudget").value), sort: $("riskSort").value};
  }
  function settingsError(config) {
    if (!Number.isFinite(config.quantity) || !(config.quantity > 0)) return "模拟数量需要大于零。";
    if (!Number.isFinite(config.annualVol) || config.annualVol < 0 || config.annualVol > 5) return "共同年化波动率需在 0% 至 500% 之间。";
    if (!Number.isFinite(config.annualDrift) || config.annualDrift < -5 || config.annualDrift > 5) return "年化价格漂移需在 −500% 至 500% 之间。";
    if (!Number.isFinite(config.budget) || config.budget < 0) return "风险预算需为非负数。";
    return null;
  }
  function caption() {
    const age = Math.max(0, Math.floor((Date.now() - frozenAt) / 1000));
    const historical = currentRows.filter((entry) => entry.metrics && entry.historical).length;
    const latest = currentRows.filter((entry) => entry.metrics && !entry.historical).length;
    $("riskSnapshot").textContent = historical ? `${latest} 个最新 · ${historical} 个历史快照` : frozen ? `快照 ${timeFormatter.format(new Date(frozenAt))}（北京） · BTC ${format(numeric(frozen.btc_index_price))} USDT · ${age} 秒前` : "等待行情";
    const config = settings(), now = Date.now(), clock = now + (numeric(frozen?.exchange_clock_offset_ms) ?? 0);
    const rows = (frozen?.options ?? []).filter((row) => matches(row, config));
    const cached = currentRows.some((entry) => entry.metrics && !entry.historical && Object.hasOwn(entry.row, "quote_verification") && !verifiedBook(entry.row, now));
    $("riskMode").textContent = mode === "paused" ? "已暂停" : historical ? latest ? "部分待更新" : "等待更新" : settingsError(config) ? "自动更新" : cached ? "缓存计算" : usable(frozen, config, now) ? "实时" : awaitingData(frozen, config, now) ? "等待行情" : rows.length && rows.every((row) => expiryMs(row) <= clock) ? "已到期" : "暂无报价";
    $("riskLive").textContent = mode === "paused" ? "恢复实时" : "暂停更新";
    $("riskLive").setAttribute("aria-pressed", String(mode === "paused"));
  }
  function render() {
    if (!$("riskDialog").open) return;
    const config = settings();
    let error = settingsError(config);
    currentRows = error ? [] : stableRows(config);
    if (!error && !frozen?.options?.length && !currentRows.length) error = "等待行情，请稍后刷新。";
    caption();
    $("riskError").hidden = !error; $("riskError").textContent = error ?? "";
    $("riskExport").disabled = !currentRows.length;
    $("riskModelCaption").hidden = config.sort !== "expected";
    $("riskModelCaption").textContent = config.sort === "expected" ? "按模型期望排序（非预测）。" : "";
    paintRows(config, error);
  }
  function setChangedAttribute(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
  function paintRow(previous, entry, config) {
    const {row, metrics: m} = entry, scenario = (move) => m?.scenarios?.find((item) => Math.abs(item.movePct - move) < 1e-8)?.pnl;
    const ratio = m?.rewardRiskRatio, status = entry.issue ? shortIssue(entry.issue) : entry.currentIssue === "合约已到期" ? "已到期 · 历史快照" : entry.historical ? `历史快照${entry.overBudget ? ' · 超预算' : ''}` : entry.overBudget ? "最大亏损超预算" : mode === "paused" ? "已固定" : entry.currentIssue ? shortIssue(entry.currentIssue) : entry.cacheReference ? "缓存参考" : "有效";
    const maxProfit = m?.profitUnbounded ? "无限" : format(m?.maxProfit), maxLoss = m?.lossUnbounded ? "无限" : format(m?.maxLoss);
    const signed = (value) => ({html: `${value > 0 ? "+" : ""}${format(value)}`, className: value > 0 ? "risk-positive" : value < 0 ? "risk-negative" : ""});
    const cells = [
      {html: `<strong>${esc(row.symbol)}</strong><span>${esc(entry.expiry)} · ${row.side === "CALL" ? "Call" : "Put"} · K ${format(numeric(row.strike_price))}</span>`},
      {html: `${format(numeric(row.bid_price))} / ${format(numeric(row.ask_price))}<small>${entry.quoteLabel}深度 ${format(numeric(row[config.direction === "SELL" ? "bid_quantity" : "ask_quantity"]))}</small>${entry.historical ? `<small>历史 ${esc(rowTimeFormatter.format(new Date(entry.analysisAt)))} · BTC ${format(numeric(entry.snapshot.btc_index_price))}</small>` : ""}`},
      {html: `${percentage(numeric(row.mark_iv))}<small>Δ ${greekFormat(row.delta)}</small>`},
      {html: `${greekFormat(row.gamma)}<small>ν ${greekFormat(row.vega)} · θ ${greekFormat(row.theta)}</small>`},
      {html: format(m?.entryFee)}, {html: maxProfit}, {html: maxLoss, className: entry.overBudget ? "risk-negative" : ""},
      {html: `${m?.profitUnbounded || m?.lossUnbounded ? "不适用" : percentage(ratio)}${Number.isFinite(ratio) && ratio > 0 ? `<small>1 : ${format(1 / ratio)}</small>` : ""}`, label: m?.profitUnbounded ? "盈利无上限，盈亏比不适用" : m?.lossUnbounded ? "亏损无上限，盈亏比不适用" : "最大盈亏比"},
      {html: format(m?.breakEven)}, {html: `${m ? format(m.cashReturnPct) : "—"}${m?.cashReturnPct !== null && m?.cashReturnPct !== undefined ? "%" : ""}`},
      {html: `${dailyAmountFormat(m?.averageDailyMaxProfit)}${m ? `<small>${m.profitUnbounded ? "盈利无上限 · " : ""}剩余 ${dailyAmountFormat(m.remainingDays)} 天</small>` : ""}`},
      {html: `${Number.isFinite(m?.averageDailyReturnPct) ? `${dailyFormat(m.averageDailyReturnPct)}%` : m ? "不适用" : "—"}${m ? `<small>${m.profitUnbounded ? "盈利无上限" : m.dailyReturnBasis === "cash_secured" ? "现金覆盖" : m.dailyReturnBasis === "premium_paid" ? "权利金成本" : "未设资金口径"}</small>` : ""}`},
      signed(m?.model?.expectedPnl), {html: percentage(m?.model?.lossProbability)}, {html: format(m?.model?.es99)},
      signed(scenario(-.2)), signed(scenario(-.3)), signed(scenario(.2)), signed(scenario(.3)),
      {html: esc(status), className: `risk-status ${entry.issue || entry.currentIssue || entry.overBudget || entry.historical ? "risk-warning" : ""}`}
    ];
    const record = previous ?? {node: document.createElement("tr"), cells: [], html: []};
    setChangedAttribute(record.node, "data-risk-symbol", String(row.symbol ?? ""));
    setChangedAttribute(record.node, "data-risk-valid", String(Boolean(m)));
    setChangedAttribute(record.node, "data-risk-current", String(Boolean(m) && !entry.currentIssue && !entry.historical));
    cells.forEach((description, index) => {
      let cell = record.cells[index];
      if (!cell) {
        cell = document.createElement(index === 0 ? "th" : "td");
        if (index === 0) cell.setAttribute("scope", "row");
        record.cells[index] = cell;
        record.node.appendChild(cell);
      }
      if (record.html[index] !== description.html) {cell.innerHTML = description.html; record.html[index] = description.html;}
      if (description.className !== undefined) setChangedAttribute(cell, "class", description.className);
      if (description.label !== undefined) setChangedAttribute(cell, "aria-label", description.label);
    });
    return record;
  }
  function paintRows(config, error = null) {
    const now = Date.now(), clock = now + (numeric(frozen?.exchange_clock_offset_ms) ?? 0);
    const observedRows = new Map((observed?.options ?? []).map((row) => [row.symbol, row]));
    currentRows.forEach((entry) => {
      const currentRow = observedRows.get(entry.row.symbol);
      entry.currentIssue = expiryMs(entry.row) <= clock ? "合约已到期" : entry.historical ? currentRow ? quoteIssue(observed, currentRow, config, now) : "行情待更新" : quoteIssue(entry.snapshot ?? frozen, entry.row, config, now);
      entry.viewMode = mode === "paused" ? "paused" : entry.historical ? "historical" : "live";
      entry.cacheReference = Object.hasOwn(entry.row, "quote_verification") && !verifiedBook(entry.row, now);
    });
    staleKey = currentRows.map((entry) => entry.currentIssue ?? "").join("|");
    const calculated = currentRows.filter((entry) => entry.metrics).length;
    const expired = currentRows.some((entry) => entry.metrics && entry.currentIssue === "合约已到期");
    visibleRows = $("riskHideUnavailable").checked ? currentRows.filter((entry) => entry.metrics) : currentRows;
    $("riskCount").textContent = `${visibleRows.length} / ${currentRows.length} 个合约${!$("riskHideUnavailable").checked && calculated < currentRows.length ? ` · ${currentRows.length - calculated} 不可算` : ""}`;
    const historical = currentRows.filter((entry) => entry.metrics && entry.historical).length;
    const warning = expired ? "所选合约已到期，保留固定试算。" : historical ? `${historical} 个合约行情待更新，保留上次结果。` : "";
    $("riskFreshness").hidden = !warning;
    $("riskFreshness").textContent = warning;
    $("riskExport").disabled = Boolean(error) || !visibleRows.length;
    const scroller = $("riskTableScroll"), scrollTop = scroller?.scrollTop, scrollLeft = scroller?.scrollLeft;
    const tbody = $("riskRows"), nextRows = new Map(), ordered = [], retained = new Set();
    visibleRows.forEach((entry) => {
      const symbol = entry.row.symbol, siblings = nextRows.get(symbol) ?? [];
      // Symbols are unique in the market catalog. Keep duplicate input rows
      // separate as well, so malformed input cannot collapse visible records.
      const record = paintRow(renderedRows.get(symbol)?.[siblings.length], entry, config);
      siblings.push(record); nextRows.set(symbol, siblings); ordered.push(record.node); retained.add(record);
    });
    for (const siblings of renderedRows.values()) for (const record of siblings) if (!retained.has(record)) record.node.remove();
    let cursor = tbody.firstChild;
    for (const row of ordered) {
      if (row === cursor) cursor = cursor.nextSibling;
      else tbody.insertBefore(row, cursor);
    }
    renderedRows = nextRows;
    if (scroller?.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
    if (scroller?.scrollLeft !== scrollLeft) scroller.scrollLeft = scrollLeft;
    $("riskEmpty").hidden = Boolean(visibleRows.length) || Boolean(error);
    const issues = [...new Set(currentRows.map((entry) => shortIssue(entry.issue)).filter(Boolean))];
    $("riskEmpty").textContent = !currentRows.length ? "暂无合约。" : issues.length === 1 ? `${issues[0]}。取消“仅显示可算”查看合约。` : "暂无可算合约。取消“仅显示可算”查看原因。";
  }
  function refresh(preserveExpiry = true, skipUnchanged = false) {
    const source = hooks.getSnapshot();
    cancelSnapshotUpdate();
    if (skipUnchanged && sameSnapshot(source)) return;
    lastSource = source; lastVersion = snapshotVersion(source);
    const candidate = source ? JSON.parse(JSON.stringify(source)) : null, now = Date.now();
    observed = candidate;
    invalidateObserved(candidate, now);
    const before = preserveExpiry ? $("riskExpiry").value : hooks.getExpiry() || "ALL";
    if (candidate?.options?.length) catalogSnapshot = candidate;
    const catalog = catalogSnapshot;
    const clock = now + (numeric(catalog?.exchange_clock_offset_ms) ?? 0);
    const catalogRows = [...(catalog?.options ?? []), ...[...lastGood.values()].map((point) => point.snapshot.options[0])];
    const dates = [...new Set(catalogRows.filter((row) => expiryMs(row) > clock).map(expiryDate).filter((date) => date !== "时间无效"))].sort();
    const key = dates.join("|");
    if (key !== expiryKey) {
      $("riskExpiry").innerHTML = '<option value="ALL">全部到期日</option>' + dates.map((date) => `<option value="${esc(date)}">${esc(date)}</option>`).join("");
      expiryKey = key;
    }
    $("riskExpiry").value = before === "ALL" || dates.includes(before) ? before : dates[0] ?? "ALL";
    frozen = candidate; frozenAt = now;
    render();
  }
  function settingsChanged() {
    if (mode === "live") refresh(true);
    else render();
  }
  function open(button) {
    if (!initialized) return;
    trigger = button ?? document.activeElement;
    if (!$("riskDialog").open) $("riskDialog").showModal();
    cancelSnapshotUpdate(); lastSource = undefined; lastVersion = null;
    mode = "live"; frozen = null; expiryKey = null; catalogSnapshot = null; lastGood.clear();
    refresh(false);
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => {
      if (!$("riskDialog").open || document.hidden) return;
      if (mode === "live") {if (snapshotTimer === null) refresh(true); return;}
      caption();
      const config = settings(), next = currentRows.map((entry) => quoteIssue(frozen, entry.row, config, Date.now()) ?? "").join("|");
      if (next !== staleKey && !settingsError(config)) paintRows(config);
    }, 2000);
  }
  function initialize(options) {
    if (initialized || !$("riskDialog")) return;
    initialized = true; hooks = options;
    ["riskButton", "focusRiskButton"].forEach((id) => $(id)?.addEventListener("click", () => open($(id))));
    $("riskClose").addEventListener("click", () => $("riskDialog").close());
    $("riskDialog").addEventListener("close", () => {if (timer !== null) clearInterval(timer); timer = null; cancelSnapshotUpdate(); trigger?.focus?.({preventScroll: true});});
    $("riskRefresh").addEventListener("click", () => refresh(true));
    $("riskLive").addEventListener("click", () => {
      cancelSnapshotUpdate();
      mode = mode === "live" ? "paused" : "live";
      if (mode === "live") refresh(true);
      else {caption(); paintRows(settings(), settingsError(settings()));}
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (snapshotTimer !== null) clearTimeout(snapshotTimer);
        snapshotTimer = null;
        return;
      }
      if ($("riskDialog").open && mode === "live") refresh(true);
    });
    $("riskHideUnavailable").addEventListener("change", () => paintRows(settings(), settingsError(settings())));
    ["riskExpiry", "riskDirection", "riskType", "riskSort"].forEach((id) => $(id).addEventListener("change", settingsChanged));
    ["riskQuantity", "riskVol", "riskDrift", "riskBudget"].forEach((id) => $(id).addEventListener("input", settingsChanged));
    $("riskExport").addEventListener("click", () => {
      if (settingsError(settings())) return;
      paintRows(settings());
      if (!visibleRows.length) return;
      const url = URL.createObjectURL(new Blob([exportRows(visibleRows, settings(), frozen)], {type: "text/csv;charset=utf-8"})), link = document.createElement("a");
      link.href = url; link.download = `BTC-期权收益风险-${new Date(frozenAt).toISOString().replace(/[:.]/g, "-")}.csv`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  return {initialize, open, onSnapshot, isVerifiedBook: verifiedBook, evaluateRows, quoteIssue, exportRows};
});
