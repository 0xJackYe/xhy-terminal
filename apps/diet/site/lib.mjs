export const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'saturatedFat'];
export const MEALS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
// Diary days run on UTC+0, so the date changes at 08:00 Beijing time and a
// night shift that crosses Beijing midnight stays on one diary day.
export const DIARY_TIMEZONE = 'UTC';
export function today(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: DIARY_TIMEZONE }).format(now);
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value + 'T12:00:00Z'))
    && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}
export function estimate(food, amount) {
  return Object.fromEntries(NUTRIENTS.map(key => [key,
    food.per100[key] == null ? null : Math.round(food.per100[key] * amount) / 100
  ]));
}
export function nutritionTotal(items) {
  return Object.fromEntries(NUTRIENTS.map(key => [key,
    items.every(item => item.nutrition[key] != null)
      ? Math.round(items.reduce((sum, item) => sum + item.nutrition[key], 0) * 10) / 10
      : null
  ]));
}
export function dayTotal(day, status = 'eaten') {
  return nutritionTotal((day?.meals ?? []).filter(m => m.status === status).flatMap(m => m.items));
}
export function validateDay(day) {
  if (!day || !validDate(day.date)) throw new Error('日期须为有效的 YYYY-MM-DD。');
  if (typeof day.title !== 'string' || typeof day.note !== 'string') throw new Error('每天需要标题与备注。');
  if (!Array.isArray(day.meals) || day.meals.length > 30) throw new Error('每天的餐食数据无效。');
  const ids = new Set();
  for (const meal of day.meals) {
    if (!meal.id || typeof meal.id !== 'string' || ids.has(meal.id)) throw new Error('餐食 ID 不可重复。');
    ids.add(meal.id);
    if (!Object.hasOwn(MEALS, meal.type) || !['eaten', 'planned'].includes(meal.status)) throw new Error('餐次或食用状态无效。');
    if (typeof meal.title !== 'string' || !meal.title.trim()) throw new Error('餐食标题不能为空。');
    if (!Array.isArray(meal.items) || meal.items.length < 1 || meal.items.length > 50) throw new Error('每餐至少需要一个食材，最多50个。');
    for (const item of meal.items) {
      if (typeof item.name !== 'string' || !item.name.trim() || !['g', 'ml'].includes(item.unit)
        || !Number.isFinite(item.amount) || item.amount <= 0 || item.amount > 10000) throw new Error('食材名称、份量或单位无效。');
      if (!item.nutrition || !Number.isFinite(item.nutrition.kcal)) throw new Error('食材必须有热量估算。');
      for (const key of NUTRIENTS) {
        const n = item.nutrition[key];
        if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100000)) throw new Error('营养值须为非负数字，未知值用 null。');
      }
    }
  }
  return day;
}
export function validateDiary(diary) {
  if (!diary || diary.schemaVersion !== 1 || !Array.isArray(diary.days) || diary.days.length > 10000) throw new Error('不是受支持的食光日记文件。');
  const dates = new Set();
  diary.days.forEach(day => {
    validateDay(day);
    if (dates.has(day.date)) throw new Error('日期不可重复，请合并同一天的餐食。');
    dates.add(day.date);
  });
  return diary;
}
export function mergeDays(existing, incoming) {
  const days = new Map(existing.map(day => [day.date, structuredClone(day)]));
  for (const day of incoming) {
    validateDay(day);
    const previous = days.get(day.date);
    if (!previous) { days.set(day.date, structuredClone(day)); continue; }
    const meals = new Map(previous.meals.map(meal => [meal.id, meal]));
    day.meals.forEach(meal => meals.set(meal.id, structuredClone(meal)));
    days.set(day.date, { ...previous, ...day, meals: [...meals.values()] });
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
