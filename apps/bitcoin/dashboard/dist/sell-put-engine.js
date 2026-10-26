/* Public-data-only, single short BTC option planning. No account/order API. */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./risk-ui.js"));
  else root.SellPutEngine = factory(root.OptionRiskUI);
})(typeof globalThis !== "undefined" ? globalThis : this, function (quoteChecks) {
  "use strict";
  const DAY = 86400000;
  const DEFAULTS = Object.freeze({balance: 1000, reserve: 0, quantityMode: "maxMargin", quantity: .1,
    minDays: 10, maxDays: 20, minStrikeRatio: .75, maxStrikeRatio: .8, maxSpreadPct: 50,
    feeRate: .00024, exerciseFeeRate: .00015, feeCap: .1, stressElapsedDays: 1,
    stressMoves: [-.1, -.2, -.3], sort: "expiry"});
  const CALL_DEFAULTS = Object.freeze({...DEFAULTS, minStrikeRatio: 1.2, maxStrikeRatio: 1.25,
    stressMoves: [.1, .2, .3]});
  const num = value => typeof value === "number" ? Number.isFinite(value) ? value : null
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const stamp = value => typeof value === "number" ? num(value) : typeof value === "string" ? num(Date.parse(value)) : null;
  const expiry = row => num(row.expiry_ms) ?? stamp(row.expiry_beijing);
  const totalFee = (s, p, q, rate, cap) => Math.min(rate * s, cap * p) * q;
  const checked = (value, name) => {if (!Number.isFinite(value)) throw new RangeError(name + "超出可计算范围"); return value;};

  // Cephes erfc approximation: avoid cancellation for far-out-of-money puts.
  const polevl = (x, c) => c.reduce((a, b) => a * x + b, 0);
  const p1evl = (x, c) => c.reduce((a, b) => a * x + b, 1);
  function erfc(x) {
    if (x < 0) return 2 - erfc(-x);
    if (x < 1) return 1 - x * polevl(x*x, [9.604973739870516,90.02601972038427,2232.005345946843,7003.325141128051,55592.3013010395])
      / p1evl(x*x, [33.56171416475031,521.3579497801527,4594.323829709801,22629.000061389095,49267.39426086359]);
    if (x > 27.3) return 0;
    const ratio = x < 8 ? polevl(x, [2.461969814735305e-10,.5641895648310688,7.463210564422699,48.63719709856814,196.5208329560771,526.4451949954773,934.5285271719576,1027.5518868951572,557.5353353693993])
      / p1evl(x, [13.228195115474499,86.70721408859897,354.9377788878199,975.7085017432055,1823.9091668790974,2246.3376081871097,1656.6630919416134,557.5353408177277])
      : polevl(x, [.5641895835477551,1.275366707599781,5.019050422511805,6.160210979930536,7.4097426995044895,2.9788666537210024])
      / p1evl(x, [2.2605286322011726,9.396035249380014,12.048953980809666,17.08144507475659,9.608968090632859,3.369076451000815]);
    return Math.exp(-x*x) * ratio;
  }
  const cdf = z => .5 * erfc(-z / Math.sqrt(2));
  function putPrice(spot, strike, years, vol) {
    if (![spot,strike,years,vol].every(Number.isFinite) || spot <= 0 || strike <= 0 || years < 0 || vol < 0 || vol > 5) throw new RangeError("压力定价参数无效");
    if (years === 0 || vol === 0) return Math.max(strike - spot, 0);
    const v = vol * Math.sqrt(years), d1 = (Math.log(spot / strike) + v*v/2) / v;
    return Math.max(0, Math.min(strike, checked(strike * cdf(v - d1) - spot * cdf(-d1), "理论价格")));
  }
  function callPrice(spot, strike, years, vol) {
    // At r=0, C(S,K)=P(K,S). Evaluating the OTM Gaussian tails directly
    // avoids the cancellation in P(S,K)+S-K for far-OTM Calls.
    return putPrice(strike, spot, years, vol);
  }
  const intrinsic = (spot, strike, side) => Math.max(side === "CALL" ? spot - strike : strike - spot, 0);
  const priceFor = side => side === "CALL" ? callPrice : putPrice;

  function normalizeSettings(input = {}, side = input?.side ?? "PUT") {
    const s = {...(side === "CALL" ? CALL_DEFAULTS : DEFAULTS), ...input}, issues = [];
    if (!["PUT", "CALL"].includes(side)) issues.push("期权类型无效，只支持PUT或CALL。");
    for (const key of ["balance","reserve","quantity","minDays","maxDays","minStrikeRatio","maxStrikeRatio","maxSpreadPct","feeRate","exerciseFeeRate","feeCap","stressElapsedDays"]) s[key] = num(s[key]);
    if (["balance","reserve","minDays","maxDays","minStrikeRatio","maxStrikeRatio","maxSpreadPct","feeRate","exerciseFeeRate","feeCap","stressElapsedDays"].some(key => !Number.isFinite(s[key]))) issues.push("数值参数不能为空、无效或无限大。");
    if (!(s.balance > 0) || s.balance > 1e12) issues.push("请填写大于0且不超过1万亿USDT的手工账户余额。");
    if (!(s.reserve >= 0) || s.reserve >= s.balance) issues.push("预留金额须为非负数且小于账户余额。");
    if (!["maxMargin","manual","cashSecured"].includes(s.quantityMode)) issues.push("数量模式无效。");
    if (side === "CALL" && s.quantityMode === "cashSecured") issues.push("裸卖Call无有限足额赔付模式");
    if (s.quantityMode === "manual" && !(s.quantity > 0)) issues.push("手工数量须大于0。");
    if (!(s.minDays >= 0) || !(s.maxDays > 0) || s.minDays > s.maxDays || s.maxDays > 730) issues.push("到期期限区间无效（最多730天）。");
    if (side === "CALL") {
      if (!(s.minStrikeRatio >= 1) || !(s.maxStrikeRatio >= s.minStrikeRatio)) issues.push("Call行权价/现价须不低于100%，且下限不大于上限。");
    } else if (!(s.minStrikeRatio > 0) || !(s.maxStrikeRatio > 0) || s.minStrikeRatio > s.maxStrikeRatio || s.maxStrikeRatio > 1) issues.push("行权价/现价须在0%至100%以内，且下限不大于上限。");
    if (!(s.maxSpreadPct >= 0) || s.maxSpreadPct > 10000) issues.push("买卖价差上限无效。");
    for (const key of ["feeRate","exerciseFeeRate","feeCap"]) if (!(s[key] >= 0 && s[key] <= 1)) issues.push("手续费设置须在0%至100%之间。");
    if (!(s.stressElapsedDays >= 0) || s.stressElapsedDays > 730) issues.push("压力测试经过天数无效。");
    if (s.stressVols !== undefined && (!Array.isArray(s.stressVols) || !s.stressVols.length || s.stressVols.length > 6 || s.stressVols.some(v => !Number.isFinite(num(v)) || !(num(v) >= 0 && num(v) <= 5)))) issues.push("压力IV须在0%至500%之间，最多6个情景。");
    if (!Array.isArray(s.stressMoves) || !s.stressMoves.length || s.stressMoves.length > 9 || s.stressMoves.some(v => !Number.isFinite(num(v)) || !(num(v) > -1 && num(v) <= 5))) issues.push("压力价格变化区间无效。");
    s.stressMoves = Array.isArray(s.stressMoves) ? s.stressMoves.map(num) : [];
    if (Array.isArray(s.stressVols)) s.stressVols = s.stressVols.map(num);
    return {settings: s, issues};
  }

  function rules(row) {
    const names = ["initial_margin_rate","min_initial_margin_rate","maintenance_margin_rate","min_maintenance_margin_rate","liquidation_fee_rate","quantity_step","min_qty","max_qty"];
    const r = {};
    for (const name of names) {r[name] = num(row[name]); if (r[name] === null) throw new RangeError("合约保证金/数量规则缺失，等待目录核验");}
    for (const name of names.slice(0,5)) if (r[name] < 0 || r[name] > 1) throw new RangeError("合约保证金费率异常");
    if (!(r.quantity_step > 0) || !(r.min_qty > 0) || r.max_qty < r.min_qty || r.initial_margin_rate < r.min_initial_margin_rate || r.maintenance_margin_rate < r.min_maintenance_margin_rate) throw new RangeError("合约数量或保证金规则异常");
    if (r.min_initial_margin_rate <= 0) throw new RangeError("缺少有效的最低初始保证金率");
    return r;
  }
  function floorStep(value, step) {
    if (!Number.isFinite(value) || value < 0 || !(step > 0)) return 0;
    const parts = String(step).toLowerCase().split("e");
    const digits = Math.max(0, Math.min(12, (parts[0].split(".")[1] ?? "").length - Number(parts[1] ?? 0)));
    return Number((Math.floor(value / step + 1e-10) * step).toFixed(digits));
  }
  function freshField(row, field, now) {
    const at = stamp(row.field_updated_at?.[field] ?? row.mark_updated_at), source = row.field_source?.[field] ?? row.mark_source;
    if (at === null || at <= 0 || at > now + 2000) return "标记价/IV更新时间未知或异常";
    if (now - at > (source === "websocket" ? 20000 : 30000)) return "标记价/IV已陈旧，仅可查看报价参考";
    return null;
  }
  function marginBase(spot, strike, rate, minimum, side = "PUT") {
    // Clearing Procedures 4.43 / 26 / 28: signed OTM is min(S-K,0)
    // for Calls and min(K-S,0) for Puts. Rates come from the catalog.
    const otm = Math.max(side === "CALL" ? strike - spot : spot - strike, 0);
    return Math.max(minimum * spot, rate * spot - otm);
  }
  function maintenance(spot, strike, mark, quantity, r, side = "PUT") {
    // Clearing Procedures 28 adds a liquidation-fee reserve to the FAQ base.
    return (marginBase(spot,strike,r.maintenance_margin_rate,r.min_maintenance_margin_rate,side) + mark + r.liquidation_fee_rate * spot) * quantity;
  }
  function stateFor(ratio) {return ratio >= .95 ? "liquidation" : ratio >= .8 ? "margin-call" : "normal";}
  function expiryCash(entry, settlement) {
    const value = intrinsic(settlement,entry.strike,entry.side ?? entry.row?.side ?? "PUT"), q = entry.metrics.quantity;
    const fee = Math.min(entry.settings.exerciseFeeRate * settlement, entry.settings.feeCap * value) * q;
    return {fee, pnl: entry.metrics.netPremium - value * q - fee};
  }
  function stressGrid(entry) {
    const {settings: s, metrics: m, row, spot, strike, days, tradingRules: r} = entry;
    const side = entry.side ?? row.side ?? "PUT", optionPrice = priceFor(side);
    const baseVol = num(row.mark_iv), years = days / 365;
    const vols = s.stressVols ?? [baseVol,Math.min(5,baseVol+.2),Math.min(5,baseVol+.6)];
    const baseTheory = optionPrice(spot,strike,years,baseVol), observedMark = num(row.mark_price);
    const output = [];
    for (const movePct of s.stressMoves) for (const vol of vols) {
      const futureSpot = checked(spot * (1 + movePct), "压力指数"), elapsedDays = Math.min(days,s.stressElapsedDays);
      const yearsLeft = Math.max(0,(days - elapsedDays) / 365), settled = yearsLeft === 0;
      let mark, pnl, closingFee, mm, ae, equity, ratio, state;
      if (settled) {
        mark = intrinsic(futureSpot,strike,side);
        const cash = expiryCash(entry,futureSpot);
        pnl = cash.pnl; closingFee = cash.fee;
        mm = 0; ae = s.balance + pnl; equity = ae; ratio = 0; state = "settled";
      } else {
        // Hold current mark/model basis constant and reprice changes only.
        mark = Math.max(intrinsic(futureSpot,strike,side), Math.min(side === "CALL" ? futureSpot : strike, observedMark + optionPrice(futureSpot,strike,yearsLeft,vol) - baseTheory));
        closingFee = totalFee(futureSpot,mark,m.quantity,s.feeRate,s.feeCap);
        pnl = m.netPremium - mark*m.quantity - closingFee;
        mm = maintenance(futureSpot,strike,mark,m.quantity,r,side);
        ae = m.adjustedEquity; equity = ae - mark*m.quantity;
        ratio = ae > 0 ? mm/ae : Infinity; state = stateFor(ratio);
      }
      output.push({movePct,vol,elapsedDays,spot:futureSpot,mark,pnl,closingFee,
        maintenanceMargin:mm,adjustedEquity:ae,equity,marginRatio:ratio,state,settled,
        note:settled ? "假设持有至结算；不保证到期前未被强平" : "标记价锚定的理论回购情景，非成交报价或精确强平价"});
    }
    return output;
  }
  function analyzeCandidate(snapshot, row, s, now, side = row?.side ?? "PUT") {
    const isCall = side === "CALL";
    const spot = num(snapshot?.btc_index_price), strike = num(row.strike_price), exp = expiry(row);
    const clock = now + (num(snapshot?.exchange_clock_offset_ms) ?? 0), days = (exp-clock)/DAY;
    const e = {row,side,symbol:row.symbol,expiryMs:exp,days,strike,strikeRatio:strike/spot,
      spot,settings:s,issue:null,warnings:[],metrics:null,stress:[]};
    try {
      if (!quoteChecks?.quoteIssue) throw new RangeError("行情核验模块不可用");
      if (!["PUT", "CALL"].includes(side) || row.side !== side) throw new RangeError("期权类型与试算方向不一致");
      if (isCall && s.quantityMode === "cashSecured") throw new RangeError("裸卖Call无有限足额赔付模式");
      const r = rules(row); e.tradingRules = r;
      let issue = quoteChecks.quoteIssue(snapshot,row,{direction:"SELL",quantity:r.min_qty},now);
      if (issue) throw new RangeError(issue);
      const catalogAt = stamp(snapshot.catalog_updated_at);
      if (catalogAt === null || catalogAt > now+2000 || now-catalogAt > 600000) throw new RangeError("合约规则核验过旧或时间未知");
      for (const field of ["mark_price","mark_iv"]) {issue = freshField(row,field,now); if (issue) throw new RangeError(issue);}
      const bid = num(row.bid_price), ask = num(row.ask_price), mark = num(row.mark_price), iv = num(row.mark_iv);
      if (!(ask >= bid) || !(mark >= 0) || mark > (isCall ? spot : strike) || !(iv > 0 && iv <= 5)) throw new RangeError("标记价、买卖报价或IV异常");
      if (isCall ? bid >= spot || ask > spot : bid >= strike || ask > strike) throw new RangeError(isCall ? "Call买卖报价越过现货价格上界，等待核验" : "Put买卖报价越过行权价上界，等待核验");
      const allowedBasis = Math.max((ask-bid)*2,Math.max(mark,bid,ask)*.05);
      if (mark < bid-allowedBasis || mark > ask+allowedBasis) throw new RangeError("买卖报价与标记价偏离过大，等待同步核验");
      const spreadPct = (ask-bid)/bid*100;
      if (spreadPct > s.maxSpreadPct + 1e-10) throw new RangeError("买卖价差超过筛选上限");
      const feePer = totalFee(spot,bid,1,s.feeRate,s.feeCap);
      const baseIM = marginBase(spot,strike,r.initial_margin_rate,r.min_initial_margin_rate,side);
      const orderPer = Math.max(0,baseIM+mark-bid) + feePer;
      if (!(orderPer > 0) || !Number.isFinite(orderPer)) throw new RangeError("开仓保证金无法可靠计算");
      if (!(baseIM+mark-bid > 0)) throw new RangeError("报价与标记价异常，开仓保证金核心项非正");
      const usable = s.balance-s.reserve, depth = floorStep(num(row.bid_quantity),r.quantity_step);
      const admissionTolerance = Math.max(1e-8,usable*1e-12);
      let maxMarginQuantity = floorStep(Math.min(r.max_qty,usable/orderPer),r.quantity_step);
      // Binance's initial-margin admission is strict >, not >=.
      if (maxMarginQuantity > 0 && maxMarginQuantity*orderPer >= usable-admissionTolerance) maxMarginQuantity = floorStep(maxMarginQuantity-r.quantity_step,r.quantity_step);
      const cashSecuredQuantity = isCall ? null : floorStep(Math.min(r.max_qty,usable/strike),r.quantity_step);
      let q = s.quantityMode === "maxMargin" ? Math.min(maxMarginQuantity,depth)
        : s.quantityMode === "cashSecured" ? Math.min(cashSecuredQuantity,depth) : s.quantity;
      q = checked(q,"数量");
      if (q < r.min_qty-1e-10) throw new RangeError("余额或买一深度不足最小开仓数量");
      if (Math.abs(q/r.quantity_step-Math.round(q/r.quantity_step)) > 1e-7) throw new RangeError("数量不符合合约步长");
      issue = quoteChecks.quoteIssue(snapshot,row,{direction:"SELL",quantity:q},now);
      if (issue) throw new RangeError(issue);
      if (q*orderPer >= usable-admissionTolerance) throw new RangeError("按所填余额与预留资金，开仓保证金不足");
      if (s.quantityMode === "maxMargin" && depth < maxMarginQuantity) e.warnings.push("数量受买一档深度限制，未假定更深档同价成交");
      const grossPremium=bid*q,entryFee=feePer*q,netPremium=grossPremium-entryFee;
      const orderMargin=orderPer*q,positionMargin=(baseIM+mark)*q;
      const adjustedEquity=s.balance+netPremium,equity=adjustedEquity-mark*q;
      const mm=maintenance(spot,strike,mark,q,r,side),marginRatio=adjustedEquity>0?mm/adjustedEquity:Infinity;
      const daily=(netPremium/s.balance)/days*100,orderDaily=(netPremium/orderMargin)/days*100,cashDaily=isCall ? null : (netPremium/(strike*q))/days*100;
      const greek = field => num(row[field]) === null ? null : -num(row[field])*q;
      e.metrics={quantity:q,grossPremium,entryFee,netPremium,orderMargin,positionMargin,maintenanceMargin:mm,
        adjustedEquity,equity,marginRatio,availableAfterEntry:adjustedEquity-positionMargin,
        maxMarginQuantity,cashSecuredQuantity,depthQuantity:depth,
        accountDailyPct:daily,accountAnnualPct:daily*365,orderDailyPct:orderDaily,orderAnnualPct:orderDaily*365,
        cashDailyPct:cashDaily,cashAnnualPct:isCall ? null : cashDaily*365,breakEven:null,maxExpiryLoss:isCall ? Infinity : strike*q-netPremium,
        notional:spot*q,cashSecuredCapital:isCall ? null : strike*q,entryDelta:greek("delta"),entryGamma:greek("gamma"),entryVega:greek("vega"),entryTheta:greek("theta"),spreadPct};
      if (isCall) {
        const notionalDaily=(netPremium/(spot*q))/days*100;
        Object.assign(e.metrics,{notionalCapital:spot*q,notionalDailyPct:notionalDaily,notionalAnnualPct:notionalDaily*365});
      }
      for (const [key,value] of Object.entries(e.metrics)) if (value !== null && !(isCall && key === "maxExpiryLoss" && value === Infinity) && !Number.isFinite(value)) throw new RangeError("金额或收益率超出可计算范围");
      if (isCall) {
        // Positive Call liability grows without bound; a finite cash balance
        // and the spot-notional return denominator do not cap that liability.
        e.metrics.lossUnbounded=true;
        e.metrics.capitalBasis="spot_notional_reference";
        let lo=strike,hi=checked(strike+netPremium/q,"盈亏平衡价");
        for (let i=0;i<70;i++) {const mid=(lo+hi)/2;if(expiryCash(e,mid).pnl>0)lo=mid;else hi=mid;}
        e.metrics.breakEven=(lo+hi)/2;
      } else {
        let lo=0,hi=strike;
        if (expiryCash(e,lo).pnl <= 0 && expiryCash(e,hi).pnl >= 0) {
          for (let i=0;i<70;i++) {const mid=(lo+hi)/2;if(expiryCash(e,mid).pnl<0)lo=mid;else hi=mid;}
          e.metrics.breakEven=(lo+hi)/2;
        }
      }
      if (isCall) e.warnings.push("裸卖Call到期理论亏损无上限；现货名义金额仅作收益率参考，不是现金足额赔付或USDT保证金");
      else if (e.metrics.maxExpiryLoss>s.balance) e.warnings.push("到期理论最大损失超过所填余额；保证金可开仓不等于最大损失限于余额");
      if (marginRatio>=.8) e.warnings.push("当前假设维持保证金比例已触及预警/强平条件");
      if (!s.stressVols && iv+.6>5) e.warnings.push("压力IV触及500%模型上限，未覆盖更高波动情景");
      e.stress=stressGrid(e);
      if(e.stress.some(point=>!Number.isFinite(point.pnl)||!Number.isFinite(point.mark)||!Number.isFinite(point.maintenanceMargin))) throw new RangeError("压力情景超出可计算范围");
    } catch(error) {e.issue=error instanceof RangeError?error.message:"计算暂不可用";e.metrics=null;e.stress=[];}
    return e;
  }
  function evaluate(snapshot, input = {}, now = Date.now(), side = input?.side ?? "PUT") {
    const normalized=normalizeSettings(input,side),s=normalized.settings;
    const result={rows:[],side,issues:normalized.issues,settings:s,valuationAt:now,spot:num(snapshot?.btc_index_price),
      note:"公开行情、空仓单笔、手工资金试算；收益为无赔付权利金折算；压力情景非概率预测或精确强平价"};
    if(!Number.isFinite(now)||!snapshot||!Array.isArray(snapshot.options)||!(result.spot>0)){result.issues.push("等待有效BTC公开行情");return result;}
    if(result.issues.length)return result;
    const clock=now+(num(snapshot.exchange_clock_offset_ms)??0);
    for(const row of snapshot.options){
      if(row.side!==side)continue;
      const days=(expiry(row)-clock)/DAY,ratio=num(row.strike_price)/result.spot;
      if(!(days>0)||days<s.minDays||days>s.maxDays||ratio<s.minStrikeRatio||ratio>s.maxStrikeRatio)continue;
      result.rows.push(analyzeCandidate(snapshot,row,s,now,side));
    }
    const worst=e=>e.stress.length?Math.min(...e.stress.map(point=>point.pnl)):-Infinity;
    result.rows.sort((a,b)=>{
      if(Boolean(a.metrics)!==Boolean(b.metrics))return a.metrics?-1:1;
      let primary=0;
      if(s.sort==="accountAnnual")primary=(b.metrics?.accountAnnualPct??-Infinity)-(a.metrics?.accountAnnualPct??-Infinity);
      else if(s.sort==="spread")primary=(a.metrics?.spreadPct??Infinity)-(b.metrics?.spreadPct??Infinity);
      else if(s.sort==="stress")primary=worst(b)-worst(a);
      else primary=Math.abs(a.days-15)-Math.abs(b.days-15);
      return (Number.isNaN(primary)?0:primary)||a.strike-b.strike||String(a.symbol).localeCompare(String(b.symbol));
    });
    return result;
  }
  const evaluateCall = (snapshot,input={},now=Date.now()) => evaluate(snapshot,input,now,"CALL");
  return Object.freeze({evaluate,evaluateCall,analyzeCandidate,putPrice,callPrice,stressGrid,expiryCash,floorStep,normalizeSettings,DEFAULTS,CALL_DEFAULTS});
});
