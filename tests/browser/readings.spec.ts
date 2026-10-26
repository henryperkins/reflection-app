import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { apiSchemas } from '../../src/contracts/index.ts';

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
async function keepKit(page: Page) {
  await expect(page.getByRole('heading', { name: 'Keep your recovery kit' })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery kit' }).click();
  const kit = JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
  await page.getByLabel('I have saved the complete kit with the handle and codes.').check();
  await page.getByRole('button', { name: 'Continue to account' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  return kit;
}
async function account(page: Page, ip: string) {
  await page.context().setExtraHTTPHeaders({ 'CF-Connecting-IP': ip });
  const auth = await authenticator(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a test account' }).click();
  return { auth, kit: await keepKit(page) };
}
async function reading(page: Page, question: string) {
  await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  await page.getByLabel('Your question').fill(question);
  await page.getByLabel('Use English for this reading').check();
  await expect(page.getByText(/Start temporarily stores/)).toBeVisible();
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
}
async function savedSnapshot(page: Page) {
  const result = await page.evaluate(async () => {
    const history = (await (await fetch('/api/v1/sessions?status=saved')).json()) as {
      items: Array<{ id: string; latestEditionId: string }>;
    };
    const item = history.items[0]!;
    return {
      item,
      reading: await (await fetch(`/api/v1/readings/${item.latestEditionId}`)).json(),
      session: await (await fetch(`/api/v1/sessions/${item.id}`)).json(),
      me: await (await fetch('/api/v1/me')).json(),
    };
  });
  return {
    ...result,
    reading: apiSchemas.Reading.parse(result.reading),
    session: apiSchemas.SessionRecord.parse(result.session),
    me: apiSchemas.SessionView.parse(result.me),
  };
}

test('save, sign in, recover from the downloaded kit, and manage the same reading with AI consent off', async ({
  browser,
  page,
}) => {
  const faults: string[] = [],
    outbound: string[] = [],
    generationRequests: string[] = [];
  const watch = async (target: Page) => {
    target.on('pageerror', (e) => faults.push(e.message));
    target.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/requests')
        generationRequests.push(r.url());
    });
    await target.context().route('**/*', (route) => {
      if (new URL(route.request().url()).hostname !== 'localhost') {
        outbound.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
  };
  await watch(page);
  const { auth, kit } = await account(page, '192.0.2.71');
  const question = 'Synthetic reading to return to after recovery';
  await reading(page, question);
  // biome-ignore lint/performance/useDomNodeTextContent: compare the actual rendered text, excluding collapsed source details.
  const acceptedText = await page.getByTestId('accepted-reading').innerText();
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
  const original = await savedSnapshot(page);
  expect(original.session.reflectionIds).toEqual([]);
  expect(original.me.remainingDay).toBe(2);
  await page.screenshot({ path: '/tmp/reflection-saved-reading-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await page.getByRole('button', { name: question, exact: true }).click();
  await expect(page.getByTestId('accepted-reading')).toHaveText(acceptedText, {
    useInnerText: true,
  });
  expect((await savedSnapshot(page)).reading).toEqual(original.reading);
  expect(generationRequests).toHaveLength(1);
  await auth.cdp.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId: auth.authenticatorId,
  });
  await auth.cdp.send('Storage.clearDataForOrigin', {
    origin: 'http://localhost:8787',
    storageTypes: 'all',
  });
  await page.goto('about:blank');
  await page.close();

  const fresh = await browser.newContext({
    baseURL: 'http://localhost:8787',
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.71' },
  });
  const recovered = await fresh.newPage();
  await watch(recovered);
  await authenticator(recovered);
  await recovered.goto('/recover');
  await recovered.getByLabel('Recovery handle').fill(kit.recoveryHandle);
  await recovered.getByLabel('Unused recovery code').fill(kit.codes[0]);
  await recovered.getByRole('button', { name: 'Verify recovery kit' }).click();
  await expect(
    recovered.getByRole('heading', { name: 'Create your replacement passkey' }),
  ).toBeVisible();
  expect((await fresh.request.get(`/api/v1/readings/${original.reading.editionId}`)).status()).toBe(
    401,
  );
  await recovered.getByRole('button', { name: 'Create replacement passkey' }).click();
  const replacement = await keepKit(recovered);
  expect(replacement.recoveryHandle).not.toBe(kit.recoveryHandle);
  await recovered.getByRole('button', { name: question, exact: true }).click();
  await expect(recovered.getByTestId('accepted-reading')).toHaveText(acceptedText, {
    useInnerText: true,
  });
  const returned = await savedSnapshot(recovered);
  expect(returned.reading).toEqual(original.reading);
  expect(returned.me.subjectId).toBe(original.me.subjectId);
  expect(returned.me.remainingDay).toBe(2);
  expect(generationRequests).toHaveLength(1);

  await recovered.getByRole('button', { name: 'Turn off AI readings', exact: true }).click();
  await expect(
    recovered.getByRole('heading', { name: 'AI readings are off', exact: true }),
  ).toBeVisible();
  await expect(recovered.getByRole('button', { name: 'New reading', exact: true })).toBeDisabled();
  await recovered.getByRole('button', { name: 'Saved readings', exact: true }).click();
  await recovered.getByRole('button', { name: question, exact: true }).click();
  await recovered
    .getByLabel('Your reflection', { exact: true })
    .fill('Synthetic thought added after recovery.');
  await recovered.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(recovered.getByText('Reflection saved.', { exact: true })).toBeVisible();
  await recovered
    .getByLabel('Your reflection', { exact: true })
    .fill('Synthetic reflection edited with AI off.');
  await recovered.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(recovered.getByText('Reflection saved.', { exact: true })).toBeVisible();
  await expect(recovered.getByTestId('accepted-reading')).toHaveText(acceptedText, {
    useInnerText: true,
  });
  await recovered.screenshot({ path: '/tmp/reflection-saved-reading-mobile.png', fullPage: true });
  expect(await recovered.locator('body').evaluate((el) => el.scrollWidth <= innerWidth)).toBe(true);
  const exported = recovered.waitForEvent('download');
  await recovered.getByRole('button', { name: 'Export my records', exact: true }).click();
  const pages = (await readFile((await (await exported).path())!, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => apiSchemas.ExportPage.parse(JSON.parse(line)));
  const records = pages.flatMap((value) => value.records);
  expect(records.find((r) => r.kind === 'reading')?.value).toEqual(original.reading);
  expect(records.filter((r) => r.kind === 'reflection').map((r) => r.value.text)).toEqual([
    'Synthetic thought added after recovery.',
    'Synthetic reflection edited with AI off.',
  ]);
  await recovered.getByRole('button', { name: 'Delete reading', exact: true }).click();
  await recovered.getByLabel('Delete this reading and its reflections permanently').check();
  await recovered.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await expect(recovered.getByText('No saved readings yet.', { exact: true })).toBeVisible();
  expect((await fresh.request.get(`/api/v1/readings/${original.reading.editionId}`)).status()).toBe(
    410,
  );
  expect(generationRequests).toHaveLength(1);
  const storage = await recovered.evaluate(async () => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
    databases: await indexedDB.databases(),
    caches: await caches.keys(),
  }));
  expect(storage).toEqual({ local: {}, session: {}, databases: [], caches: [] });
  expect(faults).toEqual([]);
  expect(outbound).toEqual([]);
  await fresh.close();
});

test('Save reading keeps an unsaved reflection draft and conflicting edits keep the local text', async ({
  page,
}) => {
  await account(page, '192.0.2.72');
  await reading(page, 'Synthetic draft preservation');
  await page
    .getByLabel('Your reflection', { exact: true })
    .fill('Synthetic draft kept only in memory');
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
    'Synthetic draft kept only in memory',
  );
  expect((await savedSnapshot(page)).session.reflectionIds).toEqual([]);
  await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(page.getByText('Reflection saved.', { exact: true })).toBeVisible();
  const saved = await savedSnapshot(page);
  await page
    .getByLabel('Your reflection', { exact: true })
    .fill('Synthetic local conflicting draft');
  const status = await page.evaluate(
    async ({ id, editionId, csrf }) =>
      (
        await fetch(`/api/v1/reflections/${id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'If-Match': '"1"',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            text: 'Synthetic edit in another tab',
            stance: 'unspecified',
            editionId,
          }),
        })
      ).status,
    {
      id: saved.session.reflectionIds[0]!,
      editionId: saved.reading.editionId,
      csrf: saved.me.csrfToken,
    },
  );
  expect(status).toBe(200);
  await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(page.getByText(/Your draft has been kept/)).toBeVisible();
  await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
    'Synthetic local conflicting draft',
  );
});

test('a delayed reading response cannot repopulate private content after cross-tab sign-out', async ({
  page,
}) => {
  await account(page, '192.0.2.73');
  const question = 'Synthetic private content must clear';
  await reading(page, question);
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      arrived = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  await page.route('**/api/v1/readings/*', async (route) => {
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: question, exact: true }).click();
  await ready;
  await page.evaluate(() => {
    const channel = new BroadcastChannel('reflection-account');
    channel.postMessage('signed-out');
    channel.close();
  });
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  release();
  await page.waitForTimeout(150);
  await expect(page.getByTestId('accepted-reading')).toHaveCount(0);
  await expect(page.getByText(question, { exact: true })).toHaveCount(0);
});
