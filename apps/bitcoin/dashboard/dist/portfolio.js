/* Pure expiry PnL for a portfolio of stablecoin-settled vanilla options.
 * Quote premiums are per underlying unit, as documented by OptionPayoff.
 * Each leg has its own total fee; portfolio fees are an additional total cost.
 * Metrics cover every settlement S >= 0, including the unbounded Call tail.
 * Normalized quantity/unit stay decimal strings so exact input survives JSON.
 * This module has no network, account, order or pre-expiry valuation behavior.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./payoff.js"));
  else root.OptionPortfolio = factory(root.OptionPayoff);
})(typeof globalThis !== "undefined" ? globalThis : this, function (Payoff) {
  "use strict";
  if (!Payoff || typeof Payoff.validate !== "function") throw new Error("OptionPayoff must load before OptionPortfolio.");

  const ZERO = Object.freeze({coefficient: 0n, exponent: 0});
  const decimalPowers = new Map([[0, 1n]]);
  const preparedConfigs = new WeakMap();

  function numeric(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // User quantities have decimal semantics: 0.3 - 0.1 - 0.2 is exactly zero.
  // Keep integer decimal coefficients until the public numeric output. Unlike
  // an epsilon cutoff, this also retains a genuine 1e-100 net Call exposure.
  function powerOfTen(exponent) {
    if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 8192) throw new RangeError("组合十进制精度超出可计算范围。");
    if (!decimalPowers.has(exponent)) decimalPowers.set(exponent, 10n ** BigInt(exponent));
    return decimalPowers.get(exponent);
  }

  function normalizedDecimal(coefficient, exponent) {
    if (coefficient === 0n) return ZERO;
    while (coefficient % 10n === 0n) {coefficient /= 10n; exponent++;}
    return {coefficient, exponent};
  }

  function decimal(value) {
    let source = String(value).trim();
    let match = /^([+-]?)(\d*\.?\d+|\d+\.?)(?:e([+-]?\d+))?$/i.exec(source);
    // Preserve the existing numeric-input convention for e.g. "0x10".
    if (!match && numeric(value) !== null) {source = String(Number(value)); match = /^([+-]?)(\d*\.?\d+|\d+\.?)(?:e([+-]?\d+))?$/i.exec(source);}
    if (!match) throw new RangeError("请填写有效十进制计算参数。");
    const fractionalDigits = match[2].split(".")[1]?.length ?? 0;
    const digits = match[2].replace(".", "").replace(/^0+/, "") || "0";
    const exponent = Number(match[3] ?? 0) - fractionalDigits;
    if (digits.length > 2048 || !Number.isSafeInteger(exponent) || Math.abs(exponent) > 8192) throw new RangeError("组合十进制精度超出可计算范围。");
    return normalizedDecimal(BigInt(`${match[1] === "-" ? "-" : ""}${digits}`), exponent);
  }

  function decimalText(value) {return value.exponent === 0 ? String(value.coefficient) : `${value.coefficient}e${value.exponent}`;}
  function negated(value) {return value.coefficient === 0n ? ZERO : {coefficient: -value.coefficient, exponent: value.exponent};}
  function added(a, b) {
    if (a.coefficient === 0n) return b;
    if (b.coefficient === 0n) return a;
    const exponent = Math.min(a.exponent, b.exponent);
    return normalizedDecimal(a.coefficient * powerOfTen(a.exponent - exponent) + b.coefficient * powerOfTen(b.exponent - exponent), exponent);
  }
  function multiplied(a, b) {return normalizedDecimal(a.coefficient * b.coefficient, a.exponent + b.exponent);}
  function summed(values) {return values.reduce(added, ZERO);}
  function compared(a, b) {const difference = added(a, negated(b)).coefficient; return difference < 0n ? -1 : difference > 0n ? 1 : 0;}

  function asNumber(value) {
    const result = Number(decimalText(value));
    if (!Number.isFinite(result)) throw new RangeError("组合数值超出可计算范围。");
    if (result === 0 && value.coefficient !== 0n) throw new RangeError("组合非零数值小于可显示精度，请调整计算参数。");
    return result === 0 ? 0 : result;
  }

  function dividedAsNumber(numerator, denominator) {
    if (denominator.coefficient === 0n) throw new RangeError("组合盈亏平衡价无法计算。");
    if (numerator.coefficient === 0n) return 0;
    const negative = (numerator.coefficient < 0n) !== (denominator.coefficient < 0n);
    let top = numerator.coefficient < 0n ? -numerator.coefficient : numerator.coefficient;
    let bottom = denominator.coefficient < 0n ? -denominator.coefficient : denominator.coefficient;
    // Retain 40 significant decimal digits for the final rounded Number;
    // never divide separately rounded tiny coefficients or huge payouts.
    const shift = 40 + bottom.toString().length - top.toString().length;
    if (shift >= 0) top *= powerOfTen(shift); else bottom *= powerOfTen(-shift);
    const quotient = top / bottom;
    return asNumber(normalizedDecimal(negative ? -quotient : quotient, numerator.exponent - denominator.exponent - shift));
  }

  function detailsFor(config) {
    if (!preparedConfigs.has(config)) preparedConfigs.set(config, {
      fees: decimal(config.fees),
      legs: config.legs.map((leg) => {
        const exposure = multiplied(decimal(leg.quantity), decimal(leg.unit));
        return {type: leg.type, direction: leg.direction, strike: decimal(leg.strike), premium: decimal(leg.premium), fees: decimal(leg.fees), exposure, signedExposure: leg.direction === "BUY" ? exposure : negated(exposure)};
      })
    });
    return preparedConfigs.get(config);
  }

  function totals(config) {
    const details = detailsFor(config);
    const paid = [], received = [], signedPremium = [], fees = [details.fees];
    for (const leg of details.legs) {
      const payment = multiplied(leg.premium, leg.exposure);
      (leg.direction === "BUY" ? paid : received).push(payment);
      signedPremium.push(leg.direction === "BUY" ? negated(payment) : payment);
      fees.push(leg.fees);
    }
    return {premiumPaid: asNumber(summed(paid)), premiumReceived: asNumber(summed(received)), netPremium: asNumber(summed(signedPremium)), fees: asNumber(summed(fees))};
  }

  function strikesFor(config) { return Array.from(new Set(config.legs.map((leg) => leg.strike))).sort((a, b) => a - b); }

  // Right-hand slope on the interval starting at settlement. At a strike,
  // that strike's Call has switched on and its Put has switched off.
  function slopeAt(config, settlement) {
    const price = decimal(settlement);
    return summed(detailsFor(config).legs.map((leg) => {
      if (leg.type === "CALL") return compared(leg.strike, price) <= 0 ? leg.signedExposure : ZERO;
      return compared(leg.strike, price) > 0 ? negated(leg.signedExposure) : ZERO;
    }));
  }

  function validate(input) {
    const errors = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {valid: false, errors: [{field: "config", message: "请填写组合计算参数。"}], config: null};
    }
    const config = {legs: [], fees: numeric(input.fees)};
    if (config.fees === null || config.fees < 0) errors.push({field: "fees", message: "组合总费用须为非负有限数值。"});
    if (!Array.isArray(input.legs) || input.legs.length < 2) errors.push({field: "legs", message: "请至少选择两条期权组成组合。"});
    if (Array.isArray(input.legs)) {
      input.legs.forEach((leg, index) => {
        const checked = Payoff.validate(leg);
        if (checked.valid) {
          try {
            // Keep exact decimal input across validate -> metrics/pnl and JSON
            // round trips. The standalone single-leg API remains unchanged.
            checked.config.quantity = decimalText(decimal(leg.quantity));
            checked.config.unit = decimalText(decimal(leg.unit));
            config.legs.push(checked.config);
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            errors.push({field: `legs.${index}.quantity`, message: `第 ${index + 1} 条期权：${error.message}`});
          }
        }
        else checked.errors.forEach((error) => errors.push({field: `legs.${index}.${error.field}`, message: `第 ${index + 1} 条期权：${error.message}`}));
      });
    }
    if (!errors.length) {
      try {
        totals(config);
        // Reject overflow/underflow explicitly, rather than classifying a
        // nonrepresentable nonzero coefficient as a hedged position.
        for (const strike of [0, ...strikesFor(config)]) asNumber(slopeAt(config, strike));
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        errors.push({field: "config", message: error.message});
      }
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

  function evaluateAtKnot(config, settlement) {
    const price = decimal(settlement), details = detailsFor(config);
    return summed([...details.legs.map((leg) => {
      const difference = leg.type === "CALL" ? added(price, negated(leg.strike)) : added(leg.strike, negated(price));
      const intrinsic = difference.coefficient > 0n ? difference : ZERO;
      return added(multiplied(added(intrinsic, negated(leg.premium)), leg.signedExposure), negated(leg.fees));
    }), negated(details.fees)]);
  }

  function evaluate(config, exactSettlement) {
    // Each interval is linear. Anchor at its finite lower strike so offset
    // Call payouts do not erase a spread's finite net payment at huge S.
    // This is algebraically the sum of the legs, evaluated without first
    // rounding two enormous opposite payouts separately.
    let anchor = 0;
    for (const leg of config.legs) if (compared(decimal(leg.strike), exactSettlement) <= 0 && leg.strike > anchor) anchor = leg.strike;
    const atAnchor = evaluateAtKnot(config, anchor);
    if (compared(exactSettlement, decimal(anchor)) === 0) return asNumber(atAnchor);
    const movement = multiplied(slopeAt(config, anchor), added(exactSettlement, negated(decimal(anchor))));
    return asNumber(added(atAnchor, movement));
  }

  function pnl(input, settlement) {
    const config = checked(input);
    const price = numeric(settlement);
    if (price === null || price < 0) throw new RangeError("到期结算价须为非负有限数值。");
    return evaluate(config, decimal(settlement));
  }

  function nearPrice(a, b) {
    if (a === b) return true;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= 8 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
  }

  function opposing(a, b) {return (a.coefficient < 0n && b.coefficient > 0n) || (a.coefficient > 0n && b.coefficient < 0n);}

  function rootFrom(point, value, slope) {
    const root = dividedAsNumber(added(multiplied(decimal(point), slope), negated(value)), slope);
    if (!Number.isFinite(root)) throw new RangeError("组合盈亏平衡价超出可计算范围。");
    return root === 0 ? 0 : root;
  }

  function metrics(input) {
    const config = checked(input);
    const amounts = totals(config);
    const strikes = strikesFor(config);
    const points = [0, ...strikes];
    const exactValues = points.map((point) => evaluateAtKnot(config, point));
    const values = exactValues.map(asNumber);
    const slopes = points.map((point) => slopeAt(config, point));
    const exactTailSlope = slopes[slopes.length - 1];
    const tailSlope = asNumber(exactTailSlope);
    let pnlMin = Infinity, pnlMax = -Infinity;
    for (const value of values) {pnlMin = Math.min(pnlMin, value); pnlMax = Math.max(pnlMax, value);}
    if (exactTailSlope.coefficient > 0n) pnlMax = Infinity;
    else if (exactTailSlope.coefficient < 0n) pnlMin = -Infinity;

    const candidates = [], ranges = [];
    points.forEach((point, index) => {if (exactValues[index].coefficient === 0n) candidates.push(point);});
    for (let index = 0; index < points.length; index++) {
      const lo = points[index], hi = index + 1 < points.length ? points[index + 1] : Infinity;
      const value = exactValues[index], slope = slopes[index];
      if (slope.coefficient === 0n && value.coefficient === 0n) {
        const previous = ranges[ranges.length - 1];
        if (previous && (previous[1] === lo || nearPrice(previous[1], lo))) previous[1] = hi;
        else ranges.push([lo, hi]);
      } else if (hi === Infinity) {
        if (opposing(value, slope)) candidates.push(rootFrom(lo, value, slope));
      } else if (opposing(value, exactValues[index + 1])) {
        const root = rootFrom(lo, value, slope);
        if ((root >= lo || nearPrice(root, lo)) && (root <= hi || nearPrice(root, hi))) candidates.push(Math.min(hi, Math.max(lo, root)));
        else throw new RangeError("组合盈亏曲线超出可计算精度。");
      }
    }
    const breakEvens = [];
    for (const price of candidates.sort((a, b) => a - b)) {
      if (ranges.some(([lo, hi]) => (price >= lo || nearPrice(price, lo)) && (price <= hi || nearPrice(price, hi)))) continue;
      if (!breakEvens.length || !nearPrice(breakEvens[breakEvens.length - 1], price)) breakEvens.push(price);
    }
    return {
      ...amounts,
      pnlMin: pnlMin === 0 ? 0 : pnlMin,
      pnlMax: pnlMax === 0 ? 0 : pnlMax,
      maxProfit: Math.max(0, pnlMax),
      maxLoss: Math.max(0, -pnlMin),
      breakEvens,
      breakEvenRanges: ranges,
      strikes,
      tailSlope
    };
  }

  return Object.freeze({validate, pnl, metrics});
});
