import { defineConfig } from '@playwright/test';
export default defineConfig({
  forbidOnly: true,
  failOnFlakyTests: true,
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  outputDir: '/tmp/reflection-identity-browser-results',
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser-tests.json' }]],
  use: {
    baseURL: 'http://localhost:8787',
    browserName: 'chromium',
    viewport: { width: 1100, height: 850 },
    trace: 'off',
  },
  webServer: {
    command: 'node --import tsx scripts/local-identity.ts --test',
    url: 'http://localhost:8787/health',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { WRANGLER_SEND_METRICS: 'false' },
  },
});
