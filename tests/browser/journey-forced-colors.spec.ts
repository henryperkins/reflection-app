import { expect, test } from '@playwright/test';
import { displayCapture, displayJourney } from '../fixtures/browser-display.ts';
import { journeyAccount } from '../fixtures/browser-journey.ts';

for (const theme of ['light', 'dark'] as const) {
  test(`forced colors with ${theme} preference: controls and exact saved return`, async ({
    page,
    browserName,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const faults: string[] = [];
    page.on('pageerror', (error) => faults.push(error.message));
    await page.emulateMedia({
      forcedColors: 'active',
      colorScheme: theme,
      reducedMotion: 'reduce',
    });
    const resize = async (width: number) => {
      await page.setViewportSize({ width, height: 1000 });
    };
    const { capture, finish } = displayCapture(page, `${browserName}-forced-${theme}`, resize);
    await resize(320);
    await journeyAccount(page, browserName, baseURL, `198.51.100.${theme === 'light' ? 183 : 184}`);
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await displayJourney(page, capture);
    // Disabled does not mean illegible: preserve the platform's chosen disabled
    // text color rather than compositing it with a second opacity reduction.
    await expect(page.getByRole('button', { name: 'New reading', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'New reading', exact: true })).toHaveCSS(
      'opacity',
      '1',
    );
    const disabledColor = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'GrayText';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(page.getByRole('button', { name: 'New reading', exact: true })).toHaveCSS(
      'color',
      disabledColor,
    );
    await finish(faults);
  });
}
