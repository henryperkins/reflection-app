import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { checkArtifacts, projectRoot } from '../../scripts/schemas.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'reflection-gate-'));
  temporary.push(root);
  return root;
}

test('generated API drift fails without rewriting the edited artifact', () => {
  const root = temp();
  cpSync(join(projectRoot, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(projectRoot, 'docs/architecture'), join(root, 'docs/architecture'), {
    recursive: true,
  });
  expect(checkArtifacts(root)).toEqual([]);
  const path = join(root, 'docs/architecture/openapi.yaml');
  const changed = `${readFileSync(path, 'utf8')}\n# accidental manual change\n`;
  writeFileSync(path, changed);
  expect(checkArtifacts(root)).toEqual(['docs/architecture/openapi.yaml']);
  expect(readFileSync(path, 'utf8')).toBe(changed);
});

test('a new private column fails fixed field coverage instead of inventing policy', () => {
  const root = temp();
  const schema = join(root, 'migration.sql');
  writeFileSync(
    schema,
    `${readFileSync(join(projectRoot, 'src/worker/db/migrations/0001.sql'), 'utf8')}\nALTER TABLE reading_sessions ADD COLUMN private_note_enc TEXT;\n`,
  );
  expect(() =>
    execFileSync('python3', [join(projectRoot, 'scripts/check-registry.py'), '--schema', schema], {
      stdio: 'pipe',
    }),
  ).toThrow();
});

test('an encrypted field without an erasure policy fails verification', () => {
  const root = temp();
  const registry: { tables: Record<string, { erasure?: string }> } = JSON.parse(
    readFileSync(join(projectRoot, 'src/worker/db/column-registry.json'), 'utf8'),
  );
  delete registry.tables.reading_sessions!.erasure;
  const path = join(root, 'registry.json');
  writeFileSync(path, JSON.stringify(registry));
  expect(() =>
    execFileSync('python3', [join(projectRoot, 'scripts/check-registry.py'), '--registry', path], {
      stdio: 'pipe',
    }),
  ).toThrow();
});

test('a generated private column cannot hide from the fixed registry', () => {
  const root = temp();
  const schema = join(root, 'migration.sql');
  writeFileSync(
    schema,
    `${readFileSync(join(projectRoot, 'src/worker/db/migrations/0001.sql'), 'utf8')}\nALTER TABLE reading_sessions ADD COLUMN private_note_enc TEXT GENERATED ALWAYS AS (question_enc) VIRTUAL;\n`,
  );
  expect(() =>
    execFileSync('python3', [join(projectRoot, 'scripts/check-registry.py'), '--schema', schema], {
      stdio: 'pipe',
    }),
  ).toThrow();
});

test('a private column in a subsequent migration also needs field policy', () => {
  const root = temp();
  cpSync(join(projectRoot, 'src/worker/db/migrations/0001.sql'), join(root, '0001.sql'));
  writeFileSync(
    join(root, '0002.sql'),
    'ALTER TABLE reading_sessions ADD COLUMN private_note_enc TEXT;',
  );
  expect(() =>
    execFileSync(
      'python3',
      [join(projectRoot, 'scripts/check-registry.py'), '--migrations', root],
      { stdio: 'pipe' },
    ),
  ).toThrow();
});
