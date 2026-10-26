import { readFile } from 'node:fs/promises';
import { apiSchemas } from '../../src/contracts/index.ts';
import { expect, type Page, test } from '@playwright/test';
async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}
test('complete downloaded kit recovers the same account in a new browser without the original passkey', async ({
  browser,
  page,
}) => {
  const faults: string[] = [],
    outbound: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  await page.context().route('**/*', (route) => {
    if (new URL(route.request().url()).hostname !== 'localhost') {
      outbound.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const original = await authenticator(page);
  const initial = await page.goto('/');
  expect(initial?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
  await expect(page).toHaveTitle(/Reflection/);
  await page.screenshot({ path: '/tmp/reflection-identity-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Create a test account' }).click();
  await expect(page.getByRole('heading', { name: 'Keep your recovery kit' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery kit' }).click();
  const download = await downloadPromise;
  const kit = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(kit.recoveryHandle).toBeTruthy();
  expect(kit.codes).toHaveLength(10);
  expect(kit.origin).toBe('http://localhost:8787');
  await page.getByLabel('I have saved the complete kit with the handle and codes.').check();
  await page.getByRole('button', { name: 'Continue to account' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  const before = apiSchemas.SessionView.parse(
    await page.evaluate(async () => (await fetch('/api/v1/me')).json()),
  );
  expect(before.permission.modelAllowed).toBe(false);
  const storage = await page.evaluate(async () => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
    databases: await indexedDB.databases(),
  }));
  expect(storage).toEqual({ local: {}, session: {}, databases: [] });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await original.cdp.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId: original.authenticatorId,
  });
  await page.context().clearCookies();
  await page.goto('about:blank');
  await page.close();
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const recoveredPage = await fresh.newPage();
  recoveredPage.on('pageerror', (error) => faults.push(error.message));
  await fresh.route('**/*', (route) => {
    if (new URL(route.request().url()).hostname !== 'localhost') {
      outbound.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await authenticator(recoveredPage);
  await recoveredPage.goto('/recover');
  await recoveredPage.getByLabel('Recovery handle').fill(kit.recoveryHandle);
  await recoveredPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await recoveredPage.waitForTimeout(200); // Let a focus-triggered /me response settle.
  await expect(recoveredPage.getByLabel('Recovery handle')).toHaveValue(kit.recoveryHandle);
  await recoveredPage.getByLabel('Unused recovery code').fill(kit.codes[0]);
  await recoveredPage.getByRole('button', { name: 'Verify recovery kit' }).click();
  await expect(
    recoveredPage.getByRole('heading', { name: 'Create your replacement passkey' }),
  ).toBeVisible();
  expect((await fresh.request.get('http://localhost:8787/api/v1/me')).status()).toBe(401);
  await recoveredPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await recoveredPage.waitForTimeout(200);
  await expect(
    recoveredPage.getByRole('button', { name: 'Create replacement passkey' }),
  ).toBeVisible();
  await recoveredPage.getByRole('button', { name: 'Create replacement passkey' }).click();
  await expect(
    recoveredPage.getByRole('heading', { name: 'Keep your recovery kit' }),
  ).toBeVisible();
  const after = apiSchemas.SessionView.parse(
    await recoveredPage.evaluate(async () => (await fetch('/api/v1/me')).json()),
  );
  expect(after.subjectId).toBe(before.subjectId);
  expect(after.permission.modelAllowed).toBe(false);
  expect(await recoveredPage.locator('body').evaluate((el) => el.scrollWidth <= innerWidth)).toBe(
    true,
  );
  const replacementDownload = recoveredPage.waitForEvent('download');
  await recoveredPage.getByRole('button', { name: 'Download recovery kit' }).click();
  const replacement = JSON.parse(
    await readFile((await (await replacementDownload).path())!, 'utf8'),
  );
  expect(replacement.recoveryHandle).not.toBe(kit.recoveryHandle);
  await recoveredPage
    .getByLabel('I have saved the complete kit with the handle and codes.')
    .check();
  await recoveredPage.getByRole('button', { name: 'Continue to account' }).click();
  await expect(recoveredPage.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await recoveredPage.screenshot({ path: '/tmp/reflection-identity-mobile.png', fullPage: true });
  expect(faults).toEqual([]);
  expect(outbound).toEqual([]);
  await fresh.close();
});

test('cross-tab invalidation prevents a delayed registration response from restoring a kit', async ({
  page,
}) => {
  await authenticator(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a test account' })).toBeEnabled();
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route('**/api/v1/me', async (route) => {
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Create a test account' }).click();
  await ready;
  await page.evaluate(async () => {
    const channel = new BroadcastChannel('reflection-account');
    channel.postMessage('signed-out');
    await new Promise((resolve) => setTimeout(resolve, 50));
    channel.close();
  });
  release();
  await page.waitForTimeout(200);
  await expect(page.getByRole('heading', { name: 'Keep your recovery kit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download recovery kit' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
});

test('a transient session-refresh error preserves the newly issued one-time kit', async ({
  page,
}) => {
  await authenticator(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a test account' })).toBeEnabled();
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
  );
  await page.getByRole('button', { name: 'Create a test account' }).click();
  await expect(page.getByRole('heading', { name: 'Keep your recovery kit' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(200);
  await expect(page.getByRole('button', { name: 'Download recovery kit' })).toBeEnabled();
});

test('the local maintenance driver invokes the running Worker scheduled handler', async () => {
  const { dispatchLocalMaintenance } = await import('../../scripts/local-maintenance.ts');
  await expect(dispatchLocalMaintenance()).resolves.toBeUndefined();
});

test('an explicitly invalidated session clears a replacement kit after rotation', async ({
  page,
}) => {
  await page.context().setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.44' });
  await authenticator(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a test account' }).click();
  await expect(page.getByRole('heading', { name: 'Keep your recovery kit' })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery kit' }).click();
  await downloaded;
  await page.getByLabel('I have saved the complete kit with the handle and codes.').check();
  await page.getByRole('button', { name: 'Continue to account' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  let invalidated = false;
  await page.route('**/api/v1/auth/recovery-codes', async (route) => {
    const response = await route.fetch();
    invalidated = true;
    await route.fulfill({ response });
  });
  await page.route('**/api/v1/me', (route) =>
    invalidated
      ? route.fulfill({ status: 401, contentType: 'application/json', body: '{}' })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'Replace recovery kit' }).click();
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download recovery kit' })).toHaveCount(0);
});
