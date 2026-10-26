import publicationGuard from './publication_guard.sql?raw';

/** Execution-time clock: never substitute a sampled Worker time. */
export const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
export const DAY = "'day:' || strftime('%Y-%m-%d','now')";
export const MONTH = "'month:' || strftime('%Y-%m','now')";
export type Binding = string | number | null;
export const statement = (db: D1Database, sql: string, ...bindings: Binding[]) =>
  db.prepare(sql).bind(...bindings);
export const assertChanges = (db: D1Database, n: number) =>
  statement(db, 'INSERT INTO assertion_probe(ok) SELECT 0 WHERE changes()!=?', n);
export const assertExists = (db: D1Database, query: string, ...bindings: Binding[]) =>
  statement(
    db,
    `INSERT INTO assertion_probe(ok) SELECT 0 WHERE NOT EXISTS (${query})`,
    ...bindings,
  );

/** Named parameters are compiled only from our checked-in SQL, never caller SQL. */
export function currentGuard(
  db: D1Database,
  values: Record<string, Binding>,
  stage: 'start' | 'dispatch' | 'publish',
) {
  let source = publicationGuard;
  if (stage !== 'publish')
    source = source.replace("r.state IN('validating','fallback_pending')", "r.state='prepared'");
  if (stage === 'start')
    source = source
      .replace('AND r.run_epoch=:run_epoch AND r.lease_token=:lease_token', '')
      .replace(`AND r.lease_expires_at>${DB_NOW}`, '');
  if (stage === 'dispatch')
    source = source.replace(
      'AND sys.generation_enabled=1',
      "AND sys.dispatch_mode='model' AND sys.generation_enabled=1",
    );
  const bindings: Binding[] = [];
  source = source.replace(/:([a-z_]+)/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Missing guard binding: ${key}`);
    bindings.push(value);
    return '?';
  });
  return statement(db, source, ...bindings);
}
