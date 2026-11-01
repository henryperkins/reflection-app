import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { apiSchemas } from '../../src/contracts/index.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { RecordBase } from '../../src/worker/readings/base.ts';
import { Revisits } from '../../src/worker/readings/revisits.ts';
import { SessionErasure } from '../../src/worker/readings/erasure.ts';
import { ReadingExports } from '../../src/worker/readings/export.ts';
import { readingAccount, readingBindings } from './reading-client.ts';

export async function fixture() {
  const account = await readingAccount();
  const { reading, started } = await account.client.create();
  expect(
    (
      await account.client.request(
        `/sessions/${started.sessionId}/save`,
        { saved: true },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  const identity = localIdentity(readingBindings)!;
  const session = await identity.sessions.get(account.client.cookies.get('__Host-session'));
  const base = new RecordBase(env.DB, identity);
  return {
    ...account,
    reading,
    started,
    session,
    base,
    notes: new Revisits(base),
    erase: new SessionErasure(base, env.RECOVERY),
    exports: new ReadingExports(base),
  };
}
export async function note(f: Awaited<ReturnType<typeof fixture>>, text = ' First 😀 note\n') {
  return f.notes.create(
    f.session,
    apiSchemas.RevisitWrite.parse({ editionId: f.reading.editionId, note: text }),
    crypto.randomUUID(),
  );
}
export async function edited(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await note(f);
  const second = await f.notes.update(
    f.session,
    first.id,
    1,
    crypto.randomUUID(),
    apiSchemas.RevisitUpdate.parse({ note: 'Second note', stance: 'disagree' }),
  );
  return { first, second };
}
