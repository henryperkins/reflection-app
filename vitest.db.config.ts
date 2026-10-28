import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/worker/index.ts',
      miniflare: {
        compatibilityDate: '2026-10-23',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB', 'MIGRATION_DB'],
        r2Buckets: ['RECOVERY', 'BACKUP_INVENTORY'],
        durableObjects: { OFFLINE_COORDINATOR: { className: 'OfflineControl', useSQLite: true } },
        bindings: {
          RECOVERY_CONTROL_SECRET: 'synthetic-offline-control-token-not-a-deployed-secret',
          TEST_MIGRATIONS: await readD1Migrations('src/worker/db/migrations'),
        },
      },
    })),
  ],
  test: {
    include: ['tests/db/**/*.test.ts'],
    setupFiles: ['tests/deny-network.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
