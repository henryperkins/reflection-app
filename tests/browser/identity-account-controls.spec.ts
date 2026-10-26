import { expect, test } from '@playwright/test';
import { apiSchemas } from '../../src/contracts/index.ts';
import { account } from '../fixtures/browser-reading.ts';

test('a signed-in person adds a passkey, removes the old one, and signs out every session', async ({
  page,
  browser,
}) => {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  const { auth } = await account(page, '192.0.2.171');
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  const first = apiSchemas.Credentials.parse(
    await page.evaluate(async () => (await fetch('/api/v1/auth/credentials')).json()),
  ).items[0]!;
  const originalSession = await page.context().cookies();
  const elsewhere = await browser.newContext();
  await elsewhere.addCookies(originalSession);
  const anotherTab = await page.context().newPage();
  await anotherTab.goto('/account');
  await expect(anotherTab.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await anotherTab.evaluate(() => {
    sessionStorage.setItem('reflection-intent', 'private-old-intent');
  });
  let addChallengeSeen = false;
  await page.route('**/api/v1/auth/options', async (route) => {
    if (route.request().postDataJSON().purpose !== 'add') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    addChallengeSeen = true;
    await auth.cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: auth.authenticatorId,
    });
    await auth.cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(2);
  expect(addChallengeSeen).toBe(true);
  expect((await elsewhere.request.get('http://localhost:8787/api/v1/me')).status()).toBe(401);
  await expect(anotherTab.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
  expect(await anotherTab.evaluate(() => ({ ...sessionStorage }))).toEqual({});
  await page
    .getByRole('button', { name: `Remove passkey ${first.id.slice(0, 8)}`, exact: true })
    .click();
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Remove passkey / })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download recovery kit' })).toHaveCount(0);
  await page.evaluate(async () => {
    sessionStorage.setItem('reflection-intent', 'private-current-intent');
    const cache = await caches.open('unexpected-private-cache');
    await cache.put('/api/v1/me', new Response('private-cache-marker'));
  });
  await page.getByRole('button', { name: 'Log out all devices', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  expect(await page.evaluate(() => ({ ...sessionStorage }))).toEqual({});
  await expect
    .poll(() => page.evaluate(async () => Boolean(await caches.match('/api/v1/me'))))
    .toBe(false);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  expect(faults).toEqual([]);
  await elsewhere.close();
});

test('cancelling the passkey prompt leaves credentials unchanged and account controls usable', async ({
  page,
}) => {
  await account(page, '192.0.2.172');
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  await page.evaluate(() => {
    Object.defineProperty(navigator.credentials, 'create', {
      configurable: true,
      value: async () => {
        throw new DOMException('cancelled', 'NotAllowedError');
      },
    });
  });
  await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not completed');
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add a passkey', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
});

test('a failed recovery-kit replacement keeps the freshly authenticated account controls usable', async ({
  page,
}) => {
  await account(page, '192.0.2.173');
  await page.route('**/api/v1/auth/recovery-codes', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
  );
  await page.getByRole('button', { name: 'Replace recovery kit', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
});
