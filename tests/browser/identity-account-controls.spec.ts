import { expect, test } from '@playwright/test';
import { apiSchemas } from '../../src/contracts/index.ts';
import {
  account,
  backToReadings,
  enableAi,
  openAccount,
  reading,
} from '../fixtures/browser-reading.ts';

test('a signed-in person adds a passkey, removes the old one, and signs out every session', async ({
  page,
  browser,
}) => {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  const { auth } = await account(page, '192.0.2.171');
  await openAccount(page);
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
  await expect(page.getByRole('status').filter({ hasText: 'Passkey added.' })).toBeVisible();
  expect(addChallengeSeen).toBe(true);
  expect((await elsewhere.request.get('http://localhost:8787/api/v1/me')).status()).toBe(401);
  await expect(anotherTab.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
  await expect(
    anotherTab
      .getByRole('status')
      .filter({ hasText: 'Your account session changed in another tab.' }),
  ).toBeVisible();
  expect(await anotherTab.evaluate(() => ({ ...sessionStorage }))).toEqual({});
  await page
    .getByRole('button', { name: `Remove passkey ${first.id.slice(0, 8)}`, exact: true })
    .click();
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: 'Passkey removed.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove passkey / })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download recovery kit' })).toHaveCount(0);
  await page.evaluate(async () => {
    sessionStorage.setItem('reflection-intent', 'private-current-intent');
    const cache = await caches.open('unexpected-private-cache');
    await cache.put('/api/v1/me', new Response('private-cache-marker'));
  });
  await page.getByRole('button', { name: 'Sign out of all devices', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  expect(await page.evaluate(() => ({ ...sessionStorage }))).toEqual({});
  await expect
    .poll(() => page.evaluate(async () => Boolean(await caches.match('/api/v1/me'))))
    .toBe(false);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Your readings' })).toBeVisible();
  await openAccount(page);
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  expect(faults).toEqual([]);
  await elsewhere.close();
});

test('an ended session clears the workspace and announces signing in again as a notice', async ({
  page,
}) => {
  await account(page, '192.0.2.178');
  await page.route(/\/api\/v1\/sessions\?status=saved$/, (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{}',
    }),
  );
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your readings' })).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'Your session ended. Please sign in again.' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('account settings appear only on the account page, never beside the readings', async ({
  page,
}) => {
  await account(page, '192.0.2.174');
  const settings = [
    page.getByRole('region', { name: 'Manage passkeys' }),
    page.getByRole('button', { name: /^(Enable|Turn off) AI readings$/ }),
    page.getByRole('button', { name: 'Export my records', exact: true }),
    page.getByRole('button', { name: 'Replace recovery kit', exact: true }),
    page.getByRole('button', { name: 'Sign out', exact: true }),
    page.getByRole('button', { name: 'Sign out of all devices', exact: true }),
    page.getByText('Delete account', { exact: true }),
  ];
  await expect(page.getByRole('button', { name: 'Saved readings', exact: true })).toBeVisible();
  for (const control of settings) await expect(control).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New reading', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'turn on AI readings in your account' }).click();
  await expect(page).toHaveURL('http://localhost:8787/account');
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Account', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  for (const control of settings) await expect(control).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your readings' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'AI readings are on', exact: true }),
  ).toBeVisible();
  await backToReadings(page);
  await expect(page).toHaveURL('http://localhost:8787/');
  await expect(page.getByRole('link', { name: 'Account', exact: true })).not.toHaveAttribute(
    'aria-current',
  );
  await expect(page.getByText(/^AI readings are off\./)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New reading', exact: true })).toBeEnabled();
  for (const control of settings) await expect(control).toHaveCount(0);
});

test('an unsaved reflection asks before the account page closes it, from the link or browser Back', async ({
  page,
}) => {
  await account(page, '192.0.2.180');
  await reading(page, 'Synthetic reflection kept from the account page');
  const url = page.url();
  await openAccount(page);
  await backToReadings(page);
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
  const reflection = page.getByLabel('Your reflection', { exact: true });
  await reflection.fill('Synthetic unsaved reflection');
  const messages: string[] = [];
  let discard = false;
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message());
    await (discard ? dialog.accept() : dialog.dismiss());
  });
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect.poll(() => messages.length).toBe(1);
  await expect(page.getByRole('heading', { name: 'Your readings' })).toBeVisible();
  await expect(reflection).toHaveValue('Synthetic unsaved reflection');
  await page.goBack();
  await expect.poll(() => messages.length).toBe(2);
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('heading', { name: 'Your readings' })).toBeVisible();
  await expect(reflection).toHaveValue('Synthetic unsaved reflection');
  expect(messages.every((text) => text.startsWith('Discard your unsaved reflection?'))).toBe(true);
  discard = true;
  await openAccount(page);
  expect(messages).toHaveLength(3);
  await backToReadings(page);
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
  await expect(reflection).toHaveValue('');
});

test('an unsaved question asks before the account page and Back to readings returns to the form', async ({
  page,
}) => {
  await account(page, '192.0.2.181');
  await enableAi(page);
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  const question = page.getByLabel('Your question');
  await question.fill('Synthetic question kept from the account page');
  const messages: string[] = [];
  let discard = false;
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message());
    await (discard ? dialog.accept() : dialog.dismiss());
  });
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect
    .poll(() => messages)
    .toEqual(['Discard your unsaved question? Choose Cancel to stay and keep editing.']);
  await expect(page).toHaveURL('http://localhost:8787/new');
  await expect(question).toHaveValue('Synthetic question kept from the account page');
  discard = true;
  await openAccount(page);
  await backToReadings(page);
  await expect(page).toHaveURL('http://localhost:8787/new');
  await expect(page.getByRole('heading', { name: 'A new reading', exact: true })).toBeVisible();
  await expect(question).toHaveValue('');
  await openAccount(page);
  expect(messages).toHaveLength(2);
});

for (const preparation of ['ready', 'preparing'] as const) {
  test(`an unsaved photo ${preparation} asks before account navigation even without a question`, async ({
    page,
  }) => {
    if (preparation === 'preparing') {
      await page.addInitScript(() => {
        FileReader.prototype.readAsDataURL = () => {};
      });
    }
    await account(page, preparation === 'ready' ? '192.0.2.224' : '192.0.2.225');
    await enableAi(page);
    await page.getByRole('button', { name: 'New reading', exact: true }).click();
    await page.getByLabel('Photo of your spread (optional)').setInputFiles({
      name: 'spread.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    const preview = page.getByTestId('spread-photo-preview');
    if (preparation === 'ready') await expect(preview.getByRole('img')).toBeVisible();
    else await expect(preview.getByRole('status')).toHaveText('Preparing photo…');
    await expect(page.getByLabel('Your question', { exact: true })).toHaveValue('');
    const messages: string[] = [];
    let discard = false;
    page.on('dialog', async (dialog) => {
      messages.push(dialog.message());
      await (discard ? dialog.accept() : dialog.dismiss());
    });
    await page.getByRole('link', { name: 'Account', exact: true }).click();
    await expect
      .poll(() => messages)
      .toEqual(['Discard your unsaved spread photo? Choose Cancel to stay and keep editing.']);
    await expect(page).toHaveURL('http://localhost:8787/new');
    await expect(preview).toContainText('spread.png');
    discard = true;
    await openAccount(page);
    await backToReadings(page);
    await expect(page).toHaveURL('http://localhost:8787/new');
    await expect(preview).toHaveCount(0);
    expect(messages).toHaveLength(2);
  });
}

for (const navigation of ['link', 'Back'] as const) {
  test(`account navigation by ${navigation} asks before discarding a question hidden in history`, async ({
    page,
  }) => {
    await account(page, navigation === 'link' ? '192.0.2.182' : '192.0.2.183');
    await enableAi(page);
    await openAccount(page);
    await backToReadings(page);
    await page.getByRole('button', { name: 'New reading', exact: true }).click();
    const question = page.getByLabel('Your question', { exact: true });
    await question.fill('Synthetic question hidden behind saved readings');
    await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeVisible();
    const messages: string[] = [];
    let discard = false;
    page.on('dialog', async (dialog) => {
      messages.push(dialog.message());
      await (discard ? dialog.accept() : dialog.dismiss());
    });
    const visitAccount = () =>
      navigation === 'Back'
        ? page.goBack()
        : page.getByRole('link', { name: 'Account', exact: true }).click();
    await visitAccount();
    await expect
      .poll(() => messages)
      .toEqual(['Discard your unsaved question? Choose Cancel to stay and keep editing.']);
    await expect(page).toHaveURL('http://localhost:8787/');
    await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New reading', exact: true }).click();
    await expect(question).toHaveValue('Synthetic question hidden behind saved readings');
    await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeVisible();
    discard = true;
    await visitAccount();
    await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
    expect(messages).toHaveLength(2);
    await backToReadings(page);
    await page.getByRole('button', { name: 'New reading', exact: true }).click();
    await expect(question).toHaveValue('');
  });
}

for (const navigation of ['Back', 'Forward'] as const) {
  for (const destination of ['form', 'reading'] as const) {
    test(`account navigation by ${navigation} returns to the current ${destination}`, async ({
      page,
    }) => {
      await account(
        page,
        `192.0.2.${184 + (navigation === 'Forward' ? 2 : 0) + (destination === 'reading' ? 1 : 0)}`,
      );
      await openAccount(page);
      await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'AI readings are on', exact: true }),
      ).toBeVisible();
      if (navigation === 'Back') await backToReadings(page);
      else await page.goBack();
      await page.getByRole('button', { name: 'New reading', exact: true }).click();
      let starts = 0;
      page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/requests')
          starts++;
      });
      if (destination === 'reading') {
        await page
          .getByLabel('Your question', { exact: true })
          .fill('Synthetic current return destination');
        await page.getByLabel('Use English for this reading').check();
        await page.getByRole('button', { name: 'Start reading', exact: true }).click();
        await expect(page.getByTestId('accepted-reading')).toBeVisible();
      }
      const url = page.url();
      if (navigation === 'Back') await page.goBack();
      else await page.goForward();
      await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Back to readings', exact: true }),
      ).toHaveAttribute('href', new URL(url).pathname);
      await backToReadings(page);
      await expect(page).toHaveURL(url);
      if (destination === 'reading')
        await expect(page.getByTestId('accepted-reading')).toBeVisible();
      else await expect(page.getByLabel('Your question', { exact: true })).toHaveValue('');
      expect(starts).toBe(destination === 'reading' ? 1 : 0);
    });
  }
}

test('a session check keeps the reading workspace visible and its draft intact while blocking interaction', async ({
  page,
}) => {
  await account(page, '192.0.2.177');
  await enableAi(page);
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  const workspace = page.locator('.reading-workspace');
  const question = page.locator('#reading-question');
  await question.fill('Synthetic question kept during a session check');
  const position = () =>
    workspace.evaluate((element) => ({
      top: element.getBoundingClientRect().top + window.scrollY,
      width: element.getBoundingClientRect().width,
    }));
  const originalPosition = await position();
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  await page.route('**/api/v1/me', async (route) => {
    await paused;
    await route.continue();
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(workspace.locator('..')).toHaveAttribute('inert', '');
    await expect(workspace).toBeVisible();
    expect(await position()).toEqual(originalPosition);
    await question.evaluate((element) => element.focus());
    await expect(question).not.toBeFocused();
  } finally {
    resume();
  }
  await expect(workspace.locator('..')).not.toHaveAttribute('inert');
  await expect(question).toHaveValue('Synthetic question kept during a session check');
});

test('cancelling the passkey prompt leaves credentials unchanged and account controls usable', async ({
  page,
}) => {
  await account(page, '192.0.2.172');
  await openAccount(page);
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
  await expect(page.getByRole('alert')).toContainText('prompt was closed or timed out');
  await expect(page.getByRole('list', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add a passkey', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
});

test('a failed recovery-kit replacement keeps the freshly authenticated account controls usable', async ({
  page,
}) => {
  await account(page, '192.0.2.173');
  await openAccount(page);
  await page.route('**/api/v1/auth/recovery-codes', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
  );
  await page.getByRole('button', { name: 'Replace recovery kit', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A place to return to.' })).toBeVisible();
});
