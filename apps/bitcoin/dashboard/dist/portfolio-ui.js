"use strict";

// A local scenario preview: frozen public quotes, no account or order requests.
window.OptionPortfolioPreview = (() => {
  const nf = new Intl.NumberFormat("en-US", {maximumFractionDigits: 8});
  const money = (value) => Number.isFinite(value) ? nf.format(Math.abs(value) < 1e-10 ? 0 : value) : "—";
  const signed = (value) => `${value > 1e-10 ? "+" : ""}${money(value)}`;
  const numeric = (value) => value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const key = (leg) => `${leg.row?.symbol ?? ""}|${leg.direction}`;
  const clock = (value) => {
    const ms = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(ms) ? new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false}).format(new Date(ms)) : "时间未知";
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const dialog = document.createElement("dialog");
  dialog.id = "portfolioDialog";
  dialog.className = "portfolio-dialog";
  dialog.setAttribute("aria-labelledby", "portfolioHeading");
  dialog.setAttribute("aria-describedby", "portfolioAssumptions");
  dialog.innerHTML = `
    <div class="portfolio-top">
      <div><h2 id="portfolioHeading">组合盈亏</h2><p id="portfolioContract"></p></div>
      <button type="button" id="closePortfolio" class="portfolio-close" aria-label="关闭组合盈亏">×</button>
    </div>
    <div class="portfolio-reference">
      <span>BTC 指数 <b id="portfolioIndex"></b> USDT <span id="portfolioCache"></span></span>
      <div><span id="portfolioRefreshNote">报价已固定</span><button type="button" id="portfolioRefresh">使用最新报价</button></div>
    </div>
    <div class="portfolio-legs-scroll">
      <table class="portfolio-legs"><thead><tr><th>组合腿</th><th>行权价</th><th>权利金单价 · USDT</th><th>数量 · 张</th><th>本腿到期盈亏 · USDT</th><th></th></tr></thead><tbody id="portfolioLegs"></tbody></table>
    </div>
    <div class="portfolio-controls">
      <label>到期 BTC 结算价 · USDT<input id="portfolioSettlement" type="number" min="0" step="any" inputmode="decimal"></label>
      <label>组合总费用 · USDT<input id="portfolioFees" type="number" min="0" step="any" value="0" inputmode="decimal"></label>
      <span class="portfolio-control-note">1 张 = 1 BTC · 费用自填</span>
    </div>
    <p id="portfolioError" class="portfolio-error" role="alert" hidden></p>
    <div id="portfolioResults">
      <div class="portfolio-stats">
        <div><span>净权利金</span><strong id="portfolioNetPremium"></strong><small id="portfolioPremiumDetail"></small></div>
        <div><span>盈亏平衡结算价 · USDT</span><strong id="portfolioBreakEven"></strong><small id="portfolioBreakEvenNote">已计所填费用</small></div>
        <div><span>组合最大盈利 · USDT</span><strong id="portfolioMaxProfit" class="portfolio-positive"></strong><small id="portfolioMaxProfitNote"></small></div>
        <div><span>组合最大亏损 · USDT</span><strong id="portfolioMaxLoss" class="portfolio-negative"></strong><small id="portfolioMaxLossNote"></small></div>
      </div>
      <div class="portfolio-chart-heading"><h3>到期盈亏</h3><div><span>情景净盈亏</span><strong id="portfolioPnl"></strong><small>USDT</small></div></div>
      <div id="portfolioChart" class="portfolio-chart"></div>
      <div class="portfolio-slider"><span>0</span><input id="portfolioSlider" type="range" min="0" max="150000" step="1" aria-label="调整组合到期 BTC 结算价"><span id="portfolioSliderMax"></span></div>
      <div id="portfolioPresets" class="portfolio-presets"><span>结算情景</span><button type="button" data-scenario="down">指数 −20%</button><button type="button" data-scenario="index">当前指数</button><button type="button" data-scenario="up">指数 +20%</button><span id="portfolioRoots"></span></div>
      <p id="portfolioOutcome" class="portfolio-outcome"></p>
    </div>
    <p id="portfolioAssumptions" class="portfolio-assumptions">持有至同一到期日 · 总费用扣除一次 · 未模拟强平</p>`;
  document.body.appendChild(dialog);
  const element = (id) => document.getElementById(id);
  let context = null;
  let lastMetrics = null;
  let refreshing = false;
  let expiryTimer = null;

  function stopExpiryTimer() {if (expiryTimer !== null) clearInterval(expiryTimer); expiryTimer = null;}
  function startExpiryTimer() {
    stopExpiryTimer();
    expiryTimer = setInterval(() => {
      if (!dialog.open || !context) return;
      const error = contractError(context.legs, context.snapshot);
      if (error && context.refreshError !== error) {context.refreshError = error; showError(error);}
    }, 1000);
  }

  function directionLabel(leg) {
    return `${leg.direction === "BUY" ? "买入" : "卖出"} ${leg.row.side === "CALL" ? "Call" : "Put"}`;
  }

  function referenceFor(leg, snapshot) {
    const field = leg.direction === "BUY" ? "ask_price" : "bid_price";
    const source = leg.quoteSource ?? leg.row.field_source?.[field] ?? leg.row.quote_source ?? "rest";
    const received = leg.row.field_updated_at?.[field] ?? leg.row.quote_updated_at ?? snapshot.fetched_at;
    const quoteTime = leg.quoteTime ?? (source === "websocket" ? leg.row.field_event_ms?.[field] ?? received : received);
    const reference = numeric(leg.row[field]);
    return {source, quoteTime, reference, validQuote: reference !== null && reference > 0};
  }

  function freezeLeg(leg, snapshot) {
    const row = clone(leg.row ?? {});
    const frozen = {...leg, row};
    const reference = referenceFor(frozen, snapshot);
    return {...frozen, ...reference, quantity: String(leg.quantity ?? row.min_qty ?? "0.01"), premium: String(leg.premium ?? (reference.validQuote ? row[leg.direction === "BUY" ? "ask_price" : "bid_price"] : "")), custom: false};
  }

  function contractError(legs, snapshot) {
    if (!Array.isArray(legs) || legs.length < 2) return "组合模拟至少需要 2 个期权报价，请关闭弹窗后继续选择。";
    if (legs.some((leg) => !leg.row?.symbol?.startsWith("BTC-") || numeric(leg.row.unit) !== 1 || !["BUY", "SELL"].includes(leg.direction) || !["CALL", "PUT"].includes(leg.row.side))) return "暂仅支持合约乘数为 1 BTC 的买入／卖出 Call 和 Put。";
    const expiries = legs.map((leg) => numeric(leg.row.expiry_ms) ?? Date.parse(leg.row.expiry_beijing));
    if (expiries.some((ms) => !Number.isFinite(ms)) || !expiries.every((ms) => ms === expiries[0])) return "组合的各腿必须具有相同到期时间。";
    const now = Date.now() + (numeric(snapshot.exchange_clock_offset_ms) ?? 0);
    if (expiries[0] <= now) return "该组合已到期，请关闭弹窗后重新选择未到期合约。";
    return null;
  }

  function quoteNote(leg) {
    const label = leg.direction === "BUY" ? "卖一" : "买一";
    const custom = leg.custom ? "自定义权利金 · " : "";
    const unavailable = leg.validQuote ? "" : "最新盘口无有效报价 · ";
    return `${custom}${unavailable}${label} ${money(leg.reference)} · ${clock(leg.quoteTime)}（北京）`;
  }

  function updateLegNote(index) {
    const leg = context.legs[index];
    const node = element("portfolioLegs").querySelector(`[data-index="${index}"] .portfolio-leg-note`);
    if (node) {node.textContent = quoteNote(leg); node.classList.toggle("invalid", !leg.validQuote);}
  }

  function renderLegs() {
    element("portfolioLegs").innerHTML = context.legs.map((leg, index) => `<tr data-index="${index}" data-symbol="${escape(leg.row.symbol)}" data-direction="${leg.direction}">
      <td><strong class="portfolio-leg-direction ${leg.direction === "BUY" ? "buy" : "sell"}">${directionLabel(leg)}</strong><small>${escape(leg.row.symbol)}</small></td>
      <td class="portfolio-strike">${money(numeric(leg.row.strike_price))}</td>
      <td><input data-field="premium" type="number" min="0" step="any" inputmode="decimal" value="${escape(leg.premium)}" aria-label="${escape(directionLabel(leg) + " " + leg.row.symbol + " 权利金单价")}"><small class="portfolio-leg-note${leg.validQuote ? "" : " invalid"}">${escape(quoteNote(leg))}</small></td>
      <td><input data-field="quantity" type="number" min="0" step="any" inputmode="decimal" value="${escape(leg.quantity)}" aria-label="${escape(directionLabel(leg) + " " + leg.row.symbol + " 模拟数量")}"></td>
      <td class="portfolio-leg-pnl" data-leg-pnl="${index}">—</td>
      <td><button type="button" data-remove="${index}" aria-label="移除${escape(directionLabel(leg) + " " + leg.row.symbol)}">×</button></td>
    </tr>`).join("");
    updateHeader();
  }

  function updateHeader() {
    const expiry = context.legs[0]?.row.expiry_ms ?? context.legs[0]?.row.expiry_beijing;
    element("portfolioContract").textContent = `${context.legs.length} 腿 · ${clock(expiry)} 到期（北京）`;
    element("portfolioIndex").textContent = money(numeric(context.snapshot.btc_index_price));
    element("portfolioCache").textContent = context.snapshot.stale ? "· 缓存行情" : "";
  }

  function configuration() {
    return {legs: context.legs.map((leg) => ({type: leg.row.side, direction: leg.direction, strike: leg.row.strike_price, premium: leg.premium, quantity: leg.quantity, unit: leg.row.unit, fees: 0})), fees: element("portfolioFees").value};
  }

  function showError(message) {
    lastMetrics = null;
    element("portfolioError").textContent = message;
    element("portfolioError").hidden = false;
    element("portfolioResults").hidden = true;
    element("portfolioLegs").querySelectorAll("[data-leg-pnl]").forEach((node) => {node.textContent = "—"; node.classList.remove("portfolio-positive", "portfolio-negative");});
  }

  function render() {
    if (!context) return;
    try {renderUnchecked();}
    catch (error) {
      if (!(error instanceof RangeError)) console.error("组合期权盈亏计算失败", error);
      showError(error instanceof RangeError ? error.message : "组合计算暂不可用，请关闭后重试。");
    }
  }

  function renderUnchecked() {
    const error = context.refreshError ?? contractError(context.legs, context.snapshot);
    if (error) {showError(error); return;}
    const settlement = numeric(element("portfolioSettlement").value);
    if (settlement === null || settlement < 0) {showError("到期 BTC 结算价需为非负有限数值。"); return;}
    const checked = OptionPortfolio.validate(configuration());
    if (!checked.valid) {
      const missing = context.legs.find((leg) => !(numeric(leg.premium) > 0));
      showError(missing ? `${directionLabel(missing)} ${missing.row.symbol} 需要有效正数权利金。当前报价为空时，可填写自定义权利金或使用最新报价重试。` : checked.errors[0]?.message ?? "请检查组合的数量、权利金和总费用。");
      return;
    }
    const config = checked.config;
    const metrics = OptionPortfolio.metrics(config);
    const pnl = OptionPortfolio.pnl(config, settlement);
    lastMetrics = metrics;
    element("portfolioError").hidden = true;
    element("portfolioResults").hidden = false;
    const debit = -metrics.netPremium;
    element("portfolioNetPremium").textContent = `${debit > 0 ? "净付 " : debit < 0 ? "净收 " : "收付相抵 "}${money(Math.abs(debit))}`;
    element("portfolioPremiumDetail").textContent = `支付 ${money(metrics.premiumPaid)} / 收取 ${money(metrics.premiumReceived)} USDT（未含费用）`;
    const ranges = metrics.breakEvenRanges ?? [];
    const roots = (metrics.breakEvens ?? []).filter((value) => !ranges.some(([lo, hi]) => value >= lo && value <= hi));
    const rootText = roots.map(money);
    const rangeText = ranges.map(([lo, hi]) => `${money(lo)} – ${hi === Infinity ? "∞" : money(hi)}`);
    element("portfolioBreakEven").textContent = [...rootText, ...rangeText].join(" / ") || "无平衡价";
    element("portfolioBreakEvenNote").textContent = ranges.length ? "所列区间内净盈亏均为 0" : roots.length ? "已计所填费用" : "非负结算价范围内无零盈亏情景";
    element("portfolioMaxProfit").textContent = metrics.maxProfit === Infinity ? "无上限" : money(metrics.maxProfit);
    element("portfolioMaxLoss").textContent = metrics.maxLoss === Infinity ? "无上限" : money(metrics.maxLoss);
    element("portfolioMaxProfitNote").textContent = metrics.maxProfit === 0 ? "无盈利情景" : "";
    element("portfolioMaxLossNote").textContent = metrics.maxLoss === 0 ? "无亏损情景" : "";
    element("portfolioPnl").textContent = signed(pnl);
    element("portfolioPnl").className = pnl > 0 ? "portfolio-positive" : pnl < 0 ? "portfolio-negative" : "";
    config.legs.forEach((leg, index) => {
      const value = OptionPayoff.pnl(leg, settlement);
      const node = element("portfolioLegs").querySelector(`[data-leg-pnl="${index}"]`);
      node.textContent = signed(value);
      node.className = `portfolio-leg-pnl ${value > 0 ? "portfolio-positive" : value < 0 ? "portfolio-negative" : ""}`;
    });
    element("portfolioRoots").innerHTML = roots.map((value, i) => `<button type="button" data-price="${value}">平衡价${roots.length > 1 ? ` ${i + 1}` : ""}</button>`).join("");
    element("portfolioOutcome").textContent = `${metrics.fees > 0 ? `已扣费用 ${money(metrics.fees)} USDT` : "未计手续费"}${metrics.pnlMax < 0 ? " · 所有到期情景均亏损" : metrics.pnlMin > 0 ? " · 所有非负结算价均盈利" : ""}`;
    drawChart(config, metrics, settlement);
  }

  function drawChart(config, metrics, settlement) {
    const index = numeric(context.snapshot.btc_index_price) ?? Math.max(...metrics.strikes);
    const roots = metrics.breakEvens ?? [];
    const ranges = metrics.breakEvenRanges ?? [];
    const finiteEnds = ranges.flat().filter(Number.isFinite);
    const basePrices = [index, settlement, ...metrics.strikes, ...roots, ...finiteEnds].filter((value) => Number.isFinite(value) && value >= 0);
    const minBase = Math.min(...basePrices), maxBase = Math.max(...basePrices);
    const pricePadding = Math.max(index * .02, (maxBase - minBase) * .25, 100);
    const minPrice = Math.max(0, Math.floor((minBase - pricePadding) / 100) * 100);
    const maxPrice = Math.ceil((maxBase + pricePadding) / 100) * 100;
    if (![minPrice, maxPrice, maxPrice - minPrice].every(Number.isFinite) || maxPrice <= minPrice) throw new RangeError("图表价格范围溢出，请缩小价格或数量。");
    const breaks = [...new Set([minPrice, ...metrics.strikes, ...roots, ...finiteEnds, settlement, maxPrice].filter((value) => Number.isFinite(value) && value >= minPrice && value <= maxPrice))].sort((a, b) => a - b);
    const values = breaks.map((price) => OptionPortfolio.pnl(config, price));
    const low = Math.min(0, ...values), high = Math.max(0, ...values);
    const pad = Math.max(1, (high - low) * .12), yMin = low - pad, yMax = high + pad;
    if (![yMin, yMax, yMax - yMin].every(Number.isFinite) || yMax <= yMin) throw new RangeError("图表盈亏范围溢出，请缩小数量或费用。");
    const chartNode = element("portfolioChart");
    const availableWidth = chartNode.clientWidth || Math.min(900, window.innerWidth - 80);
    const width = Math.max(300, Math.min(900, availableWidth));
    const mobile = width < 600;
    const height = mobile ? 195 : 152, left = mobile ? 60 : 76, right = 16, top = 19, bottom = 34;
    const x = (price) => left + (price - minPrice) / (maxPrice - minPrice) * (width - left - right);
    const y = (value) => top + (yMax - value) / (yMax - yMin) * (height - top - bottom);
    const point = (price) => `${x(price).toFixed(2)},${y(OptionPortfolio.pnl(config, price)).toFixed(2)}`;
    let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="组合到期盈亏曲线，当前显示 BTC 结算价 ${money(minPrice)} 至 ${money(maxPrice)} USDT；BTC 结算价 ${money(settlement)} USDT 时组合净盈亏 ${signed(OptionPortfolio.pnl(config, settlement))} USDT">`;
    for (const tick of [low, 0, high].filter((value, i, values) => values.indexOf(value) === i && (value === 0 || Math.abs(y(value) - y(0)) >= 15))) svg += `<line class="portfolio-grid ${tick === 0 ? "zero" : ""}" x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}"/><text class="portfolio-axis" x="${left - 9}" y="${y(tick) + 4}" text-anchor="end">${money(tick)}</text>`;
    for (let n = 0; n <= 4; n++) {
      const tickPrice = minPrice + (maxPrice - minPrice) * n / 4;
      svg += `<text class="portfolio-axis" x="${x(tickPrice)}" y="${height - 14}" text-anchor="middle">${money(tickPrice)}</text>`;
    }
    svg += `<text class="portfolio-axis" x="${left}" y="11">净盈亏 · USDT</text><text class="portfolio-axis" x="${width - right}" y="${height - 1}" text-anchor="end">BTC 到期结算价 · USDT</text>`;
    for (let i = 1; i < breaks.length; i++) {
      const a = breaks[i - 1], b = breaks[i];
      const color = OptionPortfolio.pnl(config, (a + b) / 2) >= 0 ? "positive" : "negative";
      svg += `<path class="portfolio-area ${color}" d="M ${x(a)},${y(0)} L ${point(a)} L ${point(b)} L ${x(b)},${y(0)} Z"/><polyline class="portfolio-line ${color}" points="${point(a)} ${point(b)}"/>`;
    }
    for (const strike of metrics.strikes) svg += `<line class="portfolio-strike-line" x1="${x(strike)}" x2="${x(strike)}" y1="${top}" y2="${height - bottom}"/>`;
    for (const root of roots) svg += `<circle class="portfolio-break-point" cx="${x(root)}" cy="${y(0)}" r="3.5"/>`;
    svg += `<circle class="portfolio-scenario-point" cx="${x(settlement)}" cy="${y(OptionPortfolio.pnl(config, settlement))}" r="4.5"/></svg>`;
    chartNode.innerHTML = svg;
    element("portfolioSlider").max = maxPrice;
    element("portfolioSlider").value = settlement;
    element("portfolioSliderMax").textContent = money(maxPrice);
  }

  function open({legs, snapshot, getLatest}) {
    const frozenSnapshot = clone(snapshot ?? {});
    context = {legs: Array.isArray(legs) ? legs.map((leg) => freezeLeg(leg, frozenSnapshot)) : [], snapshot: frozenSnapshot, getLatest, trigger: document.activeElement, refreshError: null};
    refreshing = false;
    lastMetrics = null;
    element("portfolioFees").value = "0";
    element("portfolioSettlement").value = frozenSnapshot.btc_index_price ?? context.legs[0]?.row.strike_price ?? "";
    element("portfolioRefreshNote").textContent = "固定报价";
    element("portfolioRefresh").disabled = typeof getLatest !== "function";
    renderLegs();
    if (!dialog.open) dialog.showModal();
    startExpiryTimer();
    render();
    element("closePortfolio").focus({preventScroll: true});
  }

  element("closePortfolio").addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", (event) => {if (event.key === "Escape") event.stopPropagation();});
  dialog.addEventListener("close", () => {
    stopExpiryTimer();
    const trigger = context?.trigger;
    if (trigger?.isConnected && typeof trigger.focus === "function") trigger.focus({preventScroll: true});
    else (document.getElementById("simulateCombo") ?? document.getElementById("focusButton"))?.focus({preventScroll: true});
  });
  dialog.addEventListener("click", (event) => {if (event.target === dialog) {const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();}});
  element("portfolioLegs").addEventListener("input", (event) => {
    const field = event.target.dataset.field;
    const index = Number(event.target.closest("tr[data-index]")?.dataset.index);
    if (!context?.legs[index] || !["quantity", "premium"].includes(field)) return;
    context.legs[index][field] = event.target.value;
    if (field === "premium") {context.legs[index].custom = numeric(event.target.value) !== context.legs[index].reference; updateLegNote(index);}
    render();
  });
  element("portfolioLegs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-remove]");
    if (!button) return;
    context.legs.splice(Number(button.dataset.remove), 1);
    renderLegs(); render();
    (element("portfolioLegs").querySelector("button[data-remove]") ?? element("closePortfolio")).focus({preventScroll: true});
  });
  ["portfolioSettlement", "portfolioFees"].forEach((id) => element(id).addEventListener("input", render));
  element("portfolioSlider").addEventListener("input", (event) => {element("portfolioSettlement").value = event.target.value; render();});
  element("portfolioPresets").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    let value = numeric(button.dataset.price);
    if (button.dataset.scenario) {
      const index = numeric(context.snapshot.btc_index_price) ?? numeric(context.legs[0]?.row.strike_price);
      value = index === null ? null : ({down: index * .8, index, up: index * 1.2})[button.dataset.scenario];
    }
    if (value !== null && value !== undefined) {element("portfolioSettlement").value = value; render();}
  });
  element("portfolioRefresh").addEventListener("click", async () => {
    if (refreshing || !context || typeof context.getLatest !== "function") return;
    refreshing = true;
    element("portfolioRefresh").disabled = true;
    const activeContext = context;
    try {
      const latest = await context.getLatest(context.legs);
      if (context !== activeContext) return;
      if (latest?.error || !Array.isArray(latest?.legs) || !latest.legs.length) {
        context.refreshError = latest?.error ?? "组合合约已到期或已从最新行情移除，请重新选择。";
        showError(context.refreshError); return;
      }
      const snapshot = clone(latest.snapshot ?? context.snapshot);
      const currentKeys = new Set(context.legs.map(key));
      const latestLegs = latest.legs.filter((leg) => currentKeys.has(key(leg)));
      const error = contractError(latestLegs, snapshot);
      if (error) {context.refreshError = error; showError(error); return;}
      const latestMap = new Map(latestLegs.map((leg) => [key(leg), leg]));
      context.legs = context.legs.map((leg) => {
        const newer = latestMap.get(key(leg));
        if (!newer) return {...leg, premium: "", reference: null, validQuote: false, custom: false, quoteTime: snapshot.fetched_at, source: "rest", quoteDescription: null};
        const next = freezeLeg(newer, snapshot);
        const price = newer.row[next.direction === "BUY" ? "ask_price" : "bid_price"];
        return {...next, quantity: leg.quantity, premium: next.validQuote ? String(price) : "", custom: false};
      });
      context.snapshot = snapshot;
      context.refreshError = null;
      element("portfolioRefreshNote").textContent = "已更新报价";
      renderLegs(); render();
    } catch (error) {
      if (context !== activeContext) return;
      context.refreshError = "最新行情读取失败，当前组合结果已暂停，请重试刷新。";
      showError(context.refreshError);
    } finally {
      if (context === activeContext) {
        refreshing = false;
        element("portfolioRefresh").disabled = typeof context?.getLatest !== "function";
      }
    }
  });
  window.addEventListener("resize", () => {if (dialog.open) render();});
  return Object.freeze({open});
})();
