import { env } from 'cloudflare:workers';

export function failingDatabase(
  stage:
    | 'before-dispatch'
    | 'after-dispatch'
    | 'after-receipt'
    | 'after-outcome'
    | 'before-spread-dispatch'
    | 'after-spread-dispatch'
    | 'before-spread-basis'
    | 'after-spread-basis',
) {
  const sql = new WeakMap<object, string>();
  let armed = true;
  return new Proxy(env.DB, {
    get(target, name) {
      if (name === 'prepare')
        return (source: string) => {
          const statement = target.prepare(source);
          return new Proxy(statement, {
            get(statement, property) {
              if (property === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  sql.set(bound, source);
                  return bound;
                };
              const value = Reflect.get(statement, property, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (name === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const sources = statements.map((s) => sql.get(s) ?? '');
          const dispatch = sources.some((s) => s.startsWith('INSERT INTO provider_dispatches'));
          const publication = sources.some((s) => s.startsWith('INSERT INTO reading_editions'));
          const spreadDispatch = sources.some((s) =>
            s.startsWith('UPDATE generation_requests SET spread_dispatch_id='),
          );
          const spreadBasis = sources.some((s) =>
            s.startsWith('UPDATE generation_requests SET basis_id='),
          );
          if (
            armed &&
            (((stage === 'before-dispatch' || stage === 'after-dispatch') && dispatch) ||
              (stage === 'after-receipt' && publication) ||
              ((stage === 'before-spread-dispatch' || stage === 'after-spread-dispatch') &&
                spreadDispatch) ||
              ((stage === 'before-spread-basis' || stage === 'after-spread-basis') &&
                spreadBasis) ||
              (stage === 'after-outcome' &&
                sources.some((s) => s.startsWith('UPDATE provider_dispatches SET state=?'))))
          ) {
            armed = false;
            if (
              stage === 'after-dispatch' ||
              stage === 'after-outcome' ||
              stage === 'after-spread-dispatch' ||
              stage === 'after-spread-basis'
            )
              await target.batch(statements);
            throw new Error('Synthetic Worker loss');
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
