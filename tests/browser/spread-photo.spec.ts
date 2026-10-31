import { expect, test, type Page } from '@playwright/test';
import { account } from '../fixtures/browser-reading.ts';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

async function form(page: Page, ip: string) {
  await page.addInitScript(() => {
    const original = FileReader.prototype.readAsDataURL;
    const pending: Array<() => Promise<void>> = [];
    FileReader.prototype.readAsDataURL = function (blob) {
      if (blob instanceof File && blob.name.startsWith('slow')) {
        pending.push(
          () =>
            new Promise<void>((resolve) => {
              this.addEventListener('loadend', () => resolve(), { once: true });
              original.call(this, blob);
            }),
        );
      } else original.call(this, blob);
    };
    Object.assign(window, {
      releasePhotoReads: () => Promise.all(pending.splice(0).map((release) => release())),
    });
  });
  await account(page, ip);
  await page.goto('/account');
  await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Turn off AI readings', exact: true }),
  ).toBeEnabled();
  await page.goto('/');
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  await page.getByLabel('Your question').fill('How can I compare my options?');
  await page.getByLabel('Use English for this reading').check();
}

test('starting while image preparation is pending keeps the chosen photo', async ({ page }) => {
  await form(page, '192.0.2.221');
  await page
    .getByLabel('Offline spread photo (optional)')
    .setInputFiles({ name: 'slow-photo.png', mimeType: 'image/png', buffer: image });
  const submit = page.getByRole('button', { name: 'Start reading', exact: true });
  await expect(submit).toBeDisabled();
  let submissions = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/requests')) submissions++;
  });
  await page
    .locator('form.new-reading')
    .evaluate((form) =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  expect(submissions).toBe(0);
  await page.evaluate(() =>
    (window as unknown as { releasePhotoReads: () => Promise<void> }).releasePhotoReads(),
  );
  await expect(submit).toBeEnabled();
  const posted = page.waitForRequest(
    (request) => request.url().endsWith('/api/v1/requests') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  const input = (await posted).postDataJSON();
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
  expect(input.spreadPhoto).toBe(`data:image/png;base64,${image.toString('base64')}`);
  await expect(page.getByTestId('spread-photo-card')).toBeVisible();
  const reference = page.getByRole('img', {
    name: 'Your uploaded spread, for reference while writing',
  });
  await expect(reference).toHaveAttribute('src', input.spreadPhoto);
  await page
    .getByLabel('Your reflection', { exact: true })
    .fill('Synthetic reflection on my spread');
  await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit reflection', exact: true })).toBeVisible();
  await expect(reference).toHaveAttribute('src', input.spreadPhoto);
  expect(submissions).toBe(1);
});

test('the photo picker can replace and remove an attachment on mobile without starting a reading', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await form(page, '192.0.2.226');
  let submissions = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/requests')) submissions++;
  });
  for (const name of ['my-spread.png', 'replacement-spread.png']) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose photo', exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: image });
    await expect(page.getByTestId('spread-photo-preview')).toContainText(name);
    await expect(page.getByRole('button', { name: 'Start reading', exact: true })).toBeEnabled();
  }
  await page.getByRole('button', { name: 'Remove photo', exact: true }).click();
  await expect(page.getByTestId('spread-photo-preview')).toHaveCount(0);
  await expect(page.getByLabel('Your question')).toHaveValue('How can I compare my options?');
  await expect(page.getByRole('button', { name: 'Choose photo', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose photo', exact: true })).toBeFocused();
  expect(submissions).toBe(0);
});

test('the latest photo selection survives a slower previous read', async ({ page }) => {
  await form(page, '192.0.2.222');
  const upload = page.getByLabel('Offline spread photo (optional)');
  await upload.setInputFiles({ name: 'slow-first.png', mimeType: 'image/png', buffer: image });
  await upload.setInputFiles({ name: 'latest-photo.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByTestId('spread-photo-preview')).toContainText('latest-photo.png');
  await page.evaluate(() =>
    (window as unknown as { releasePhotoReads: () => Promise<void> }).releasePhotoReads(),
  );
  expect(await upload.evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe(
    'latest-photo.png',
  );
  await expect(page.getByTestId('spread-photo-preview')).toContainText('latest-photo.png');
});

test('removing a photo invalidates an in-flight replacement', async ({ page }) => {
  await form(page, '192.0.2.223');
  const upload = page.getByLabel('Offline spread photo (optional)');
  await upload.setInputFiles({ name: 'original-photo.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByTestId('spread-photo-preview')).toBeVisible();
  await upload.setInputFiles({
    name: 'slow-replacement.png',
    mimeType: 'image/png',
    buffer: image,
  });
  await page.getByRole('button', { name: 'Remove photo', exact: true }).click();
  await expect(page.getByTestId('spread-photo-preview')).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { releasePhotoReads: () => Promise<void> }).releasePhotoReads(),
  );
  await expect(page.getByTestId('spread-photo-preview')).toHaveCount(0);
});
