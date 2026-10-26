/* Pure expiry PnL for a single stablecoin-settled vanilla option.
 * premium: USDT price per underlying BTC, not an already aggregated payment.
 * The dashboard uses BTC contracts with official unit=1. A different API's
 * per-contract quote must be converted to per-underlying-unit input first;
 * this module does not infer another contract's premium convention.
 * quantity: number of contracts; unit: underlying units per contract.
 * fees: user-entered total USDT cost, subtracted once from every scenario.
 * Settlement domain is finite S >= 0; no pre-expiry option valuation is used.
 * This module performs no network requests, account access or order actions.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OptionPayoff = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LABELS = {strike: "行权价", premium: "权利金价格", quantity: "合约数量", unit: "合约乘数", fees: "总费用"};

  function numeric(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  /** Return {valid, errors:[{field,message}], config: normalized copy|null}.
   * Blank/zero premium is not a usable quote. Booleans/objects are not numbers.
   * All five numeric inputs are required, including fees (which may be zero).
   */
  function validate(input) {
    const errors = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {valid: false, errors: [{field: "config", message: "请填写期权计算参数。"}], config: null};
    }
    if (input.type !== "CALL" && input.type !== "PUT") errors.push({field: "type", message: "请选择 Call 或 Put。"});
    if (input.direction !== "BUY" && input.direction !== "SELL") errors.push({field: "direction", message: "请选择买入或卖出。"});
    const config = {type: input.type, direction: input.direction};
    for (const field of ["strike", "premium", "quantity", "unit", "fees"]) {
      const value = numeric(input[field]);
      const valid = value !== null && (field === "fees" ? value >= 0 : value > 0);
      if (!valid) errors.push({field, message: `${LABELS[field]}须为${field === "fees" ? "非负" : "大于零的"}有限数值。`});
      else config[field] = value;
    }
    if (!errors.length) {
      const exposure = config.quantity * config.unit;
      const premiumTotal = config.premium * exposure;
      if (!Number.isFinite(exposure) || exposure <= 0) errors.push({field: "quantity", message: "数量与合约乘数的乘积超出可计算范围。"});
      else if (!Number.isFinite(premiumTotal) || premiumTotal <= 0 || !Number.isFinite(premiumTotal + config.fees)) errors.push({field: "premium", message: "总权利金与费用超出可计算范围。"});
      else if (!Number.isFinite(config.strike * exposure + config.fees) || !Number.isFinite(config.fees / exposure) || !Number.isFinite(config.strike + config.premium + config.fees / exposure)) errors.push({field: "strike", message: "价格与数量组合超出可计算范围。"});
    }
    return {valid: errors.length === 0, errors, config: errors.length ? null : config};
  }

  function checked(input) {
    const result = validate(input);
    if (!result.valid) {
      const error = new RangeError(result.errors.map((item) => item.message).join(" "));
      error.fields = result.errors;
      throw error;
    }
    return result.config;
  }

  function evaluate(config, settlement) {
    const intrinsic = Math.max(config.type === "CALL" ? settlement - config.strike : config.strike - settlement, 0);
    const sign = config.direction === "BUY" ? 1 : -1;
    return sign * (intrinsic - config.premium) * (config.quantity * config.unit) - config.fees;
  }

  /** Return signed net expiry PnL in USDT. Throws RangeError for invalid input. */
  function pnl(input, settlement) {
    const config = checked(input);
    const price = numeric(settlement);
    if (price === null || price < 0) throw new RangeError("到期结算价须为非负有限数值。");
    const result = evaluate(config, price);
    if (!Number.isFinite(result)) throw new RangeError("此结算价的盈亏超出可计算范围。");
    return result === 0 ? 0 : result;
  }

  /** Return net-PnL extrema over all S >= 0 (USDT), not chart-window extrema.
   * exposure: quantity * unit, in underlying units (BTC for BTC options).
   * premiumTotal: premium * exposure, gross paid/received premium in USDT.
   * pnlMin/pnlMax: signed mathematical lower/upper net-PnL bounds.
   * maxProfit/maxLoss: nonnegative attainable-profit/loss magnitudes; Infinity
   * means unbounded. When every scenario loses, maxProfit is 0 and pnlMax < 0.
   * breakEven: unique zero-PnL settlement price, or strike for a flat zero band;
   * null only when no nonnegative settlement yields zero net PnL.
   * breakEvenRange: [price,price] for a unique root, [lo,hi] for a flat band,
   * null when no root exists; hi may be Infinity for a fee-neutral short Put.
   */
  function metrics(input) {
    const config = checked(input);
    const exposure = config.quantity * config.unit;
    const premiumTotal = config.premium * exposure;
    const buy = config.direction === "BUY";
    const isCall = config.type === "CALL";
    const flat = (buy ? -premiumTotal : premiumTotal) - config.fees;
    const atZero = (buy ? 1 : -1) * (config.strike - config.premium) * exposure - config.fees;
    const pnlMin = isCall ? (buy ? flat : -Infinity) : (buy ? flat : atZero);
    const pnlMax = isCall ? (buy ? Infinity : flat) : (buy ? atZero : flat);

    // Divide only the fee, not an already multiplied premium: e.g. 0.1 * 3
    // then / 3 would move an exact Put S=0 root outside the nonnegative domain.
    const requiredIntrinsic = buy ? config.premium + config.fees / exposure : (flat === 0 ? 0 : config.premium - config.fees / exposure);
    let breakEven = null, breakEvenRange = null;
    if (requiredIntrinsic === 0) {
      breakEven = config.strike;
      breakEvenRange = isCall ? [0, config.strike] : [config.strike, Infinity];
    } else if (!isCall && atZero === 0) {
      breakEven = 0;
      breakEvenRange = [0, 0];
    } else if (requiredIntrinsic > 0 && (isCall || requiredIntrinsic <= config.strike)) {
      breakEven = isCall ? config.strike + requiredIntrinsic : config.strike - requiredIntrinsic;
      // Canonicalize -0 at the S=0 boundary.
      if (breakEven === 0) breakEven = 0;
      breakEvenRange = [breakEven, breakEven];
    }
    return {
      exposure,
      premiumTotal,
      breakEven,
      breakEvenRange,
      maxProfit: Math.max(0, pnlMax),
      maxLoss: Math.max(0, -pnlMin),
      pnlMin: pnlMin === 0 ? 0 : pnlMin,
      pnlMax: pnlMax === 0 ? 0 : pnlMax
    };
  }

  return Object.freeze({validate, pnl, metrics});
});
