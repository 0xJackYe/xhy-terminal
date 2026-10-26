import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateDiary, validateDay, mergeDays } from '../site/lib.mjs';
const args = process.argv.slice(2);
const source = args[args.indexOf('--input') + 1];
if (!args.includes('--input') || !source) {
  console.error('用法：npm run record -- --input path/to/day.json'); process.exit(1);
}
try {
  const file = new URL('../data/diary.json', import.meta.url);
  const diary = validateDiary(JSON.parse(await readFile(file, 'utf8')));
  const input = JSON.parse(await readFile(resolve(source), 'utf8'));
  const incoming = input.schemaVersion ? validateDiary(input).days : [validateDay(input)];
  const next = { ...diary, updatedAt: new Date().toISOString(), days: mergeDays(diary.days, incoming) };
  validateDiary(next);
  const tmp = new URL('../data/diary.json.tmp', import.meta.url);
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n');
  await rename(tmp, file);
  console.log(`已合并 ${incoming.length} 天；同一餐食 ID 更新原记录，其他餐食保留。`);
} catch (error) { console.error(error.message); process.exit(1); }
