/** Execution-time clock: never substitute a sampled Worker time. */
export const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
export const DAY = "'day:' || strftime('%Y-%m-%d','now')";
export const MONTH = "'month:' || strftime('%Y-%m','now')";
export type Binding = string | number | null | ArrayBuffer;
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
