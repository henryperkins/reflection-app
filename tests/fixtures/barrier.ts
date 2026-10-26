import { env } from 'cloudflare:workers';

export function gate(predicate: (sql: string[]) => boolean) {
  const statements = new WeakMap<object, string>();
  let armed = true;
  let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      arrived = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          return new Proxy(prepared, {
            get(statement, name) {
              if (name === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  statements.set(bound, sql);
                  return bound;
                };
              const value = Reflect.get(statement, name, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (property === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          if (armed && predicate(batch.map((statement) => statements.get(statement) ?? ''))) {
            armed = false;
            arrived();
            await held;
          }
          return target.batch(batch);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, ready, release };
}
