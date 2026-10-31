import { expect, test } from '@playwright/test';
import { account, enableAi, reading } from '../fixtures/browser-reading.ts';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

test('keyboard photo attachment and removal announce their outcomes without submitting', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await account(page, '192.0.2.231');
  await enableAi(page);
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  const choose = page.getByRole('button', { name: 'Choose photo', exact: true });
  await expect(choose).toHaveAccessibleDescription(
    /local simulation does not recognize real cards/,
  );
  let starts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/requests')
      starts++;
  });
  const chooser = page.waitForEvent('filechooser');
  await choose.focus();
  await page.keyboard.press('Enter');
  await (await chooser).setFiles({
    name: 'synthetic-spread.png',
    mimeType: 'image/png',
    buffer: image,
  });
  await expect(
    page.getByRole('status').filter({ hasText: 'Photo attached: synthetic-spread.png' }),
  ).toBeVisible();
  await choose.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Remove photo', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(choose).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Photo removed.' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Uploaded tarot spread preview' })).toHaveCount(0);
  expect(starts).toBe(0);
});

test('keyboard reading deletion keeps focus through confirmation, cancellation and return', async ({
  page,
}) => {
  await account(page, '192.0.2.232');
  await reading(page, 'Synthetic keyboard deletion journey');
  const trigger = page.getByRole('button', { name: 'Delete reading', exact: true });
  const confirmation = page.getByLabel('Delete this reading and its reflections permanently');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(confirmation).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirmation).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Confirm deletion', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeFocused();
  await expect(
    page.getByRole('status').filter({ hasText: 'Reading and reflections deleted.' }),
  ).toBeVisible();
});
