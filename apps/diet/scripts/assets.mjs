import { readFile, readdir } from 'node:fs/promises';
export async function loadAssets() {
  const assets = {};
  for (const directory of ['site', 'data']) {
    for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(html|css|js|mjs|json|svg)$/.test(entry.name)) continue;
      const path = `${directory === 'data' ? '/data' : ''}/${entry.name}`;
      assets[path] = await readFile(new URL(`../${directory}/${entry.name}`, import.meta.url), 'utf8');
    }
  }
  return assets;
}
export function recipeContext(diary) {
  const unique = new Map();
  for (const day of diary.days) {
    for (const meal of day.meals) {
      const items = meal.items.filter(item => item.foodId !== 'egg-boiled' || !meal.title.includes('燕麦'));
      const title = meal.title.includes('燕麦') ? '燕麦水果坚果牛奶碗（不含另吃的鸡蛋）' : meal.title;
      const signature = JSON.stringify(items.map(({ foodId, amount, unit }) => ({ foodId, amount, unit })));
      unique.set(signature, { title, items });
    }
  }
  return [...unique.values()];
}
