import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { backupInventoryFixture } from '../fixtures/backup-inventory.ts';
import { ProtectedBackupInventory } from '../../src/worker/recovery/backup-inventory.ts';

test('signed complete inventory binds actual independent backup bytes across reordered pages', async () => {
  const f = await backupInventoryFixture();
  const bucket = new Proxy(env.BACKUP_INVENTORY, {
    get(target, name) {
      if (name === 'list')
        return async (options: R2ListOptions) => {
          const all = await target.list(options.prefix ? { prefix: options.prefix } : {});
          const objects = [...all.objects].reverse();
          return {
            ...all,
            objects: options.cursor ? objects.slice(1) : objects.slice(0, 1),
            truncated: !options.cursor,
            ...(!options.cursor ? { cursor: 'second-page' } : {}),
          };
        };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const inventory = new ProtectedBackupInventory(bucket, f.environment, f.keys.publicKey);
  expect((await inventory.verified()).manifests).toHaveLength(3);
  await env.BACKUP_INVENTORY.put(f.manifests[0]!.objectKey, 'Changed backup bytes');
  await expect(inventory.verified()).rejects.toThrow('Backup bytes');
});

test.each(['missing', 'duplicate', 'signature', 'extra', 'missing-copy'])(
  'independent inventory fails closed for %s evidence',
  async (failure) => {
    const f = await backupInventoryFixture();
    if (failure === 'missing')
      await env.BACKUP_INVENTORY.delete(f.prefix + 'manifests/' + f.manifests[0]!.id + '.json');
    if (failure === 'duplicate') {
      f.index.manifestIds.push(f.index.manifestIds[0]!);
      await env.BACKUP_INVENTORY.put(
        f.prefix + 'index.json',
        JSON.stringify(await f.sign(f.index)),
      );
    }
    if (failure === 'signature')
      await env.BACKUP_INVENTORY.put(
        f.prefix + 'manifests/' + f.manifests[0]!.id + '.json',
        JSON.stringify({ document: f.manifests[0], signature: 'A'.repeat(86) }),
      );
    if (failure === 'extra')
      await env.BACKUP_INVENTORY.put(f.prefix + 'manifests/' + crypto.randomUUID() + '.json', '{}');
    if (failure === 'missing-copy') await env.BACKUP_INVENTORY.delete(f.manifests[2]!.objectKey);
    await expect(f.inventory.verified()).rejects.toThrow();
  },
);
