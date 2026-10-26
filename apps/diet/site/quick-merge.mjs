import { mergeDays, validateDiary } from './lib.mjs';

const clone = value => structuredClone(value);

function fingerprint(value) {
  const ordered = current => {
    if (Array.isArray(current)) return current.map(ordered);
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.keys(current).sort().map(key => [key, ordered(current[key])]));
    }
    return current;
  };
  return JSON.stringify(ordered(value));
}

function uniqueItems(existing, incoming, ingestionId) {
  const used = new Set(existing.map(item => item.id).filter(Boolean));
  return incoming.map((item, index) => {
    const result = clone(item);
    const suggested = typeof result.id === 'string' && result.id ? result.id : `${ingestionId}-item-${index + 1}`;
    let id = suggested;
    if (used.has(id)) id = `${ingestionId}-${suggested}`;
    const base = id;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
    result.id = id;
    used.add(id);
    return result;
  });
}

function ingestionIds(meal, incomingId) {
  return [...new Set([...(Array.isArray(meal.ingestionIds) ? meal.ingestionIds : []), incomingId])].slice(-200);
}

/** Add a parsed meal to its existing card while keeping canonical data immutable. */
export function applyParsedMeals(canonicalDays, draftDays, incomingDays) {
  validateDiary({ schemaVersion: 1, days: incomingDays });
  const drafts = clone(draftDays);
  const changes = new Map();
  const dates = new Set();
  let mealCount = 0;
  const currentDays = mergeDays(canonicalDays, drafts);

  for (const incomingDay of incomingDays) {
    let currentDay = currentDays.find(day => day.date === incomingDay.date);
    for (const incomingMeal of incomingDay.meals) {
      // The parser's request-scoped ID survives retries; no ID prefix is assumed.
      if (currentDay?.meals.some(meal => meal.ingestionIds?.includes(incomingMeal.id))) continue;
      let draftDay = drafts.find(day => day.date === incomingDay.date);
      if (!draftDay) {
        const metadata = currentDay ?? incomingDay;
        draftDay = { ...clone(metadata), meals: [] };
        drafts.push(draftDay);
      }
      if (!currentDay) {
        currentDay = { ...clone(incomingDay), meals: [] };
        currentDays.push(currentDay);
      }

      const existing = currentDay.meals.find(meal => meal.type === incomingMeal.type && meal.status === incomingMeal.status);
      let next;
      if (existing) {
        const extraNote = incomingMeal.note?.trim();
        const supplement = extraNote ? `口述补充：${extraNote}` : '口述补充。';
        next = {
          ...clone(existing),
          items: [...clone(existing.items), ...uniqueItems(existing.items, incomingMeal.items, incomingMeal.id)],
          note: [existing.note, supplement].filter(Boolean).join('\n'),
          ingestionIds: ingestionIds(existing, incomingMeal.id)
        };
      } else {
        next = { ...clone(incomingMeal), items: uniqueItems([], incomingMeal.items, incomingMeal.id), ingestionIds: [incomingMeal.id] };
        // Preserve another card even if a caller supplies an overlapping meal ID.
        const base = next.id;
        for (let suffix = 2; currentDay.meals.some(meal => meal.id === next.id); suffix++) next.id = `${base}-${suffix}`;
      }

      const key = `${incomingDay.date}\u0000${next.id}`;
      if (!changes.has(key)) {
        const prior = draftDay.meals.find(meal => meal.id === next.id);
        changes.set(key, { date: incomingDay.date, id: next.id, priorDraftMeal: prior ? clone(prior) : null });
      }
      const draftIndex = draftDay.meals.findIndex(meal => meal.id === next.id);
      if (draftIndex < 0) draftDay.meals.push(next);
      else draftDay.meals[draftIndex] = next;
      const currentIndex = currentDay.meals.findIndex(meal => meal.id === next.id);
      if (currentIndex < 0) currentDay.meals.push(clone(next));
      else currentDay.meals[currentIndex] = clone(next);
      changes.get(key).afterFingerprint = fingerprint(next);
      dates.add(incomingDay.date);
      mealCount++;
    }
  }
  drafts.sort((a, b) => a.date.localeCompare(b.date));
  validateDiary({ schemaVersion: 1, days: mergeDays(canonicalDays, drafts) });
  return { drafts, undoToken: { changes: [...changes.values()] }, dates: [...dates].sort(), mealCount, alreadyApplied: mealCount === 0 && incomingDays.some(day => day.meals.length > 0) };
}

/** Undo only untouched cards, so edits made after parsing are never discarded. */
export function undoParsedMeals(canonicalDays, currentDraftDays, undoToken) {
  const drafts = clone(currentDraftDays);
  let removedCount = 0;
  let preservedCount = 0;
  for (const change of undoToken?.changes ?? []) {
    const day = drafts.find(entry => entry.date === change.date);
    const index = day?.meals.findIndex(meal => meal.id === change.id) ?? -1;
    if (index < 0 || fingerprint(day.meals[index]) !== change.afterFingerprint) {
      preservedCount++;
      continue;
    }
    if (change.priorDraftMeal === null) day.meals.splice(index, 1);
    else day.meals[index] = clone(change.priorDraftMeal);
    removedCount++;
    if (day.meals.length === 0) drafts.splice(drafts.indexOf(day), 1);
  }
  validateDiary({ schemaVersion: 1, days: mergeDays(canonicalDays, drafts) });
  return { drafts, removedCount, preservedCount };
}
