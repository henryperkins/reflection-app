/** Synthetic test-only snapshots of actual D1 rows, including BLOB public passkey material. */
export async function snapshot(db: D1Database) {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY name",
    )
    .all<{ name: string }>();
  const result = [];
  for (const { name } of tables.results) {
    const columns = (
      await db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string; type: string }>()
    ).results;
    const rows = (await db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>())
      .results;
    result.push({ name, columns, rows });
  }
  return result;
}
export async function restoreSnapshot(db: D1Database, saved: Awaited<ReturnType<typeof snapshot>>) {
  const statements = [
    db.prepare('PRAGMA defer_foreign_keys=ON'),
    ...saved.map((table) => db.prepare(`DELETE FROM "${table.name}"`)),
  ];
  for (const table of saved)
    for (const row of table.rows) {
      statements.push(
        db
          .prepare(
            `INSERT INTO "${table.name}" (${table.columns.map((c) => `"${c.name}"`).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`,
          )
          .bind(
            ...table.columns.map((c) => {
              const value = row[c.name];
              return c.type === 'BLOB' && Array.isArray(value)
                ? new Uint8Array(value).buffer
                : value;
            }),
          ),
      );
    }
  await db.batch(statements);
}
