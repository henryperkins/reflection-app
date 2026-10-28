import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PRIVATE_FIELD_HANDLERS } from '../../src/worker/recovery/private-fields.ts';

test('every encrypted registry column has exactly one reviewed field handler with its actual AAD rule', () => {
  const registry = JSON.parse(readFileSync('src/worker/db/column-registry.json', 'utf8')).tables;
  const actual: string[] = [];
  for (const [table, policy] of Object.entries(registry) as [
    string,
    { columns: Record<string, { class: string; aadRule: string }> },
  ][])
    for (const [column, value] of Object.entries(policy.columns))
      if (value.class === 'E') actual.push(table + '.' + column);
  const handlers = PRIVATE_FIELD_HANDLERS.map((h) => h.table + '.' + h.column);
  expect(new Set(handlers).size).toBe(handlers.length);
  expect(handlers.sort()).toEqual(actual.sort());
  for (const handler of PRIVATE_FIELD_HANDLERS)
    expect(handler.aadRule).toBe(registry[handler.table].columns[handler.column].aadRule);
  expect(
    PRIVATE_FIELD_HANDLERS.filter((h) => h.family === 'recovery')
      .map((h) => h.table)
      .sort(),
  ).toEqual(['deletion_jobs', 'security_operations']);
});
