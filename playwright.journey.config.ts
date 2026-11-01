import { defineConfig } from '@playwright/test';

export default defineConfig({
  forbidOnly: true,
  failOnFlakyTests: true,
  testDir: './tests/browser',
  testMatch: [
    'journey-cross-browser.spec.ts',
    'journey-layout.spec.ts',
    'journey-native-zoom.spec.ts',
    'journey-forced-colors.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  outputDir: 'artifacts/visual-pass/test-results',
  reporter: [['list'], ['json', { outputFile: 'artifacts/visual-pass/browser-matrix.json' }]],
  use: {
    baseURL: 'https://localhost:8843',
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' }, testIgnore: 'journey-native-zoom.spec.ts' },
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      // Linux WebKit's forced-colors override sets the media query but does not
      // apply the system palette. It cannot qualify forced-color rendering.
      testIgnore: ['journey-native-zoom.spec.ts', 'journey-forced-colors.spec.ts'],
    },
  ],
  webServer: [
    {
      command: 'node --import tsx scripts/local-identity.ts --test',
      url: 'http://localhost:8787/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { WRANGLER_SEND_METRICS: 'false' },
    },
    {
      command: 'node --import tsx scripts/browser-journey-https.ts',
      url: 'https://localhost:8843/health',
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
