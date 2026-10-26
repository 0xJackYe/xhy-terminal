import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateSnapshot, buildHistory } from './core.mjs';

const snapshotPath = new URL('../data/bitcoin-balance-snapshot.json', import.meta.url);
const fxPath = new URL('../data/bitcoin-cny-rates.json', import.meta.url);
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
snapshot.fx = JSON.parse(await readFile(fxPath, 'utf8'));
validateSnapshot(snapshot, snapshot.address);
const history = buildHistory(snapshot, snapshot.address);
const template = await readFile(new URL('./wallet.template.html', import.meta.url), 'utf8');
const core = (await readFile(new URL('./core.mjs', import.meta.url), 'utf8')).replace(/^export\s+/gm, '');
const html = template.replace('/* __BALANCE_CORE__ */', () => core)
  .replace('__SNAPSHOT_JSON__', () => JSON.stringify(snapshot).replace(/</g, '\\u003c'));
if (html.includes('/* __BALANCE_CORE__ */') || html.includes('__SNAPSHOT_JSON__')) {
  throw new Error('The wallet template was not fully rendered.');
}
const target = new URL('./wallet.html', import.meta.url);
await writeFile(target, html, 'utf8');
console.log(JSON.stringify({ file: fileURLToPath(target), transactions: history.transactions.length,
  points: history.points.length, fetchedAt: snapshot.fetchedAt }));
