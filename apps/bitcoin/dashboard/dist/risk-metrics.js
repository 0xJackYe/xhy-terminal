(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OptionRisk = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Exact terminal-payoff accounting, followed by one common assumed GBM
  // distribution. IV/Delta are not interpreted as physical probabilities.
  var SQRT2 = Math.sqrt(2);
  var ERF_T = [9.604973739870516, 90.02601972038427, 2232.005345946843, 7003.325141128051, 55592.3013010395];
  var ERF_U = [33.56171416475031, 521.3579497801527, 4594.323829709801, 22629.000061389095, 49267.39426086359];
  var ERFC_P = [2.461969814735305e-10, .5641895648310688, 7.463210564422699, 48.63719709856814, 196.5208329560771, 526.4451949954773, 934.5285271719576, 1027.5518868951572, 557.5353353693993];
  var ERFC_Q = [13.228195115474499, 86.70721408859897, 354.9377788878199, 975.7085017432055, 1823.9091668790974, 2246.3376081871097, 1656.6630919416134, 557.5353408177277];
  var ERFC_R = [.5641895835477551, 1.275366707599781, 5.019050422511805, 6.160210979930536, 7.4097426995044895, 2.9788666537210024];
  var ERFC_S = [2.2605286322011726, 9.396035249380014, 12.048953980809666, 17.08144507475659, 9.608968090632859, 3.369076451000815];

  function polevl(x, coefficients) {
    return coefficients.reduce(function (value, next) { return value * x + next; }, 0);
  }
  function p1evl(x, coefficients) {
    return coefficients.reduce(function (value, next) { return value * x + next; }, 1);
  }
  // Cephes rational approximations preserve the small survival probability;
  // subtracting a CDF rounded to one would destroy remote-option tail estimates.
  function erfc(x) {
    if (x < 0) return 2 - erfc(-x);
    if (x < 1) return 1 - x * polevl(x * x, ERF_T) / p1evl(x * x, ERF_U);
    if (x > 27.3) return 0;
    var ratio = x < 8 ? polevl(x, ERFC_P) / p1evl(x, ERFC_Q) : polevl(x, ERFC_R) / p1evl(x, ERFC_S);
    return Math.exp(-x * x) * ratio;
  }
  function normalCdf(z) { return .5 * erfc(-z / SQRT2); }
  function normalSurvival(z) { return .5 * erfc(z / SQRT2); }
  function normalInterval(low, high) {
    if (!(high > low)) return 0;
    return Math.max(0, low >= 0 ? normalSurvival(low) - normalSurvival(high) : normalCdf(high) - normalCdf(low));
  }
  function finite(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(name + " must be a finite number");
    return value;
  }
  function number(input, key, fallback, minimum, inclusive) {
    var value = input[key] === undefined ? fallback : input[key];
    finite(value, key);
    if (inclusive ? value < minimum : value <= minimum) throw new RangeError(key + " is outside its valid range");
    return value;
  }
  function checked(value, name) {
    if (!Number.isFinite(value)) throw new RangeError(name + " exceeds the supported numeric range");
    return value === 0 ? 0 : value;
  }
  function prepare(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("option parameters must be an object");
    var type = typeof input.type === "string" ? input.type.toUpperCase() : "";
    var direction = typeof input.direction === "string" ? input.direction.toUpperCase() : "";
    if (type === "C") type = "CALL";
    if (type === "P") type = "PUT";
    if (direction === "LONG") direction = "BUY";
    if (direction === "SHORT") direction = "SELL";
    if (type !== "CALL" && type !== "PUT") throw new RangeError("type must be CALL or PUT");
    if (direction !== "BUY" && direction !== "SELL") throw new RangeError("direction must be BUY or SELL");
    var p = {
      type: type, direction: direction,
      strike: number(input, "strike", undefined, 0, false),
      premium: number(input, "premium", undefined, 0, true),
      quantity: number(input, "quantity", 1, 0, false),
      unit: number(input, "unit", 1, 0, false),
      spot: number(input, "spot", undefined, 0, false),
      years: number(input, "years", undefined, 0, false),
      annualVol: number(input, "annualVol", .6, 0, true),
      annualDrift: input.annualDrift === undefined ? 0 : finite(input.annualDrift, "annualDrift"),
      additionalFees: number(input, "additionalFees", 0, 0, true),
      feeEntryRate: number(input, "feeEntryRate", .00024, 0, true),
      feeExerciseRate: number(input, "feeExerciseRate", .00015, 0, true),
      feeCap: number(input, "feeCap", .1, 0, true)
    };
    ["feeEntryRate", "feeExerciseRate", "feeCap"].forEach(function (key) {
      if (p[key] > 1) throw new RangeError(key + " cannot exceed one");
    });
    p.scale = checked(p.quantity * p.unit, "quantity times unit");
    if (p.scale <= 0) throw new RangeError("quantity times unit underflows");
    p.sign = p.direction === "BUY" ? 1 : -1;
    p.entryFeePerUnit = Math.min(checked(p.feeEntryRate * p.spot, "entry fee"), checked(p.feeCap * p.premium, "premium fee cap"));
    p.constant = checked(-p.sign * p.premium - p.entryFeePerUnit - p.additionalFees / p.scale, "net premium");
    checked(p.premium * p.scale, "total premium");
    checked(p.strike * p.scale, "strike exposure");
    checked(p.spot * p.scale, "spot exposure");
    checked(p.entryFeePerUnit * p.scale, "total entry fee");
    checked(p.constant * p.scale, "total net premium");
    var variance = checked(p.annualVol * p.annualVol * p.years, "model variance");
    var drift = checked(p.annualDrift * p.years, "model drift");
    // Outside this very broad domain, double precision cannot reliably retain
    // both lognormal tails and their first moments. Reject instead of ranking.
    if (variance > 400 || Math.abs(drift) > 100) throw new RangeError("model variance or cumulative drift is outside the supported numeric range");
    p.v = Math.sqrt(variance);
    p.m = checked(Math.log(p.spot) + drift - variance / 2, "model log price");
    p.mean = checked(p.spot * Math.exp(drift), "model mean price");
    checked(p.mean * p.scale, "total model exposure");
    return p;
  }
  function intrinsic(p, settlement) {
    return Math.max(p.type === "CALL" ? settlement - p.strike : p.strike - settlement, 0);
  }
  function payoff(p, settlement) {
    var exercise = intrinsic(p, settlement);
    var fee = Math.min(p.feeExerciseRate * settlement, p.feeCap * exercise);
    return checked((p.constant + p.sign * exercise - fee) * p.scale, "settlement payoff");
  }
  function segments(p) {
    var knots = [0, p.strike];
    var crossing;
    if (p.type === "PUT" && p.feeExerciseRate + p.feeCap > 0) crossing = p.strike * (p.feeCap / (p.feeExerciseRate + p.feeCap));
    if (p.type === "CALL" && p.feeCap > p.feeExerciseRate) crossing = p.strike / (1 - p.feeExerciseRate / p.feeCap);
    if (crossing !== undefined && !Number.isFinite(crossing)) throw new RangeError("exercise fee crossover exceeds the supported numeric range");
    if (crossing > 0 && Number.isFinite(crossing)) knots.push(crossing);
    knots = knots.filter(function (value, index, values) { return values.indexOf(value) === index; }).sort(function (a, b) { return a - b; });
    var result = [];
    for (var index = 0; index < knots.length; index++) {
      var low = knots[index], high = index + 1 < knots.length ? knots[index + 1] : Infinity;
      var active = p.type === "CALL" ? low >= p.strike : high <= p.strike;
      var a = 0, b = p.constant;
      if (active) {
        var intrinsicSlope = p.type === "CALL" ? 1 : -1;
        var intrinsicConstant = -intrinsicSlope * p.strike;
        a += p.sign * intrinsicSlope;
        b += p.sign * intrinsicConstant;
        var usesSpotFee = p.type === "PUT" ? high <= (crossing || 0) : p.feeCap > p.feeExerciseRate && low >= crossing;
        if (p.feeExerciseRate === 0 || p.feeCap === 0) usesSpotFee = p.feeExerciseRate === 0;
        if (usesSpotFee) a -= p.feeExerciseRate;
        else { a -= p.feeCap * intrinsicSlope; b -= p.feeCap * intrinsicConstant; }
      }
      result.push({low: low, high: high, a: a, b: b});
    }
    return result;
  }
  function distribution(p) {
    function z(value) { return value <= 0 ? -Infinity : value === Infinity ? Infinity : (Math.log(value) - p.m) / p.v; }
    function probability(low, high) { return normalInterval(z(low), z(high)); }
    function firstMoment(low, high) { return p.mean * normalInterval(z(low) - p.v, z(high) - p.v); }
    return {probability: probability, firstMoment: firstMoment};
  }
  function clippedInterval(segment, low, high, positive) {
    low = Math.max(segment.low, low);
    high = Math.min(segment.high, high);
    if (!(high > low)) return null;
    if (segment.a === 0) return (positive ? segment.b > 0 : segment.b < 0) ? [low, high] : null;
    var root = -segment.b / segment.a;
    if ((segment.a > 0) === positive) low = Math.max(low, root);
    else high = Math.min(high, root);
    return high > low ? [low, high] : null;
  }
  function model(p, pieces) {
    var metadata = {distribution: "GBM", annualVol: p.annualVol, annualDrift: p.annualDrift, years: p.years,
      lossConvention: "positive_loss_max_minus_pnl_zero", probabilityUnit: "fraction", assumptionOnly: true};
    if (p.v === 0) {
      var pnl = payoff(p, p.mean), loss = Math.max(-pnl, 0);
      return Object.assign(metadata, {expectedPnl: pnl, profitProbability: pnl > 0 ? 1 : 0, lossProbability: pnl < 0 ? 1 : 0,
        zeroProbability: pnl === 0 ? 1 : 0, var95: loss, es95: loss, var99: loss, es99: loss});
    }
    var dist = distribution(p), expected = 0, win = 0, lose = 0, zero = 0;
    pieces.forEach(function (piece) {
      expected += piece.a * dist.firstMoment(piece.low, piece.high) + piece.b * dist.probability(piece.low, piece.high);
      var gains = clippedInterval(piece, 0, Infinity, true), losses = clippedInterval(piece, 0, Infinity, false);
      if (gains) win += dist.probability(gains[0], gains[1]);
      if (losses) lose += dist.probability(losses[0], losses[1]);
      if (piece.a === 0 && piece.b === 0) zero += dist.probability(piece.low, piece.high);
    });
    var result = Object.assign(metadata, {expectedPnl: checked(expected * p.scale, "expected payoff"),
      profitProbability: Math.min(1, win), lossProbability: Math.min(1, lose), zeroProbability: Math.min(1, zero)});
    // Payoff is monotonic for fee rates/caps in [0,1]. Its adverse price tail
    // therefore equals the worst P&L tail, including any zero-loss plateau.
    var increasing = (p.type === "CALL") === (p.direction === "BUY");
    [[.05, "95", 1.6448536269514722], [.01, "99", 2.3263478740408408]].forEach(function (item) {
      var tail = item[0], label = item[1], z = increasing ? -item[2] : item[2];
      var quantile = checked(Math.exp(p.m + p.v * z), "tail settlement price");
      var low = increasing ? 0 : quantile, high = increasing ? quantile : Infinity;
      var tailLoss = 0;
      pieces.forEach(function (piece) {
        var interval = clippedInterval(piece, low, high, false);
        if (interval) tailLoss -= piece.a * dist.firstMoment(interval[0], interval[1]) + piece.b * dist.probability(interval[0], interval[1]);
      });
      result["var" + label] = Math.max(0, -payoff(p, quantile));
      result["es" + label] = checked(Math.max(0, tailLoss * p.scale / tail), "expected shortfall");
    });
    return result;
  }
  function breakevens(p, pieces) {
    var roots = [], ranges = [];
    pieces.forEach(function (piece) {
      if (piece.a === 0) {
        if (piece.b === 0) ranges.push({lower: piece.low, upper: piece.high === Infinity ? null : piece.high, upperUnbounded: piece.high === Infinity});
        return;
      }
      var value = -piece.b / piece.a;
      if (value >= piece.low && value <= piece.high && Number.isFinite(value) && !roots.some(function (known) { return Math.abs(value - known) <= 1e-12 * Math.max(1, Math.abs(value)); })) roots.push(value);
    });
    return {breakEven: roots.length === 1 ? roots[0] : null, breakEvenRange: ranges.length ? ranges : null};
  }
  function analyze(input) {
    var p = prepare(input), pieces = segments(p), values = [payoff(p, 0)];
    pieces.forEach(function (piece) { if (piece.low > 0) values.push(payoff(p, piece.low)); });
    var last = pieces[pieces.length - 1];
    var profitUnbounded = last.a > 0, lossUnbounded = last.a < 0;
    var maxProfit = profitUnbounded ? null : Math.max(0, Math.max.apply(Math, values));
    var maxLoss = lossUnbounded ? null : Math.max(0, -Math.min.apply(Math, values));
    var breakEven = breakevens(p, pieces);
    var credit = checked(p.constant * p.scale, "net credit");
    var ratio = maxProfit !== null && maxLoss !== null && maxLoss > 0 ? checked(maxProfit / maxLoss, "reward/risk ratio") : null;
    // Simple averages of the maximum terminal gain, not a model expectation
    // or daily cash payment. A naked short Call has no known capital basis.
    var days = p.years * 365;
    var remainingDays = Number.isFinite(days) && days > 0 ? days : null;
    var dailyReturnBasis = p.direction === "BUY" ? "premium_paid" : p.type === "PUT" ? "cash_secured" : null;
    var capital = dailyReturnBasis === "cash_secured" ? p.strike * p.scale : dailyReturnBasis === "premium_paid" ? maxLoss : null;
    var dailyProfit = maxProfit !== null && remainingDays !== null ? maxProfit / remainingDays : null;
    var dailyReturn = maxProfit !== null && capital > 0 && remainingDays !== null ? maxProfit / capital / remainingDays * 100 : null;
    return {
      type: p.type, direction: p.direction, quantity: p.quantity, unit: p.unit,
      entryFee: p.entryFeePerUnit * p.scale, additionalFees: p.additionalFees, premiumTotal: p.premium * p.scale,
      maxProfit: maxProfit, maxLoss: maxLoss, profitUnbounded: profitUnbounded, lossUnbounded: lossUnbounded,
      rewardRiskRatio: ratio, breakEven: breakEven.breakEven, breakEvenRange: breakEven.breakEvenRange,
      cashReturnPct: p.type === "PUT" && p.direction === "SELL" ? checked(credit / (p.strike * p.scale) * 100, "cash return") : null,
      remainingDays: remainingDays,
      averageDailyMaxProfit: Number.isFinite(dailyProfit) ? dailyProfit : null,
      averageDailyReturnPct: Number.isFinite(dailyReturn) ? dailyReturn : null,
      dailyReturnBasis: dailyReturnBasis,
      scenarios: [-.1, -.2, -.3, .1, .2, .3].map(function (move) {
        var settlement = checked(p.spot * (1 + move), "scenario settlement");
        return {movePct: move, settlement: settlement, pnl: payoff(p, settlement)};
      }),
      model: model(p, pieces)
    };
  }
  return Object.freeze({analyze: analyze});
});
