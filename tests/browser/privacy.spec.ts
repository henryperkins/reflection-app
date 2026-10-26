import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { account, reading, savedSnapshot } from '../fixtures/browser-reading.ts';

test('erase an old reflection revision with consent off while keeping current text and an unsubmitted draft', async ({
  page,
}) => {
  await account(page, '192.0.2.101');
  await reading(page, 'Synthetic exact revision deletion');
  await page
    .getByLabel('Your reflection', { exact: true })
    .fill('Synthetic old reflection to erase');
  await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(page.getByText('Reflection saved.', { exact: true })).toBeVisible();
  await page
    .getByLabel('Your reflection', { exact: true })
    .fill('Synthetic current reflection to retain');
  await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(page.getByText('Reflection saved.', { exact: true })).toBeVisible();
  const saved = await savedSnapshot(page);
  await page.getByRole('button', { name: 'Turn off AI readings', exact: true }).click();
  await page.getByLabel('Your reflection', { exact: true }).fill('Synthetic unsaved local thought');
  await expect(page.getByText('Reflection revisions', { exact: true })).toBeVisible();
  await page.getByText('Reflection revisions', { exact: true }).click();
  await page.getByLabel('Saved reflection revision', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'View revision', exact: true }).click();
  await expect(page.getByText('Synthetic old reflection to erase', { exact: true })).toBeVisible();
  await page.getByLabel('Permanently erase this reflection revision').check();
  await page.getByRole('button', { name: 'Erase revision 1', exact: true }).click();
  await expect(page.getByText('Reflection revision erased.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
    'Synthetic unsaved local thought',
  );
  const values = await page.evaluate(
    async ({ id, edition }) => ({
      old: (await fetch(`/api/v1/reflections/${id}?revision=1`)).status,
      current: await (await fetch(`/api/v1/reflections/${id}`)).json(),
      reading: await (await fetch(`/api/v1/readings/${edition}`)).json(),
    }),
    { id: saved.session.reflectionIds[0]!, edition: saved.reading.editionId },
  );
  expect(values.old).toBe(410);
  expect(values.current).toMatchObject({
    revision: 2,
    text: 'Synthetic current reflection to retain',
  });
  expect(values.reading).toEqual(saved.reading);
  await page.screenshot({ path: '/tmp/reflection-privacy-revision-desktop.png', fullPage: true });
});

for (const lost of [false, true])
  test(`account deletion keeps a usable downloadable receipt after ${lost ? 'a lost response' : 'sign-out'}`, async ({
    page,
    browser,
  }) => {
    const faults: string[] = [];
    page.on('pageerror', (error) => faults.push(error.message));
    await account(page, lost ? '192.0.2.103' : '192.0.2.102');
    await reading(page, 'Synthetic account to erase');
    await page.getByRole('button', { name: 'Save reading', exact: true }).click();
    await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
    const saved = await savedSnapshot(page);
    if (lost)
      await page.route('**/api/v1/account', async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        await route.abort('failed');
      });
    await expect(page.getByText('Delete account', { exact: true })).toBeVisible();
    await page.getByText('Delete account', { exact: true }).click();
    await page.getByLabel('Permanently delete my account, readings and reflections').check();
    await page.getByRole('button', { name: 'Delete account permanently', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Deletion receipt', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Sign in with a passkey', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('accepted-reading')).toHaveCount(0);
    await page.getByRole('button', { name: 'Check deletion status', exact: true }).click();
    await expect(page.getByText('Active-store deletion complete.', { exact: true })).toBeVisible();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download deletion receipt', exact: true }).click();
    const receipt = JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
    expect(receipt).toMatchObject({
      format: 'reflection-deletion-receipt.v1',
      origin: 'http://localhost:8787',
    });
    expect(receipt.receiptToken).toHaveLength(43);
    expect(JSON.stringify(receipt)).not.toContain(saved.me.subjectId);
    const fresh = await browser.newContext({ baseURL: 'http://localhost:8787' });
    expect(
      (
        await fresh.request.get(`/api/v1/deletions/${receipt.receiptId}`, {
          headers: { 'X-Deletion-Token': receipt.receiptToken },
        })
      ).status(),
    ).toBe(200);
    expect((await fresh.request.get(`/api/v1/readings/${saved.reading.editionId}`)).status()).toBe(
      401,
    );
    const storage = await page.evaluate(async () => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
      databases: await indexedDB.databases(),
      caches: await caches.keys(),
    }));
    expect(storage).toEqual({ local: {}, session: {}, databases: [], caches: [] });
    expect(faults).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `/tmp/reflection-privacy-receipt-${lost ? 'lost' : 'complete'}-mobile.png`,
      fullPage: true,
    });
    expect(await page.locator('body').evaluate((el) => el.scrollWidth <= innerWidth)).toBe(true);
    await fresh.close();
  });
