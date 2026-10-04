// Mirrors sayr/data/out/*.json into web/public/data/ so the app serves exactly what the pipeline wrote.
// Stale copies that no longer exist upstream are removed; a missing or empty source stops the run.
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', 'data', 'out');
const dst = resolve(here, '..', 'public', 'data');

if (!existsSync(src)) {
  console.error(`sync-data: source folder not found: ${src}. Run \`python -m pipeline build\` in sayr/ first.`);
  process.exit(1);
}
const files = readdirSync(src).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error(`sync-data: no .json files in ${src}. Run \`python -m pipeline build\` in sayr/ first.`);
  process.exit(1);
}

mkdirSync(dst, { recursive: true });
for (const f of files) copyFileSync(join(src, f), join(dst, f));
const removed = readdirSync(dst).filter((f) => f.endsWith('.json') && !files.includes(f));
for (const f of removed) unlinkSync(join(dst, f));
console.log(`sync-data: ${files.length} files copied, ${removed.length} stale removed -> ${dst}`);
