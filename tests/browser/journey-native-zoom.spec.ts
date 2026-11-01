import { expect, test } from '@playwright/test';
import { displayCapture, displayJourney, nativeZoomContext } from '../fixtures/browser-display.ts';
import { journeyAccount } from '../fixtures/browser-journey.ts';

// The responsive matrix sets DPR=1. Native zoom needs an un-emulated window.
test.use({
  viewport: null,
  deviceScaleFactor: [
    async ({ browserName }, use) => {
      expect(browserName).toBe('chromium');
      await use(undefined);
    },
    { scope: 'test' },
  ],
});

for (const theme of ['light', 'dark'] as const) {
  test(`native Chromium 200% page zoom: ${theme} read, save, reflect and return`, async ({
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const { context, page, resize, screenshot } = await nativeZoomContext(baseURL!, theme);
    try {
      const faults: string[] = [];
      page.on('pageerror', (error) => faults.push(error.message));
      const { capture, finish } = displayCapture(
        page,
        `chromium-native-200-${theme}`,
        resize,
        screenshot,
      );
      await expect(page.getByRole('button', { name: 'Create a test account' })).toBeEnabled();
      await capture('landing');
      await page.goto('/recover');
      await expect(page.getByLabel('Recovery handle', { exact: true })).toBeVisible();
      await capture('recovery');
      await journeyAccount(
        page,
        'chromium',
        baseURL,
        `198.51.100.${theme === 'light' ? 181 : 182}`,
      );
      await displayJourney(page, capture);
      await finish(faults);
    } finally {
      await context.close();
    }
  });
}
