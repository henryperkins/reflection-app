import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';
import { READING_PRODUCT_COPY } from '../../src/contracts/product-copy.ts';
import {
  longFilename,
  longQuestion,
  noteJourneyStates,
  spreadPhotoPath,
} from './browser-journey.ts';
import { enableAi } from './browser-reading.ts';

export async function nativeZoomContext(baseURL: string, theme: 'light' | 'dark') {
  const origin = new URL(baseURL);
  if (!['localhost', '127.0.0.1'].includes(origin.hostname))
    throw new Error('Browser zoom qualification is synthetic loopback only');
  const extension = fileURLToPath(new URL('./native-zoom', import.meta.url));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    baseURL,
    ignoreHTTPSErrors: true,
    viewport: null,
    colorScheme: theme,
    reducedMotion: 'reduce',
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--window-size=1280,1000',
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = context.pages()[0]!;
    await page.goto('/');
    const zoom = await worker.evaluate(async (url) => {
      const { chrome } = globalThis as unknown as {
        chrome: {
          tabs: {
            query: (query: object) => Promise<Array<{ id: number; url: string }>>;
            setZoom: (id: number, factor: number) => Promise<void>;
            getZoom: (id: number) => Promise<number>;
          };
        };
      };
      const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url);
      if (!tab) throw new Error('Test tab was not found');
      await chrome.tabs.setZoom(tab.id, 2);
      return chrome.tabs.getZoom(tab.id);
    }, page.url());
    expect(zoom).toBe(2);
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const resize = async (width: number) => {
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: width * 2, height: 1000, windowState: 'normal' },
      });
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      // These distinguish real page zoom from CSS zoom, pinch zoom and DPR emulation.
      await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(2);
      expect(await page.evaluate(() => outerWidth)).toBe(width * 2);
      expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
      expect(await page.locator('html').evaluate((element) => getComputedStyle(element).zoom)).toBe(
        '1',
      );
    };
    const screenshot = async (path: string) => {
      const { cssContentSize, cssVisualViewport } = await cdp.send('Page.getLayoutMetrics');
      expect(cssVisualViewport.zoom).toBe(2);
      // Native page zoom uses DIP coordinates for capture, unlike Playwright's
      // viewport emulation. Unscaled CSS coordinates would crop the right half.
      const width = Math.ceil(cssContentSize.width * cssVisualViewport.zoom!);
      const height = Math.ceil(cssContentSize.height * cssVisualViewport.zoom!);
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      const image = Buffer.from(data, 'base64');
      expect(image.readUInt32BE(16), 'Capture includes the entire native-zoom viewport').toBe(
        width,
      );
      expect(image.readUInt32BE(20)).toBe(height);
      await writeFile(path, image);
    };
    await resize(320);
    return { context, page, resize, screenshot };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export function displayCapture(
  page: Page,
  prefix: string,
  resize: (width: number) => Promise<void>,
  screenshot = async (path: string) => {
    await page.screenshot({ path, fullPage: true });
  },
) {
  const output = 'artifacts/accessibility-pass/screens';
  const evidence: object[] = [];
  return {
    async capture(state: string) {
      await mkdir(output, { recursive: true });
      for (const width of [320, 390, 768, 1280]) {
        await resize(width);
        await page.evaluate(() => document.fonts.ready);
        const metrics = await page.evaluate(() => ({
          viewport: innerWidth,
          outerWidth,
          content: document.documentElement.scrollWidth,
          dpr: devicePixelRatio,
          visualScale: visualViewport?.scale,
          cssZoom: getComputedStyle(document.documentElement).zoom,
          forcedColors: matchMedia('(forced-colors: active)').matches,
          colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        }));
        expect(
          metrics.content,
          `${prefix} ${state} ${width}px horizontal overflow`,
        ).toBeLessThanOrEqual(metrics.viewport);
        evidence.push({ state, width, ...metrics });
        await screenshot(`${output}/${prefix}-${width}-${state}.png`);
      }
      await resize(320);
    },
    async finish(faults: string[]) {
      expect(faults).toEqual([]);
      await writeFile(
        `${output}/${prefix}.json`,
        `${JSON.stringify({ evidence, faults }, null, 2)}\n`,
      );
    },
  };
}

/** Real synthetic UI/API operations, run at the smallest display width between captures. */
export async function displayJourney(page: Page, capture: (state: string) => Promise<void>) {
  await capture('saved-empty');
  await enableAi(page);
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  await page.getByLabel('Your question', { exact: true }).fill(longQuestion);
  const english = page.getByLabel('Use English for this reading');
  await english.focus();
  await page.keyboard.press('Space');
  await expect(english).toBeChecked();
  await page.keyboard.press('Space');
  await expect(english).not.toBeChecked();
  await page.keyboard.press('Space');
  const photo = page.getByLabel('Photo of your spread (optional)');
  await photo.setInputFiles({
    name: longFilename,
    mimeType: 'image/jpeg',
    buffer: await readFile(spreadPhotoPath),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Photo attached:' })).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove photo', exact: true });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Choose photo', exact: true })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Photo removed.' })).toBeVisible();
  await photo.setInputFiles({
    name: longFilename,
    mimeType: 'image/jpeg',
    buffer: await readFile(spreadPhotoPath),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Photo attached:' })).toBeVisible();
  await english.focus();
  await capture('new-attached');
  await expect(page.getByText(READING_PRODUCT_COPY.startProcessing, { exact: true })).toBeVisible();
  let starts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/requests')
      starts++;
  });
  await page.getByRole('button', { name: 'Start reading', exact: true }).focus();
  await page.keyboard.press('Enter');
  const accepted = page.getByTestId('accepted-reading');
  await expect(accepted.getByRole('heading', { name: longQuestion, exact: true })).toBeFocused();
  const original = await accepted.textContent();
  await accepted.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(accepted.locator('.source')).toHaveCount(3);
  await capture('sources');
  await accepted.locator('summary').press('Enter');
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  const reflection = page.getByLabel('Your reflection', { exact: true });
  await reflection.fill('Synthetic reflection saved with enlarged or high-contrast controls.');
  await page.keyboard.press('Tab');
  const stance = page.getByLabel('How does this feel?');
  await expect(stance).toBeFocused();
  await stance.selectOption('resonates');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save reflection', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Reflection saved.' })).toBeVisible();
  await capture('reflection');
  await noteJourneyStates(page, capture);
  await page.getByRole('link', { name: 'Account', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Turn off AI readings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'AI readings are off', exact: true }),
  ).toBeVisible();
  await capture('account');
  await page.getByRole('link', { name: 'Back to readings', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(accepted).toHaveText(original!);
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeVisible();
  await capture('saved-populated');
  await page.getByRole('button', { name: longQuestion, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(accepted.getByRole('heading', { name: longQuestion, exact: true })).toBeFocused();
  await expect(accepted).toHaveText(original!);
  await expect(reflection).toHaveValue(
    'Synthetic reflection saved with enlarged or high-contrast controls.',
  );
  await expect(stance).toHaveValue('resonates');
  expect(starts).toBe(1);
}
