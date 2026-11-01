import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { apiSchemas } from '../../src/contracts/index.ts';
import { READING_PRODUCT_COPY, SPREAD_PHOTO_COPY } from '../../src/contracts/product-copy.ts';
import { journeyAccount, spreadPhotoPath } from '../fixtures/browser-journey.ts';
import { enableAi } from '../fixtures/browser-reading.ts';

test('keyboard upload, processing, save, reflection, Account and exact return journey', async ({
  page,
  browserName,
  baseURL,
}) => {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => {
    const original = FileReader.prototype.readAsDataURL;
    Object.assign(window, { releaseJourneyPhoto: () => {} });
    FileReader.prototype.readAsDataURL = function (blob) {
      if (blob instanceof File && blob.name.startsWith('slow'))
        Object.assign(window, { releaseJourneyPhoto: () => original.call(this, blob) });
      else original.call(this, blob);
    };
  });
  await journeyAccount(page, browserName, baseURL, '203.0.113.230');
  // Disclosure fixture only: the actual Worker and writer remain synthetic.
  await page.route('**/health', (route) =>
    route.fulfill({ json: { mode: 'live-preview', generationReady: true } }),
  );
  await page.reload();
  await enableAi(page);
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  const question = 'Synthetic return to the exact saved reading';
  await page.getByLabel('Your question', { exact: true }).fill(question);
  await page.getByLabel('Use English for this reading').check();
  const choose = page.getByRole('button', { name: 'Choose photo', exact: true });
  await expect(choose).toHaveAccessibleDescription(
    /sends your attached photo to Meta.*zero retention/,
  );
  await expect(
    page.getByText(SPREAD_PHOTO_COPY.spreadPhotoProcessing, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(READING_PRODUCT_COPY.startProcessing, { exact: true })).toBeVisible();
  const picker = page.waitForEvent('filechooser');
  await choose.focus();
  await page.keyboard.press('Enter');
  await (await picker).setFiles({
    name: 'slow-synthetic-spread.jpg',
    mimeType: 'image/jpeg',
    buffer: await readFile(spreadPhotoPath),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Preparing photo…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start reading', exact: true })).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as { releaseJourneyPhoto: () => void }).releaseJourneyPhoto(),
  );
  await expect(page.getByRole('status').filter({ hasText: 'Photo attached:' })).toBeVisible();
  await choose.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Remove photo', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(choose).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Photo removed.' })).toBeVisible();
  await page.getByLabel('Photo of your spread (optional)').setInputFiles(spreadPhotoPath);
  await expect(page.getByRole('status').filter({ hasText: 'Photo attached:' })).toBeVisible();

  let starts = 0;
  let ready = false;
  let pending: ReturnType<typeof apiSchemas.RequestStatus.parse>;
  await page.route('**/api/v1/requests', async (route) => {
    starts++;
    const response = await route.fetch();
    const started = apiSchemas.StartResponse.parse(await response.json());
    pending = { ...started.status, state: 'dispatching', revision: 2, events: [], nextSequence: 2 };
    await route.fulfill({ response, json: { ...started, status: pending } });
  });
  await page.route(/\/api\/v1\/requests\/[0-9a-f-]+\?after=/, (route) =>
    ready ? route.continue() : route.fulfill({ json: pending }),
  );
  await page.getByRole('button', { name: 'Start reading', exact: true }).focus();
  await page.keyboard.press('Enter');
  const progress = page.getByRole('status').filter({ hasText: 'Writing your reading…' });
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('aria-live', 'polite');
  await expect(progress).toHaveAttribute('aria-atomic', 'true');
  await mkdir('artifacts/visual-pass/screens', { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.screenshot({
      path: `artifacts/visual-pass/screens/${browserName}-390-${theme}-progress.png`,
      fullPage: true,
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  ready = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const accepted = page.getByTestId('accepted-reading');
  await expect(accepted.getByRole('heading', { name: question, exact: true })).toBeFocused();
  const original = await accepted.textContent();
  const url = page.url();
  await page.getByRole('button', { name: 'Save reading', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Reading saved.' })).toBeVisible();
  const reflection = page.getByLabel('Your reflection', { exact: true });
  await reflection.focus();
  await page.keyboard.type('Synthetic reflection to return to later.');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('How does this feel?')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save reflection', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Reflection saved.' })).toBeVisible();
  let releasePasskeys!: () => void;
  const passkeysReady = new Promise<void>((resolve) => {
    releasePasskeys = resolve;
  });
  await page.route('**/api/v1/auth/credentials', async (route) => {
    await passkeysReady;
    await route.continue();
  });
  await page.getByRole('link', { name: 'Account', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeFocused();
  const supportsPasskeys = await page.evaluate(() =>
    Boolean(navigator.credentials && window.PublicKeyCredential),
  );
  if (supportsPasskeys)
    await page.evaluate(() => {
      Object.defineProperty(navigator.credentials, 'get', {
        configurable: true,
        value: async () => {
          throw new DOMException('Synthetic prompt cancellation', 'NotAllowedError');
        },
      });
    });
  const addPasskey = page.getByRole('button', { name: 'Add a passkey', exact: true });
  await expect(addPasskey).toBeDisabled();
  releasePasskeys();
  await expect(addPasskey).toBeEnabled();
  await addPasskey.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    supportsPasskeys ? /prompt was closed.*timed out/ : /not supported|does not support/i,
  );
  await expect(page.getByRole('button', { name: 'Add a passkey', exact: true })).toBeEnabled();
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('link', { name: 'Back to readings', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(url);
  await expect(accepted).toHaveText(original!);
  await expect(reflection).toHaveValue('Synthetic reflection to return to later.');
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  await page.getByRole('button', { name: question, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(accepted.getByRole('heading', { name: question, exact: true })).toBeFocused();
  await expect(accepted).toHaveText(original!);
  await writeFile(
    `artifacts/visual-pass/screens/${browserName}-journey-aria.txt`,
    await page.locator('main').ariaSnapshot(),
  );
  await page.getByRole('button', { name: 'Delete reading', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByLabel('Delete this reading and its reflections permanently'),
  ).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Confirm deletion', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Account', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeFocused();
  await page.locator('.account-settings .deletion-actions summary').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(
    page.getByLabel('Permanently delete my account, readings and reflections'),
  ).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Delete account permanently', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'A place to return to.', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: 'Deletion is complete for active storage.' }),
  ).toBeVisible();
  await expect(page.getByText(/Backups are kept until/)).toBeVisible();
  await expect(page.getByText(/Downloaded copies are unchanged/)).toBeVisible();
  await expect(page.getByText('Active-store')).toHaveCount(0);
  expect(starts).toBe(1);
  expect(faults).toEqual([]);
});
