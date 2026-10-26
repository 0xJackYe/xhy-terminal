"use strict";

// This preview only reads the board's public snapshot. It never sends an order.
window.OptionPayoffPreview = (() => {
  const element = (id) => document.getElementById(id);
  const dialog = element("payoffDialog");
  const nf = new Intl.NumberFormat("en-US", {maximumFractionDigits: 8});
  const money = (value) => Number.isFinite(value) ? nf.format(Math.abs(value) < 1e-10 ? 0 : value) : "—";
  const dailyMoney = (value) => Number.isFinite(value) && value > 0 && value < 1e-8 ? value.toExponential(3) : Number.isFinite(value) ? nf.format(value) : "—";
  const daysFormat = new Intl.NumberFormat("en-US", {maximumFractionDigits: 4});
  const signed = (value) => `${value > 1e-10 ? "+" : ""}${money(value)}`;
  const numeric = (value) => value === null || value === undefined || String(value).trim() === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const time = (value) => {
    const ms = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(ms) ? new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false}).format(new Date(ms)) : "时间未知";
  };
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  let context = null;
  let direction = "BUY";
  let latestMetrics = null;
  let expiryTimer = null;

  function freezeMarket(market) {
    return {row: JSON.parse(JSON.stringify(market.row)), index: market.snapshot.btc_index_price, stale: Boolean(market.snapshot.stale), receivedAt: market.snapshot.fetched_at, clockOffset: numeric(market.snapshot.exchange_clock_offset_ms) ?? 0};
  }

  function contractError(market = context?.market) {
    const row = market?.row;
    const expiry = numeric(row?.expiry_ms) ?? Date.parse(row?.expiry_beijing);
    if (!Number.isFinite(expiry)) return "该合约的到期时间无效，请重新选择合约。";
    if (expiry <= Date.now() + (market.clockOffset ?? 0)) return "该合约已到期，请重新选择未到期合约。";
    return null;
  }

  function stopExpiryTimer() {if (expiryTimer !== null) clearInterval(expiryTimer); expiryTimer = null;}
  function startExpiryTimer() {
    stopExpiryTimer();
    expiryTimer = setInterval(() => {
      if (!dialog.open || !context) return;
      const error = contractError();
      if (error && !context.contractInvalid) {context.contractInvalid = error; showError(error);}
      else if (!error) renderDailyPremium();
    }, 1000);
  }

  function quoteField() {return direction === "BUY" ? "ask_price" : "bid_price";}
  function quoteName() {return direction === "BUY" ? "卖一" : "买一";}
  function updateQuoteCaption(custom = false) {
    const row = context.market.row, field = quoteField();
    const premium = numeric(row[field]);
    element("payoffQuoteNote").textContent = custom ? `自定义 · 原${quoteName()} ${money(premium)}` : quoteName();
    const source = row.field_source?.[field] ?? row.quote_source ?? "rest";
    const received = row.field_updated_at?.[field] ?? row.quote_updated_at ?? context.market.receivedAt;
    const eventTime = row.field_event_ms && Object.hasOwn(row.field_event_ms, field) ? row.field_event_ms[field] : row.quote_event_ms;
    element("payoffQuoteTime").textContent = `报价 ${time(source === "websocket" ? eventTime ?? received : received)}（北京）${context.market.stale ? " · 缓存" : ""}`;
  }

  function applyDirection(next) {
    direction = next;
    const row = context.market.row;
    const type = row.side === "CALL" ? "Call" : "Put";
    element("payoffHeading").textContent = `${direction === "BUY" ? "买入" : "卖出"} ${type}`;
    dialog.dataset.direction = direction;
    dialog.dataset.symbol = row.symbol;
    element("payoffPremiumLabel").textContent = direction === "BUY" ? "支付权利金" : "收取权利金";
    element("payoffDirections").querySelectorAll("button").forEach((button) => {const active = button.dataset.direction === direction; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));});
    element("payoffPremium").value = numeric(row[quoteField()]) > 0 ? row[quoteField()] : "";
    element("payoffPremium").dataset.reference = element("payoffPremium").value;
    updateQuoteCaption();
    render();
  }

  function configuration() {
    const row = context.market.row;
    return {type: row.side, direction, strike: row.strike_price, premium: element("payoffPremium").value, quantity: element("payoffQuantity").value, unit: row.unit, fees: element("payoffFees").value};
  }

  function showError(message) {
    latestMetrics = null;
    clearDailyPremium();
    element("payoffError").textContent = message;
    element("payoffError").hidden = false;
    element("payoffResults").hidden = true;
  }

  function clearDailyPremium() {
    element("payoffDailyPremiumCard").hidden = true;
    element("payoffDailyPremium").textContent = "—";
    element("payoffDailyPremiumNote").textContent = "USDT / 日 · 未扣费用";
  }

  function renderDailyPremium() {
    if (!context || !latestMetrics || direction !== "SELL" || element("payoffResults").hidden) {clearDailyPremium(); return;}
    const row = context.market.row, expiry = numeric(row.expiry_ms) ?? Date.parse(row.expiry_beijing);
    const days = (expiry - (Date.now() + context.market.clockOffset)) / 86400000;
    const daily = latestMetrics.premiumTotal / days;
    if (!(days > 0) || !Number.isFinite(days) || !(daily > 0) || !Number.isFinite(daily)) {clearDailyPremium(); return;}
    element("payoffDailyPremiumCard").hidden = false;
    const value = dailyMoney(daily), remaining = days < .0001 ? dailyMoney(days) : daysFormat.format(days);
    const note = `USDT / 日 · 剩余 ${remaining} 天 · 未扣费用`;
    if (element("payoffDailyPremium").textContent !== value) element("payoffDailyPremium").textContent = value;
    if (element("payoffDailyPremiumNote").textContent !== note) element("payoffDailyPremiumNote").textContent = note;
  }

  function render() {
    try {renderUnchecked();}
    catch (error) {
      if (!(error instanceof RangeError)) console.error("期权盈亏预览计算失败", error);
      showError("数值超出可计算或图表范围，请缩小价格、数量或费用后重试。");
    }
  }

  function renderUnchecked() {
    const error = context.contractInvalid ?? context.refreshError ?? contractError();
    if (error) {showError(error); return;}
    const config = configuration(), settlement = numeric(element("payoffSettlement").value);
    if (numeric(config.unit) !== 1 || !context.market.row.symbol.startsWith("BTC-")) {showError("暂仅支持合约乘数为 1 BTC 的币安 BTC 期权。"); return;}
    const checked = OptionPayoff.validate(config);
    if (!checked.valid || settlement === null || settlement < 0) {
      const labels = {premium: "权利金单价", quantity: "模拟数量", fees: "总费用", strike: "行权价", unit: "合约乘数"};
      const missingQuote = numeric(element("payoffPremium").value) === null && element("payoffPremium").dataset.reference === "";
      const invalid = checked.errors[0];
      showError(missingQuote ? `当前${quoteName()}没有有效正报价。可填写正数权利金进行自定义模拟，或使用最新报价重试。` : invalid ? `${labels[invalid.field] ?? invalid.field}需为${invalid.field === "fees" ? "非负" : "有效正"}数。` : "到期 BTC 结算价需为非负数。");
      return;
    }
    element("payoffError").hidden = true;
    element("payoffResults").hidden = false;
    const model = checked.config;
    const metrics = OptionPayoff.metrics(model), result = OptionPayoff.pnl(model, settlement);
    latestMetrics = metrics;
    element("payoffPremiumTotal").textContent = money(metrics.premiumTotal);
    renderDailyPremium();
    const flat = metrics.breakEvenRange && metrics.breakEvenRange[0] !== metrics.breakEvenRange[1];
    element("payoffBreakEven").textContent = flat ? `${money(metrics.breakEvenRange[0])} – ${metrics.breakEvenRange[1] === Infinity ? "∞" : money(metrics.breakEvenRange[1])}` : metrics.breakEven === null ? "无平衡价" : money(metrics.breakEven);
    element("payoffBreakEvenNote").textContent = flat ? "USDT · 区间内净盈亏为 0" : metrics.breakEven === null ? "非负结算价范围内" : "USDT · 已计所填费用";
    element("payoffMaxProfit").textContent = metrics.maxProfit === Infinity ? "无上限" : money(metrics.maxProfit);
    element("payoffMaxLoss").textContent = metrics.maxLoss === Infinity ? "无上限" : money(metrics.maxLoss);
    element("payoffProfitNote").textContent = "USDT";
    element("payoffLossNote").textContent = "USDT";
    if (metrics.maxProfit === 0) element("payoffProfitNote").textContent = "所填参数下无盈利情景";
    if (metrics.maxLoss === 0) element("payoffLossNote").textContent = "所填参数下无亏损情景";
    element("payoffScenarioPnl").textContent = signed(result);
    element("payoffScenarioPnl").className = result > 0 ? "pnl-positive" : result < 0 ? "pnl-negative" : "";
    element("payoffOutcome").textContent = `${model.fees > 0 ? `已扣费用 ${money(model.fees)} USDT` : "未计手续费"}${metrics.pnlMax < 0 ? " · 所有到期情景均亏损" : metrics.pnlMin > 0 ? " · 所有非负结算价均盈利" : ""}`;
    element("payoffPresets").querySelector('[data-scenario="breakeven"]').disabled = metrics.breakEven === null;
    drawChart(model, metrics, settlement);
  }

  function drawChart(config, metrics, settlement) {
    const index = numeric(context.market.index) ?? config.strike;
    const maxPrice = Math.ceil(Math.max(config.strike * 1.45, index * 1.45, settlement * 1.12, (metrics.breakEven ?? 0) * 1.12) / 1000) * 1000;
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) throw new RangeError("图表价格范围溢出");
    const breaks = [...new Set([0, config.strike, metrics.breakEven, settlement, maxPrice].filter((s) => Number.isFinite(s) && s >= 0 && s <= maxPrice))].sort((a, b) => a - b);
    const profits = breaks.map((s) => OptionPayoff.pnl(config, s));
    const lo = Math.min(0, ...profits), hi = Math.max(0, ...profits), padding = Math.max(1, (hi - lo) * .13);
    const yMin = lo - padding, yMax = hi + padding;
    if (![yMin, yMax, yMax - yMin].every(Number.isFinite) || yMax <= yMin) throw new RangeError("图表盈亏范围溢出");
    const availableWidth = element("payoffChart").clientWidth || (window.innerWidth <= 700 ? window.innerWidth - 80 : 760);
    const width = Math.max(320, Math.min(760, availableWidth));
    const narrow = width < 600;
    const height = narrow ? 210 : 160, left = narrow ? 64 : 78, right = narrow ? 14 : 22, top = 23, bottom = 38;
    const x = (s) => left + s / maxPrice * (width - left - right);
    const y = (p) => top + (yMax - p) / (yMax - yMin) * (height - top - bottom);
    const xy = (s) => `${x(s).toFixed(2)},${y(OptionPayoff.pnl(config, s)).toFixed(2)}`;
    let chart = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(element("payoffHeading").textContent)}到期盈亏曲线，所选结算价 ${money(settlement)} USDT 时净盈亏 ${signed(OptionPayoff.pnl(config, settlement))} USDT"><title>横轴：BTC 到期结算价（USDT）；纵轴：净盈亏（USDT）</title>`;
    for (const tick of [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i && (v === 0 || Math.abs(y(v) - y(0)) >= 16))) {
      chart += `<line class="payoff-grid ${tick === 0 ? "payoff-zero" : ""}" x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}"/><text class="payoff-axis" x="${left - 10}" y="${y(tick) + 4}" text-anchor="end">${escape(money(tick))}</text>`;
    }
    for (let n = 0; n <= 4; n++) {
      const s = maxPrice * n / 4;
      chart += `<text class="payoff-axis" x="${x(s)}" y="${height - 17}" text-anchor="middle">${escape(money(s))}</text>`;
    }
    chart += `<text class="payoff-axis" x="${left}" y="12">净盈亏 · USDT</text><text class="payoff-axis" x="${width - right}" y="${height - 2}" text-anchor="end">BTC 到期结算价 · USDT</text>`;
    for (let n = 1; n < breaks.length; n++) {
      const a = breaks[n - 1], b = breaks[n], positive = OptionPayoff.pnl(config, (a + b) / 2) >= 0, color = positive ? "positive" : "negative";
      chart += `<path class="payoff-area ${color}" d="M ${x(a)},${y(0)} L ${xy(a)} L ${xy(b)} L ${x(b)},${y(0)} Z"/><polyline class="payoff-line ${color}" points="${xy(a)} ${xy(b)}"/>`;
    }
    chart += `<line class="payoff-strike" x1="${x(config.strike)}" x2="${x(config.strike)}" y1="${top}" y2="${height - bottom}"/><text class="payoff-axis" x="${x(config.strike) - 5}" y="${top + 10}" text-anchor="end">行权价</text>`;
    if (metrics.breakEven !== null) chart += `<circle class="payoff-break" cx="${x(metrics.breakEven)}" cy="${y(0)}" r="4"><title>盈亏平衡 ${money(metrics.breakEven)} USDT</title></circle>`;
    chart += `<circle class="payoff-point" cx="${x(settlement)}" cy="${y(OptionPayoff.pnl(config, settlement))}" r="5"><title>结算价 ${money(settlement)}；净盈亏 ${signed(OptionPayoff.pnl(config, settlement))}</title></circle></svg>`;
    element("payoffChart").innerHTML = chart;
    element("payoffSlider").max = maxPrice;
    element("payoffSlider").value = settlement;
    element("payoffSliderMax").textContent = money(maxPrice);
  }

  function open(market, initialDirection, getLatest, trigger) {
    context = {market: freezeMarket(market), getLatest, trigger: {symbol: trigger.dataset.symbol, column: trigger.dataset.column}, refreshError: null, contractInvalid: null};
    const row = context.market.row;
    element("payoffContract").textContent = `${row.symbol} · ${time(row.expiry_ms ?? row.expiry_beijing)} 到期（北京）`;
    element("payoffStrike").textContent = `${money(numeric(row.strike_price))} USDT`;
    element("payoffIndex").textContent = `${money(numeric(context.market.index))} USDT`;
    element("payoffQuantity").value = numeric(row.min_qty) > 0 ? row.min_qty : "0.01";
    element("payoffUnitNote").textContent = `1 张 = ${money(numeric(row.unit))} BTC`;
    element("payoffSettlement").value = context.market.index ?? row.strike_price;
    element("payoffFees").value = "0";
    applyDirection(initialDirection);
    if (!dialog.open) dialog.showModal();
    startExpiryTimer();
    render();
    element("closePayoff").focus({preventScroll: true});
  }

  element("closePayoff").addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", (event) => {if (event.key === "Escape") event.stopPropagation();});
  dialog.addEventListener("close", () => {
    stopExpiryTimer();
    const trigger = context?.trigger;
    const cell = trigger ? [...document.querySelectorAll("#chainBody td[data-symbol]")].find((item) => item.dataset.symbol === trigger.symbol && item.dataset.column === trigger.column) : null;
    (cell ?? element("focusButton")).focus({preventScroll: true});
  });
  dialog.addEventListener("click", (event) => {if (event.target === dialog) {const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();}});
  element("payoffDirections").addEventListener("click", (event) => {const button = event.target.closest("button[data-direction]"); if (button) applyDirection(button.dataset.direction);});
  ["payoffPremium", "payoffQuantity", "payoffSettlement", "payoffFees"].forEach((id) => element(id).addEventListener("input", () => {if (id === "payoffPremium") updateQuoteCaption(element(id).value !== element(id).dataset.reference); render();}));
  element("payoffSlider").addEventListener("input", (event) => {element("payoffSettlement").value = Number(event.target.value).toFixed(2); render();});
  element("payoffPresets").addEventListener("click", (event) => {
    const key = event.target.closest("button[data-scenario]")?.dataset.scenario;
    if (!key) return;
    const index = numeric(context.market.index) ?? numeric(context.market.row.strike_price);
    const prices = {down: index * .8, index, up: index * 1.2, strike: numeric(context.market.row.strike_price), breakeven: latestMetrics?.breakEven};
    if (prices[key] !== null && prices[key] !== undefined) {element("payoffSettlement").value = prices[key]; render();}
  });
  element("payoffRefresh").addEventListener("click", () => {
    try {
      const latest = context.getLatest();
      if (!latest?.row || latest.row.symbol !== context.market.row.symbol) {
        context.refreshError = "该合约已到期或已从最新行情移除，请重新选择合约。";
        showError(context.refreshError); return;
      }
      const frozen = freezeMarket(latest), error = contractError(frozen);
      if (error) {context.contractInvalid = error; showError(error); return;}
      context.market = frozen;
      context.refreshError = null; context.contractInvalid = null;
      element("payoffIndex").textContent = `${money(numeric(context.market.index))} USDT`;
      applyDirection(direction);
    } catch (error) {
      context.refreshError = "最新行情读取失败，当前结果已暂停，请重试刷新。";
      showError(context.refreshError);
    }
  });
  window.addEventListener("resize", () => {if (dialog.open && context) render();});
  return {open};
})();
