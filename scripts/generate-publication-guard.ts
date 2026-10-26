import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(
  new URL('../src/worker/db/publication_guard.sql', import.meta.url),
  'utf8',
);
const target = new URL('../src/worker/db/publication-guard.ts', import.meta.url);
const expected =
  '// Generated from publication_guard.sql; run scripts/generate-publication-guard.ts.\n// biome-ignore format: Generated exact SQL bytes.\nexport default ' +
  JSON.stringify(source) +
  ';\n';
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== expected)
    throw new Error('Generated publication guard is stale');
} else await writeFile(target, expected);
