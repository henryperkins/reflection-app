import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateSchemas } from '../checks/generate-openapi.ts';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const mirrors = {
  'docs/architecture/DOMAIN_CONTRACTS.ts': 'src/contracts/index.ts',
  'docs/architecture/schema.sql': 'src/worker/db/migrations/0001.sql',
  'docs/architecture/publication_guard.sql': 'src/worker/db/publication_guard.sql',
  'docs/architecture/COLUMN_REGISTRY.json': 'src/worker/db/column-registry.json',
} as const;

export function expectedArtifacts(root = projectRoot): Record<string, string> {
  const artifacts = generateSchemas();
  for (const [target, source] of Object.entries(mirrors)) {
    artifacts[target] = readFileSync(resolve(root, source), 'utf8');
  }
  const migrationDirectory = resolve(root, 'src/worker/db/migrations');
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (migrations.length === 0) throw new Error('No migrations found');
  artifacts['docs/architecture/schema.sql'] = migrations
    .map((name) => readFileSync(resolve(migrationDirectory, name), 'utf8'))
    .join('\n');
  return artifacts;
}

export function checkArtifacts(root = projectRoot): string[] {
  return Object.entries(expectedArtifacts(root)).flatMap(([target, expected]) => {
    try {
      return readFileSync(resolve(root, target), 'utf8') === expected ? [] : [target];
    } catch {
      return [target];
    }
  });
}

export function writeArtifacts(root = projectRoot): void {
  for (const [target, value] of Object.entries(expectedArtifacts(root))) {
    writeFileSync(resolve(root, target), value);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) {
    const drift = checkArtifacts();
    if (drift.length)
      throw new Error(
        `Generated artifacts drifted: ${drift.join(', ')}. Review source changes, then run npm run schemas.`,
      );
    console.log('All six generated schemas/source projections match their authorities.');
  } else {
    writeArtifacts();
    console.log('Generated six schema/source projections.');
  }
}
