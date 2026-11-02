"use strict";

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.XHYWorkSchedule = factory();
})(typeof window === "object" ? window : globalThis, function () {
  const TIME_ZONE = "America/Denver", DAY = 86400000;
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = (instant) => Object.fromEntries(formatter.formatToParts(instant)
    .filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const civilTime = (value) => Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
  const workday = (day) => day >= 1 && day <= 5;

  // Convert the target day's local hour using that day's offset. Weekday
  // 09:00 and 17:00 are unique instants, including across DST weekends.
  function localHour(civilDate, hour) {
    const target = civilDate + hour * 3600000;
    let instant = target;
    for (let attempt = 0; attempt < 4; attempt++) {
      const adjustment = target - civilTime(parts(instant));
      if (!adjustment) return instant;
      instant += adjustment;
    }
    throw new RangeError("Unable to resolve Denver work time");
  }

  function scheduleAt(now = new Date()) {
    const instant = now instanceof Date ? now.getTime() : now;
    if (!Number.isFinite(instant)) throw new TypeError("Invalid schedule time");
    const local = parts(instant), civilDate = Date.UTC(local.year, local.month - 1, local.day);
    const weekday = new Date(civilDate).getUTCDay();
    const seconds = local.hour * 3600 + local.minute * 60 + local.second;
    const working = workday(weekday) && seconds >= 9 * 3600 && seconds < 17 * 3600;
    let nextDate = civilDate;
    if (!working) {
      if (seconds >= 9 * 3600) nextDate += DAY;
      while (!workday(new Date(nextDate).getUTCDay())) nextDate += DAY;
    }
    const nextChangeAt = localHour(nextDate, working ? 17 : 9);
    return {
      timeZone: TIME_ZONE, working, weekday,
      label: working ? "工作中" : workday(weekday) ? "休息时间" : "周末",
      nextChangeAt, remainingSeconds: Math.max(0, Math.ceil((nextChangeAt - instant) / 1000)),
    };
  }

  return { TIME_ZONE, scheduleAt };
});
