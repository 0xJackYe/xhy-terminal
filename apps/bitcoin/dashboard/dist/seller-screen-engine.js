/* Public-data-only seller candidate comparison. No account or order API. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./sell-put-engine.js"));
  else root.SellerScreenEngine = factory(root.SellPutEngine);
})(typeof globalThis !== "undefined" ? globalThis : this, function (sellerEngine) {
  "use strict";
  const DAY = 86400000;
  const DEFAULTS = Object.freeze({side: "PUT", mode: "balanced", balance: 1000, quantity: .1,
    minDays: 10, maxDays: 20, minOtmPct: 20, maxOtmPct: 25, maxSpreadPct: 50, limit: 5});
  const MOVES = Object.freeze([-.3, -.2, -.1, .1, .2, .3]);
  const CATEGORIES = Object.freeze(["freshness", "depth", "spread", "balance", "filter", "metadata", "invalid"]);
  const FORMULAS = Object.freeze({
    risk: "低风险优先：按不利10%、20%、30%三种压力中的最大亏损/手工余额从小到大，再比较最坏MM/调整后权益；同值再按每日净权利金从高到低。仅为候选间相对排序。",
    premium: "权利金优先：按本次净权利金/剩余天数从高到低；同值再比较最大压力亏损/余额和最坏MM/调整后权益。",
    balanced: "风险收益平衡：按（本次净权利金/剩余天数）÷（最大不利压力亏损+本次净权利金）从高到低；同值再比较压力亏损/余额和最坏MM/调整后权益。"
  });
  const STRESS_ASSUMPTION = "统一手工数量；经过1天，BTC分别变动±10%、±20%、±30%，IV增加20个百分点（最高500%）。压力最大亏损仅取Put下跌/Call上涨三种情景，最低为0；标记价锚定理论回购估值并扣假设平仓费，非成交保证、概率预测或精确强平价。到期后按假设结算价现金结算。";
  const num = value => typeof value === "number" ? Number.isFinite(value) ? value : null
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const timestamp = value => num(value) ?? (typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);
  const expiry = row => num(row?.expiry_ms) ?? timestamp(row?.expiry_beijing);
  const symbolOf = row => typeof row?.symbol === "string" ? row.symbol : "";

  function normalizeInput(input = {}) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const settings = Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, Object.hasOwn(source, key) ? source[key] : fallback]));
    const issues = [];
    if (source !== input) issues.push("筛选参数必须是对象。");
    for (const key of ["balance", "quantity", "minDays", "maxDays", "minOtmPct", "maxOtmPct", "maxSpreadPct", "limit"]) settings[key] = num(settings[key]);
    if (["balance", "quantity", "minDays", "maxDays", "minOtmPct", "maxOtmPct", "maxSpreadPct", "limit"].some(key => settings[key] === null)) issues.push("数值参数不能为空、无效或无限大。");
    if (!["PUT", "CALL", "ALL"].includes(settings.side)) issues.push("请选择有效的期权方向。");
    if (!["risk", "balanced", "premium"].includes(settings.mode)) issues.push("请选择低风险优先、风险收益平衡或权利金优先。");
    if (!(settings.balance > 0 && settings.balance <= 1e12)) issues.push("手工余额须大于0且不超过1万亿USDT。");
    if (!(settings.quantity > 0)) issues.push("统一手工数量须大于0。");
    if (!(settings.minDays >= 0 && settings.maxDays > 0 && settings.minDays <= settings.maxDays && settings.maxDays <= 730)) issues.push("剩余天数区间须有效，最多730天。");
    if (!(settings.minOtmPct >= 0 && settings.maxOtmPct >= settings.minOtmPct) || settings.side !== "CALL" && !(settings.maxOtmPct < 100)) issues.push("价外幅度区间须有效；Put价外幅度须低于100%。");
    if (!(settings.maxSpreadPct >= 0 && settings.maxSpreadPct <= 10000)) issues.push("价差上限须在0%至10000%之间。");
    if (!Number.isInteger(settings.limit) || settings.limit < 1 || settings.limit > 5) issues.push("最多展示数量须为1至5的整数。");
    return {settings, issues};
  }

  function categoryFor(reason) {
    if (/陈旧|时间|待核验|待更新|同步|指数缺失|深度未知/.test(reason)) return "freshness";
    if (/价差/.test(reason)) return "spread";
    if (/深度|买一报价|卖一报价|无买盘|无卖盘/.test(reason)) return "depth";
    if (/余额|保证金不足|预留/.test(reason)) return "balance";
    if (/规则|合约|乘数|结算|标记|IV|步长|精度|数量.*范围|价格上界/.test(reason)) return "metadata";
    return "invalid";
  }
  function compareCandidates(a, b, mode) {
    let delta;
    if (mode === "risk") delta = a.worstStressLossPct - b.worstStressLossPct || a.worstStressMarginRatio - b.worstStressMarginRatio || b.dailyPremium - a.dailyPremium;
    else if (mode === "premium") delta = b.dailyPremium - a.dailyPremium || a.worstStressLossPct - b.worstStressLossPct || a.worstStressMarginRatio - b.worstStressMarginRatio;
    else delta = b.balanceRatio - a.balanceRatio || a.worstStressLossPct - b.worstStressLossPct || a.worstStressMarginRatio - b.worstStressMarginRatio;
    return delta || a.symbol.localeCompare(b.symbol);
  }

  function evaluate(snapshot, input = {}, now = Date.now()) {
    const {settings, issues} = normalizeInput(input);
    const result = {candidates: [], rejected: [], issues, settings, evaluatedAt: now, modeComparison: null, spot: num(snapshot?.btc_index_price),
      formula: FORMULAS[settings.mode] ?? "", stressAssumption: STRESS_ASSUMPTION,
      summary: {inputCount: Array.isArray(snapshot?.options) ? snapshot.options.length : 0, eligibleCount: 0, shownCount: 0,
        rejectedCount: 0, omittedCount: 0, reasonCounts: Object.fromEntries(CATEGORIES.map(key => [key, 0])),
        pressureCounts: {normal: 0, "margin-call": 0, liquidation: 0}}};
    const reject = (row, category, reason, detail = {}) => {
      result.rejected.push({symbol: symbolOf(row), side: row?.side ?? null, category, reason, ...detail});
      result.summary.reasonCounts[category]++;
    };
    const finish = () => {result.summary.rejectedCount = result.rejected.length; return result;};
    if (issues.length) return finish();
    if (!Number.isFinite(now) || now <= 0 || Math.abs(now) > 8640000000000000) {issues.push("试算时间无效。"); return finish();}
    if (!snapshot || !Array.isArray(snapshot.options) || !(result.spot > 0)) {
      issues.push("等待有效BTC公开行情。");
      for (const row of Array.isArray(snapshot?.options) ? snapshot.options : []) reject(row, "freshness", "BTC指数缺失，等待有效公开行情");
      return finish();
    }
    if (!snapshot.options.length) {issues.push("等待有效BTC公开行情。"); return finish();}
    if (typeof sellerEngine?.normalizeSettings !== "function" || typeof sellerEngine?.analyzeCandidate !== "function") {
      issues.push("卖方计算模块尚未载入。"); return finish();
    }
    const clock = now + (num(snapshot.exchange_clock_offset_ms) ?? 0), eligible = [];
    for (const row of snapshot.options) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {reject(row, "invalid", "合约记录格式无效"); continue;}
      const side = row.side;
      if (!["PUT", "CALL"].includes(side) || settings.side !== "ALL" && side !== settings.side) {reject(row, "filter", "不属于当前期权方向"); continue;}
      const expiryMs = expiry(row), strike = num(row.strike_price), days = (expiryMs - clock) / DAY;
      if (expiryMs === null || Math.abs(expiryMs) > 8640000000000000 || !(strike > 0)) {reject(row, "metadata", "到期时间或行权价无效"); continue;}
      const symbol = /^BTC-\d{6}-(\d+(?:\.\d+)?)-([PC])$/.exec(symbolOf(row));
      if (!symbol || symbol[2] !== (side === "PUT" ? "P" : "C") || Number(symbol[1]) !== strike) {reject(row, "metadata", "合约代码与期权方向或行权价不一致"); continue;}
      const strikeRatio = strike / result.spot, otmPct = (side === "PUT" ? 1 - strikeRatio : strikeRatio - 1) * 100;
      const detail = {expiryMs, days, strike, otmPct};
      if (!(days > 0)) {reject(row, "filter", "合约已到期", detail); continue;}
      if (days < settings.minDays || days > settings.maxDays) {reject(row, "filter", "剩余期限不在筛选范围", detail); continue;}
      if (otmPct < settings.minOtmPct - 1e-9 || otmPct > settings.maxOtmPct + 1e-9) {reject(row, "filter", "价外幅度不在筛选范围", detail); continue;}
      const iv = num(row.mark_iv);
      if (!(iv > 0 && iv <= 5)) {reject(row, "metadata", "标记IV缺失或异常，无法生成压力情景", detail); continue;}
      const pressureVol = Math.min(5, iv + .2);
      const normalized = sellerEngine.normalizeSettings({balance: settings.balance, reserve: 0, quantityMode: "manual", quantity: settings.quantity,
        minDays: settings.minDays, maxDays: settings.maxDays, minStrikeRatio: side === "PUT" ? 1 - settings.maxOtmPct / 100 : 1 + settings.minOtmPct / 100,
        maxStrikeRatio: side === "PUT" ? 1 - settings.minOtmPct / 100 : 1 + settings.maxOtmPct / 100,
        maxSpreadPct: settings.maxSpreadPct, stressElapsedDays: 1, stressMoves: [...MOVES], stressVols: [pressureVol]}, side);
      if (normalized.issues.length) {reject(row, "invalid", normalized.issues.join("；"), detail); continue;}
      const entry = sellerEngine.analyzeCandidate(snapshot, row, normalized.settings, now, side), m = entry.metrics;
      if (entry.issue || !m) {const reason = entry.issue ?? "当前合约无法计算"; reject(row, categoryFor(reason), reason, detail); continue;}
      if (!(m.netPremium > 0)) {reject(row, "invalid", "扣费后净权利金不为正", detail); continue;}
      if (!Array.isArray(entry.stress) || entry.stress.length !== 6 || entry.stress.some(point => ![point.pnl, point.mark, point.marginRatio].every(Number.isFinite))) {
        reject(row, "metadata", "压力情景不完整，无法可靠比较", detail); continue;
      }
      const stress = entry.stress.map(point => ({...point, loss: Math.max(0, -point.pnl), lossPct: Math.max(0, -point.pnl) / settings.balance * 100,
        ivShift: pressureVol - iv, ivCapped: iv + .2 > 5}));
      const moves = side === "PUT" ? [-.1, -.2, -.3] : [.1, .2, .3];
      const adverseStress = moves.map(move => stress.find(point => point.movePct === move));
      if (adverseStress.some(point => !point)) {reject(row, "metadata", "不利压力情景缺失，无法可靠比较", detail); continue;}
      const primaryStress = adverseStress[1], worstStressLoss = Math.max(...adverseStress.map(point => point.loss));
      const worstStressLossPct = worstStressLoss / settings.balance * 100, worstStressMarginRatio = Math.max(...adverseStress.map(point => point.marginRatio));
      const dailyPremium = m.netPremium / days, balanceRatio = dailyPremium / (worstStressLoss + m.netPremium);
      if (![dailyPremium, balanceRatio, worstStressLossPct, worstStressMarginRatio].every(Number.isFinite)) {reject(row, "invalid", "金额或比较口径超出可计算范围", detail); continue;}
      const stressState = worstStressMarginRatio >= .95 ? "liquidation" : worstStressMarginRatio >= .8 ? "margin-call" : "normal";
      result.summary.pressureCounts[stressState]++;
      eligible.push({symbol: row.symbol, side, row, expiryMs, days, spot: result.spot, strike, strikeRatio, otmPct, quantity: m.quantity,
        netPremium: m.netPremium, grossPremium: m.grossPremium, entryFee: m.entryFee, dailyPremium,
        orderMargin: m.orderMargin, maintenanceMargin: m.maintenanceMargin, marginRatio: m.marginRatio,
        breakEven: m.breakEven, maxExpiryLoss: m.maxExpiryLoss, lossUnbounded: side === "CALL",
        stress, adverseStress, primaryStress, worstStressLoss, worstStressLossPct, worstStressMarginRatio, stressState,
        isPriority: stressState === "normal", balanceRatio, warnings: [...entry.warnings], metrics: m});
    }
    eligible.sort((a, b) => compareCandidates(a, b, settings.mode));
    result.candidates = eligible.slice(0, settings.limit).map((candidate, index) => ({...candidate, rank: index + 1}));
    if (result.candidates.length && ["balanced", "premium"].includes(settings.mode)) {
      const comparisonMode = settings.mode === "balanced" ? "premium" : "balanced";
      const actual = result.candidates.map(candidate => candidate.symbol);
      const comparison = [...eligible].sort((a, b) => compareCandidates(a, b, comparisonMode)).slice(0, settings.limit).map(candidate => candidate.symbol);
      result.modeComparison = {mode: comparisonMode, count: actual.length,
        sameContracts: actual.length === comparison.length && actual.every(symbol => comparison.includes(symbol)),
        sameOrder: actual.length === comparison.length && actual.every((symbol, index) => symbol === comparison[index])};
    }
    result.summary.eligibleCount = eligible.length; result.summary.shownCount = result.candidates.length;
    result.summary.omittedCount = eligible.length - result.candidates.length;
    return finish();
  }
  return Object.freeze({evaluate, normalizeInput, compareCandidates, DEFAULTS, FORMULAS, STRESS_ASSUMPTION});
});
