// Fails when the gzipped size of all built JavaScript reaches the NFR14 budget (< 300 KB gz; ADR-0010, V47).
// Run after `vite build`; reads apps/web/dist/assets.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 300 * 1024;
const assets = fileURLToPath(new URL('../dist/assets', import.meta.url));

let files;
try {
  files = readdirSync(assets).filter((f) => f.endsWith('.js'));
} catch {
  console.error(`bundle budget: ${assets} not found; run the web build first`);
  process.exit(1);
}
if (files.length === 0) {
  console.error('bundle budget: no JavaScript assets found');
  process.exit(1);
}

let total = 0;
for (const f of files) {
  const gz = gzipSync(readFileSync(join(assets, f)), { level: 9 }).length;
  total += gz;
  console.log(`${f}\t${(gz / 1024).toFixed(1)} KB gz`);
}
const verdict = total < BUDGET_BYTES ? 'OK' : 'OVER BUDGET';
console.log(`total\t${(total / 1024).toFixed(1)} KB gz (budget < ${BUDGET_BYTES / 1024} KB) ${verdict}`);
if (total >= BUDGET_BYTES) process.exit(1);
