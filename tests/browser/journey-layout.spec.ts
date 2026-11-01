import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiSchemas } from '../../src/contracts/index.ts';
import { READING_PRODUCT_COPY, SPREAD_PHOTO_COPY } from '../../src/contracts/product-copy.ts';
import {
  journeyAccount,
  noteJourneyStates,
  longFilename,
  longQuestion,
  spreadPhotoPath,
  themeContrast,
} from '../fixtures/browser-journey.ts';

for (const width of [320, 390, 768, 1280]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${width}px ${theme}: full journey, long content and enlarged layout`, async ({
      page,
      browserName,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      const output = resolve('artifacts/visual-pass/screens');
      await mkdir(output, { recursive: true });
      const prefix = `${browserName}-${width}-${theme}`;
      const evidence: object[] = [];
      const faults: string[] = [];
      page.on('pageerror', (error) => faults.push(error.message));
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const capture = async (state: string) => {
        if (['saved-empty', 'saved-populated', 'new-empty'].includes(state)) {
          const destination = state === 'new-empty' ? 'New reading' : 'Saved readings';
          const current = page.getByRole('button', { name: destination, exact: true });
          await expect(current).toHaveAttribute('aria-current', 'page');
          await current.hover();
          const contrast = await themeContrast(
            page,
            '.reading-navigation button[aria-current="page"]',
          );
          expect(
            contrast.selectedText,
            `${prefix} ${destination} hovered text contrast`,
          ).toBeGreaterThanOrEqual(4.5);
          evidence.push({ state: `${state}-hover-contrast`, ...contrast });
          await page.mouse.move(0, 0);
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            [...document.images]
              .filter((image) => image.complete)
              .map((image) => image.decode().catch(() => undefined)),
          );
        });
        // Responsive source changes may abort a decode; genuinely broken visible
        // images must still fail the test rather than disappearing from evidence.
        await expect
          .poll(() =>
            page.evaluate(() =>
              [...document.images].every((image) => {
                const box = image.getBoundingClientRect();
                if (!box.width || !box.height) return true;
                if (image.loading === 'lazy' && (box.top > innerHeight || box.bottom < 0))
                  return true;
                return image.complete && image.naturalWidth > 0;
              }),
            ),
          )
          .toBe(true);
        const layout = await page.evaluate(() => ({
          viewport: innerWidth,
          content: document.documentElement.scrollWidth,
          images: [...document.images].map((image) => ({
            source: image.src.startsWith('data:')
              ? 'user-spread-data-url'
              : new URL(image.currentSrc || image.src).pathname,
            width: image.getBoundingClientRect().width,
            naturalWidth: image.naturalWidth,
          })),
        }));
        expect(layout.content, `${prefix} ${state} horizontal overflow`).toBeLessThanOrEqual(
          layout.viewport,
        );
        evidence.push({ state, ...layout });
        await page.screenshot({ path: `${output}/${prefix}-${state}.png`, fullPage: true });
      };
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Create a test account' })).toBeEnabled();
      await capture('landing');
      await page.goto('/recover');
      await expect(page.getByLabel('Recovery handle', { exact: true })).toBeVisible();
      await capture('recovery');
      await journeyAccount(
        page,
        browserName,
        baseURL,
        `203.0.113.${100 + [320, 390, 768, 1280].indexOf(width) * 2 + (theme === 'dark' ? 1 : 0)}`,
      );
      await capture('saved-empty');
      // Full live notices, synthetic backend. No real provider or image recognition is involved.
      await page.route('**/health', (route) =>
        route.fulfill({ json: { mode: 'live-preview', generationReady: true } }),
      );
      await page.goto('/account');
      await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(
        1,
      );
      await expect(
        page.getByText(READING_PRODUCT_COPY.aiPermission, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(SPREAD_PHOTO_COPY.liveProviderRetention, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(READING_PRODUCT_COPY.serviceStorage, { exact: true }),
      ).toBeVisible();
      const contrast = await themeContrast(page);
      for (const [name, value] of Object.entries(contrast))
        expect(value, `${theme} ${name} contrast`).toBeGreaterThanOrEqual(
          name.startsWith('input') ? 3 : 4.5,
        );
      evidence.push({ state: 'theme-contrast', ...contrast });
      await capture('account');
      await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
      await page.getByRole('link', { name: 'Back to readings', exact: true }).click();
      await page.getByRole('button', { name: 'New reading', exact: true }).click();
      await page.getByLabel('Your question', { exact: true }).fill(longQuestion);
      await page.getByLabel('Use English for this reading').check();
      await capture('new-empty');
      const illustration = await page.locator('.spread-intro-art').boundingBox();
      expect(illustration).not.toBeNull();
      expect(illustration!.height / illustration!.width).toBeCloseTo(793 / 1983, 2);
      const emptyAttachment = await page.locator('.spread-photo-empty').boundingBox();
      expect(
        emptyAttachment!.height,
        'Optional-photo illustration must not stretch its frame',
      ).toBeLessThan(240);
      if (width <= 390) await expectNoArtOverlap(page);
      await page.getByLabel('Photo of your spread (optional)').setInputFiles({
        name: longFilename,
        mimeType: 'image/jpeg',
        buffer: await readFile(spreadPhotoPath),
      });
      await expect(page.getByTestId('spread-photo-preview')).toContainText(longFilename);
      await expect(page.getByRole('button', { name: 'Start reading', exact: true })).toBeEnabled();
      await expect(
        page.getByText(READING_PRODUCT_COPY.startProcessing, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(SPREAD_PHOTO_COPY.spreadPhotoProcessing, { exact: true }),
      ).toBeVisible();
      await capture('new-attached');
      await page.getByRole('button', { name: 'Start reading', exact: true }).click();
      const accepted = page.getByTestId('accepted-reading');
      await expect(accepted).toBeVisible();
      await expect(
        accepted.getByRole('heading', { name: longQuestion, exact: true }),
      ).toBeVisible();
      await capture('reading-photo');
      const original = await accepted.textContent();
      const requestId = page.url().split('/').at(-1)!;
      const status = apiSchemas.RequestStatus.parse(
        await page.request.get(`/api/v1/requests/${requestId}`).then((response) => response.json()),
      );
      const reading = apiSchemas.Reading.parse(
        await page.request
          .get(`/api/v1/readings/${status.editionId}`)
          .then((response) => response.json()),
      );
      if (reading.kind !== 'tarot.accepted.v2')
        throw new Error('Expected the synthetic v2 fixture');
      for (const [index, unit] of reading.units.entries()) {
        const position = accepted.locator('.position-card').nth(index);
        await expect(position.getByText(unit.basisText, { exact: true })).toBeVisible();
        await expect(position.getByText(unit.interpretation, { exact: true })).toBeVisible();
      }
      await expect(accepted.getByText(reading.synthesis.text, { exact: true })).toBeVisible();
      await expect(accepted.getByText(reading.action.text, { exact: true })).toBeVisible();
      await accepted.locator('summary').focus();
      await page.keyboard.press('Enter');
      for (const [index, source] of reading.sources.entries()) {
        const block = accepted.locator('.source').nth(index);
        await expect(block.getByText(source.meaning.core, { exact: true })).toBeVisible();
        await expect(block.getByText(source.rights.attribution, { exact: true })).toBeVisible();
      }
      await capture('sources');
      await accepted.locator('summary').press('Enter');
      await page
        .getByLabel('Your reflection', { exact: true })
        .fill('Synthetic writing kept for a later return.');
      await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Edit reflection', exact: true }),
      ).toBeVisible();
      await capture('reflection');
      await noteJourneyStates(page, capture);
      await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Saved readings', exact: true }),
      ).toBeVisible();
      await capture('saved-populated');
      await page.getByRole('button', { name: longQuestion, exact: true }).click();
      await expect(accepted).toHaveText(original!);
      await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
        'Synthetic writing kept for a later return.',
      );

      // CSS zoom is a reflow probe, not native browser/OS zoom or screen-reader evidence.
      await page.setViewportSize({ width: 640, height: 1000 });
      await page.locator('html').evaluate((element) => {
        element.style.zoom = '2';
      });
      await capture('reading-css-zoom-200');
      await page.getByRole('button', { name: 'Edit note', exact: true }).click();
      await capture('notes-edit-css-zoom-200');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('link', { name: 'Account', exact: true }).click();
      await capture('account-css-zoom-200');
      await page.locator('html').evaluate((element) => {
        element.style.zoom = '';
      });
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole('link', { name: 'Back to readings', exact: true }).click();
      await page.getByRole('button', { name: 'New reading', exact: true }).click();
      await page.getByLabel('Your question', { exact: true }).fill('Synthetic drawn-card layout');
      await page.getByLabel('Use English for this reading').check();
      await page.getByRole('button', { name: 'Start reading', exact: true }).click();
      await expect(accepted).toBeVisible();
      await capture('reading-drawn');
      expect(faults).toEqual([]);
      await writeFile(
        `${output}/${prefix}-evidence.json`,
        `${JSON.stringify({ evidence, faults }, null, 2)}\n`,
      );
    });
  }
}

async function expectNoArtOverlap(page: Page) {
  const heading = await page.locator('.new-reading-heading h2').boundingBox();
  const art = await page.locator('.new-reading-art').boundingBox();
  expect(heading).not.toBeNull();
  expect(art).not.toBeNull();
  const overlap =
    heading!.x < art!.x + art!.width &&
    art!.x < heading!.x + heading!.width &&
    heading!.y < art!.y + art!.height &&
    art!.y < heading!.y + heading!.height;
  expect(overlap, 'Mobile corner must have its own space, never touch the heading').toBe(false);
}

test('2x mobile illustration delivery uses transparent variants, not full-size originals', async ({
  browser,
  browserName,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL: baseURL!,
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 1000 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const paths: string[] = [];
    page.on('request', (request) => paths.push(new URL(request.url()).pathname));
    await journeyAccount(page, browserName, baseURL, '203.0.113.240');
    await page.goto('/account');
    await expect(
      page.getByRole('button', { name: 'Enable AI readings', exact: true }),
    ).toBeEnabled();
    const corner = page.locator('.account-title-art img');
    await expect
      .poll(() => corner.evaluate((image: HTMLImageElement) => image.currentSrc))
      .toContain('mobile-corner-160-');
    await mkdir('artifacts/visual-pass/screens', { recursive: true });
    const choices: object[] = [];
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('.account-settings .page-title').screenshot({
        path: `artifacts/visual-pass/screens/${browserName}-390-${theme}-account-art-2x.png`,
      });
    }
    await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
    await page.getByRole('link', { name: 'Back to readings', exact: true }).click();
    await page.getByRole('button', { name: 'New reading', exact: true }).click();
    const cards = page.locator('.spread-intro-art');
    await expect
      .poll(() => cards.evaluate((image: HTMLImageElement) => image.currentSrc))
      .toContain('three-card-spread-640-');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.locator('.new-reading').screenshot({
        path: `artifacts/visual-pass/screens/${browserName}-390-${theme}-form-art-2x.png`,
      });
    }
    for (const selector of ['.new-reading-art img', '.spread-intro-art']) {
      const choice = await page.locator(selector).evaluate((image: HTMLImageElement) => ({
        source: new URL(image.currentSrc).pathname,
        width: image.getBoundingClientRect().width,
        dpr: devicePixelRatio,
        loaded: image.complete && image.naturalWidth > 0,
      }));
      expect(choice.loaded).toBe(true);
      const sourceWidth = Number(choice.source.match(/-(\d+)-/)?.[1]);
      expect(sourceWidth).toBeGreaterThanOrEqual(choice.width * choice.dpr);
      choices.push(choice);
    }
    expect(paths.filter((path) => /(?:spread-ribbon|account-sprig)/.test(path))).toEqual([]);
    expect(
      paths.filter((path) => /(?:mobile-corner|three-card-spread).*\.png$/.test(path)),
    ).toEqual([]);
    await writeFile(
      `artifacts/visual-pass/screens/${browserName}-delivery-2x.json`,
      `${JSON.stringify({ choices, imagePaths: paths.filter((path) => path.endsWith('.webp')) }, null, 2)}\n`,
    );
  } finally {
    await context.close();
  }
});
