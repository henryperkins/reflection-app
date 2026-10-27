import { closeSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
export function operatorArguments(argv: string[], modes: string[], allowed: string[]) {
  const mode = argv[0];
  if (!mode || !modes.includes(mode)) throw new Error();
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i],
      v = argv[i + 1];
    if (!k || !allowed.includes(k) || !v || v.startsWith('--') || values.has(k)) throw new Error();
    values.set(k, v);
  }
  return { mode, values };
}
export function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value) throw new Error();
  return value;
}
export function readOperatorBytes(path: string, max = 1_000_000): Uint8Array {
  const file = resolve(path),
    stat = statSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > max) throw new Error();
  return new Uint8Array(readFileSync(file));
}
export function readOperatorJson(path: string): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readOperatorBytes(path)));
}
/** Explicit local persistence only. Operators must stop the app/maintenance process first. */
export async function withLocalReadingDatabase<T>(
  path: string,
  work: (db: D1Database) => Promise<T>,
): Promise<T> {
  const persistence = resolve(path);
  if (!statSync(persistence).isDirectory()) throw new Error();
  const lock = join(persistence, '.reading-operator.lock'),
    fd = openSync(lock, 'wx', 0o600);
  try {
    const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        script: '',
        modules: true,
        compatibilityDate: '2026-10-23',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        logRequests: false,
        telemetry: { enabled: false },
        resourcePersistencePath: persistence,
        d1Databases: { DB: 'DB' },
      }),
    );
    try {
      return await work(await runtime.getD1Database('DB'));
    } finally {
      await runtime.dispose();
    }
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
