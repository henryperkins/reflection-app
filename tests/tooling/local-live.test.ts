import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { loadLocalLiveSettings, localLiveRuntimeOptions } from '../../scripts/local-live.ts';
import { withLocalReadingDatabase } from '../../scripts/local-reading-operator.ts';

test('live startup reads the supplied env file without copying the API key into persisted app settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-live-'));
  try {
    const file = join(root, '.env');
    writeFileSync(
      file,
      'OPENAI_API_KEY="synthetic-private-key"\nOPENAI_PROJECT_ID=proj_test\nVITE_SECRET=do-not-expose\n',
    );
    const first = loadLocalLiveSettings(root, file, {});
    const second = loadLocalLiveSettings(root, file, {});
    expect(first.apiKey).toBe('synthetic-private-key');
    expect(first.identitySecrets).toBe(second.identitySecrets);
    const identityFile = join(first.persistence, 'identity.json');
    const stored = readFileSync(identityFile, 'utf8');
    expect(stored).not.toContain('synthetic-private-key');
    expect(stored).not.toContain('do-not-expose');
    expect(JSON.parse(stored).environment).toBe('live-local');
    expect(statSync(identityFile).mode & 0o777).toBe(0o600);
    expect(Object.keys(first).sort()).toEqual([
      'apiKey',
      'identitySecrets',
      'persistence',
      'projectId',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removing provider credentials still loads the same saved-reading encryption keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-live-'));
  try {
    const file = join(root, '.env');
    writeFileSync(file, 'OPENAI_API_KEY=synthetic-secret\nOPENAI_PROJECT_ID=proj_test\n');
    const before = loadLocalLiveSettings(root, file, {});
    writeFileSync(file, '');
    const after = loadLocalLiveSettings(root, file, {});
    expect(after.apiKey).toBe('');
    expect(after.identitySecrets).toBe(before.identitySecrets);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the live runtime opens the same D1 store that Wrangler migrations use', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-live-'));
  try {
    const settings = loadLocalLiveSettings(root, undefined, {
      OPENAI_API_KEY: 'synthetic-test-key',
      OPENAI_PROJECT_ID: 'proj_test',
    });
    const migrated = join(settings.persistence, 'v3');
    mkdirSync(migrated);
    await withLocalReadingDatabase(migrated, async (db) => {
      await db.prepare('CREATE TABLE startup_probe (value TEXT)').run();
      await db.prepare("INSERT INTO startup_probe VALUES ('persisted')").run();
    });
    mkdirSync(join(root, 'dist/client'), { recursive: true });
    writeFileSync(join(root, 'dist/client/index.html'), '<h1>Reflection test app</h1>');
    const { scriptPath: _script, ...options } = localLiveRuntimeOptions(root, settings);
    const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        ...options,
        port: 0,
        script:
          "export default {async fetch(request,env) { if(new URL(request.url).pathname==='/health') return Response.json(await env.DB.prepare('SELECT value FROM startup_probe').first()); return env.ASSETS.fetch(request); }}",
      }),
    );
    try {
      const response = await runtime.dispatchFetch('http://localhost/health');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ value: 'persisted' });
      const app = await runtime.dispatchFetch('http://localhost/');
      expect(await app.text()).toContain('Reflection test app');
    } finally {
      await runtime.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
