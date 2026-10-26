import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ignored = new Set([
  'node_modules',
  '.git',
  '.superpowers',
  '.wrangler',
  'dist',
  'artifacts',
  '__pycache__',
]);

export function sourceDigest(root: string, additionalIgnored: readonly string[] = []): string {
  const digest = createHash('sha256');
  function visit(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        ignored.has(entry.name) ||
        additionalIgnored.includes(entry.name) ||
        entry.name.startsWith('.env') ||
        entry.name.startsWith('.dev.vars')
      )
        continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        digest
          .update(path)
          .update('\0')
          .update(readFileSync(join(root, path)))
          .update('\0');
    }
  }
  visit('');
  return digest.digest('hex');
}
