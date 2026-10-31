import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  apiSchemas,
  AcceptedReading,
  AnyAcceptedReading,
  ContentBundle,
} from '../../src/contracts/index.ts';
import { renderFacts } from '../../src/domain/tarot/facts.ts';

import {
  authenticator,
  keepKit,
  account,
  enableAi,
  backToReadings,
  openAccount,
  reading,
  savedSnapshot,
} from '../fixtures/browser-reading.ts';

// Keep historical v1 presentation coverage while the local generator now produces v2.
function legacyReading(value: ReturnType<typeof AnyAcceptedReading.parse>) {
  if (value.kind === 'tarot.accepted.v1') return value;
  const {
    draw: _draw,
    spread: _spread,
    relationships: _relationships,
    synthesis: _synthesis,
    action: _action,
    reflectionQuestion: _reflectionQuestion,
    contextReceipt: _contextReceipt,
    ...reading
  } = value;
  const { schemaHash: _schemaHash, contextHash: _contextHash, ...provenance } = value.provenance;
  return AcceptedReading.parse({
    ...reading,
    kind: 'tarot.accepted.v1',
    sources: value.sources.map(({ meaning: _meaning, ...source }) => source),
    units: value.units.map(({ contextRefs: _contextRefs, ...unit }, index) => ({
      ...unit,
      reflectionQuestion: value.sources[index]!.reflectionQuestion,
    })),
    closing: 'Synthetic legacy reading.',
    provenance,
  });
}

test('source headings preserve launch-deck names, card codes and orientations while capitalizing only the position', async ({
  page,
}) => {
  await account(page, '192.0.2.179');
  const launch = ContentBundle.parse(
    JSON.parse(
      await readFile(new URL('../../content/launch-canon-draft.json', import.meta.url), 'utf8'),
    ),
  );
  const draw = [
    { cardId: 'major-10', orientation: 'upright' },
    { cardId: 'cups-05', orientation: 'reversed' },
    { cardId: 'major-04', orientation: 'upright' },
  ] as const;
  // Exercise launch metadata through the real client without enabling it for generation.
  await page.route('**/api/v1/readings/*', async (route) => {
    const response = await route.fetch();
    const value = legacyReading(AnyAcceptedReading.parse(await response.json()));
    value.basis.deckEdition = launch.deckEdition;
    value.basis.reversals = true;
    value.basis.cards.forEach((card, index) => {
      Object.assign(card, draw[index]);
    });
    for (const count of value.basis.counts) {
      count.count = value.basis.cards.filter((card) =>
        card.cardId.startsWith(`${count.suit}-`),
      ).length;
    }
    value.sources = value.basis.cards.map(
      (card) =>
        launch.sources.find(
          (source) => source.cardId === card.cardId && source.orientation === card.orientation,
        )!,
    );
    const facts = renderFacts(value.basis);
    value.units.forEach((unit, index) => {
      unit.basisText = facts[index]!.text;
      unit.factIds = [value.basis.cards[index]!.id];
      unit.sourceIds = [value.sources[index]!.id];
    });
    await route.fulfill({ response, json: value });
  });
  await reading(page, 'Synthetic source casing inspection');
  const accepted = page.getByTestId('accepted-reading');
  await accepted.getByText('Cards and sources', { exact: true }).click();
  const headings = accepted.locator('.source h3');
  const expected = [
    'Situation: Wheel of Fortune (major-10) · upright',
    'Tension: Five of Cups (cups-05) · reversed',
    'Possibility: The Emperor (major-04) · upright',
  ];
  await expect(headings).toHaveText(expected, { useInnerText: true });
  await accepted
    .locator('details')
    .screenshot({ path: '/tmp/reflection-source-casing-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(headings).toHaveText(expected, { useInnerText: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await accepted
    .locator('details')
    .screenshot({ path: '/tmp/reflection-source-casing-mobile.png' });
});

test('card names match the deck edition beside unchanged facts and unknown decks fall back to codes', async ({
  page,
}) => {
  await account(page, '192.0.2.175');
  const launch = ContentBundle.parse(
    JSON.parse(
      await readFile(new URL('../../content/launch-canon-draft.json', import.meta.url), 'utf8'),
    ),
  );
  let unknownDeck = false;
  await page.route('**/api/v1/readings/*', async (route) => {
    const response = await route.fetch();
    const value = legacyReading(AnyAcceptedReading.parse(await response.json()));
    if (unknownDeck) value.basis.deckEdition = 'f'.repeat(64);
    await route.fulfill({ response, json: value });
  });
  const question = 'Synthetic edition-bound card names';
  await reading(page, question);
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reading saved.' })).toBeVisible();
  const saved = await savedSnapshot(page);
  if (saved.reading.kind !== 'tarot.accepted.v1') throw new Error('Expected accepted tarot');
  expect(saved.reading.basis.deckEdition).toBe(launch.deckEdition);
  const accepted = page.getByTestId('accepted-reading');
  for (const card of saved.reading.basis.cards) {
    const name = launch.deck.find((item) => item.id === card.cardId)!.name;
    await expect(
      accepted.getByRole('heading', { name: `Drawn card: ${name}`, exact: true }),
    ).toBeVisible();
  }
  for (const unit of saved.reading.units) {
    await expect(accepted.getByText(unit.basisText, { exact: true })).toBeVisible();
  }
  unknownDeck = true;
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  await page.getByRole('button', { name: question, exact: true }).click();
  await expect(accepted.getByRole('heading', { name: 'Drawn card', exact: true })).toHaveCount(3);
  await expect(accepted.getByRole('heading', { name: /^Drawn card: / })).toHaveCount(0);
  for (const unit of saved.reading.units) {
    await expect(accepted.getByText(unit.basisText, { exact: true })).toBeVisible();
  }
});

test('a failed workspace action announces an error and keeps the reading draft', async ({
  page,
}) => {
  await account(page, '192.0.2.176');
  await reading(page, 'Synthetic failed save');
  await page
    .getByLabel('Your reflection', { exact: true })
    .fill('Synthetic draft kept after failure');
  await page.route('**/api/v1/sessions/*/reflections', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{}',
    }),
  );
  await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
    'Synthetic draft kept after failure',
  );
  await expect(page.getByRole('button', { name: 'Save reflection', exact: true })).toBeEnabled();
});

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
  await openAccount(page);
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

  await openAccount(recovered);
  await recovered.getByRole('button', { name: 'Turn off AI readings', exact: true }).click();
  await expect(
    recovered.getByRole('heading', { name: 'AI readings are off', exact: true }),
  ).toBeVisible();
  await backToReadings(recovered);
  await expect(recovered.getByTestId('accepted-reading')).toHaveText(acceptedText, {
    useInnerText: true,
  });
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
  await openAccount(recovered);
  await recovered.screenshot({ path: '/tmp/reflection-account-mobile.png', fullPage: true });
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
  await expect(
    recovered.getByRole('status').filter({ hasText: 'Export downloaded.' }),
  ).toBeVisible();
  await backToReadings(recovered);
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
  await expect(page.getByRole('button', { name: 'Save reflection', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Use the saved reflection', exact: true }).click();
  await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
    'Synthetic edit in another tab',
  );
  expect(
    await page.evaluate(
      async (id) => (await fetch(`/api/v1/reflections/${id}`)).json(),
      saved.session.reflectionIds[0]!,
    ),
  ).toMatchObject({ revision: 2, text: 'Synthetic edit in another tab' });
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

test('focus refresh keeps a dirty reflection at its original revision until explicitly reconciled', async ({
  page,
}) => {
  await account(page, '192.0.2.91');
  await reading(page, 'Synthetic focus conflict');
  await page.getByLabel('Your reflection', { exact: true }).fill('Original version');
  await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(page.getByText('Reflection saved.', { exact: true })).toBeVisible();
  const saved = await savedSnapshot(page);
  await page.getByLabel('Your reflection', { exact: true }).fill('Local draft to reconcile');
  const updated = await page.evaluate(
    async ({ id, editionId, csrf }) => {
      const response = await fetch(`/api/v1/reflections/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'If-Match': '"1"',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ text: 'Other tab latest text', stance: 'disagree', editionId }),
      });
      return response.status;
    },
    {
      id: saved.session.reflectionIds[0]!,
      editionId: saved.reading.editionId,
      csrf: saved.me.csrfToken,
    },
  );
  expect(updated).toBe(200);
  const focused = page.waitForResponse(
    (r) => r.url().includes('/api/v1/reflections/') && r.request().method() === 'GET',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await focused;
  await expect(page.getByText(/Your draft has been kept/)).toBeVisible();
  await expect(page.getByText('Other tab latest text', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved stance: Disagree', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
    'Local draft to reconcile',
  );
  await expect(page.getByRole('button', { name: 'Save reflection', exact: true })).toBeDisabled();
  const before = await page.evaluate(
    async (id) => (await fetch(`/api/v1/reflections/${id}`)).json(),
    saved.session.reflectionIds[0]!,
  );
  expect(before).toMatchObject({ revision: 2, text: 'Other tab latest text', stance: 'disagree' });
  await page.getByRole('button', { name: 'Keep my draft for the next save', exact: true }).click();
  const write = page.waitForRequest(
    (r) => r.url().includes('/api/v1/reflections/') && r.method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
  expect((await write).headers()['if-match']).toBe('"2"');
  await expect(page.getByText('Reflection saved.', { exact: true })).toBeVisible();
  const after = await page.evaluate(
    async (id) => (await fetch(`/api/v1/reflections/${id}`)).json(),
    saved.session.reflectionIds[0]!,
  );
  expect(after).toMatchObject({
    revision: 3,
    text: 'Local draft to reconcile',
    stance: 'unspecified',
  });
  // A clean editor can accept a fresh server version without rebasing any local changes.
  expect(
    await page.evaluate(
      async ({ id, editionId, csrf }) =>
        (
          await fetch(`/api/v1/reflections/${id}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrf,
              'If-Match': '"3"',
              'Idempotency-Key': crypto.randomUUID(),
            },
            body: JSON.stringify({ text: 'A newer saved version', stance: 'resonates', editionId }),
          })
        ).status,
      {
        id: saved.session.reflectionIds[0]!,
        editionId: saved.reading.editionId,
        csrf: saved.me.csrfToken,
      },
    ),
  ).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
    'A newer saved version',
  );
  await expect(page.getByLabel('How does this feel?', { exact: true })).toHaveValue('resonates');
  await expect(
    page.getByRole('button', { name: 'Keep my draft for the next save', exact: true }),
  ).toHaveCount(0);
});

test('a lost deletion response keeps the original receipt and key for a safe retry', async ({
  page,
}) => {
  await account(page, '192.0.2.95');
  await reading(page, 'Synthetic lost deletion response');
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
  const saved = await savedSnapshot(page);
  let loseResponse = true;
  await page.route(`**/api/v1/sessions/${saved.session.id}`, async (route) => {
    if (route.request().method() !== 'DELETE' || !loseResponse) return route.continue();
    loseResponse = false;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Delete reading', exact: true }).click();
  await page.getByLabel('Delete this reading and its reflections permanently').check();
  const firstRequest = page.waitForRequest((r) => r.method() === 'DELETE');
  const failure = page.waitForEvent('requestfailed', (r) => r.method() === 'DELETE');
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  const first = await firstRequest;
  await failure;
  await expect(page.getByRole('button', { name: 'Confirm deletion', exact: true })).toBeEnabled();
  const retryResponse = page.waitForResponse((r) => r.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  const retry = await retryResponse;
  expect(retry.status()).toBe(202);
  expect(retry.request().postData()).toBe(first.postData());
  expect(retry.request().headers()['idempotency-key']).toBe(first.headers()['idempotency-key']);
  expect(retry.request().headers()['if-match']).toBe(first.headers()['if-match']);
  await expect(
    page.getByText('Reading and reflections deleted. Downloaded copies are unchanged.', {
      exact: true,
    }),
  ).toBeVisible();
});

for (const destination of ['Saved readings', 'New reading']) {
  test(`leaving a dirty reflection for ${destination} requires a local stay or discard choice`, async ({
    page,
  }) => {
    await account(page, destination === 'Saved readings' ? '192.0.2.92' : '192.0.2.94');
    const question = `Synthetic navigation to ${destination}`;
    await reading(page, question);
    await page.getByRole('button', { name: 'Save reading', exact: true }).click();
    await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
    await page.getByLabel('Your reflection', { exact: true }).fill('Unsubmitted local thought');
    let dialogs = 0,
      discard = false;
    page.on('dialog', async (dialog) => {
      dialogs++;
      expect(dialog.message()).toContain('Discard');
      await (discard ? dialog.accept() : dialog.dismiss());
    });
    await page.getByRole('button', { name: destination, exact: true }).click();
    await expect(page.getByTestId('accepted-reading')).toBeVisible();
    await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
      'Unsubmitted local thought',
    );
    expect(dialogs).toBe(1);
    discard = true;
    await page.getByRole('button', { name: destination, exact: true }).click();
    if (destination === 'New reading') {
      await expect(page.getByRole('heading', { name: 'A new reading', exact: true })).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('heading', { name: 'A new reading', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
    }
    await page.getByRole('button', { name: question, exact: true }).click();
    await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue('');
    expect(dialogs).toBe(2);
    expect((await savedSnapshot(page)).session.reflectionIds).toEqual([]);
  });
}

test('a rejected deletion can be freshly confirmed against the updated reading revision', async ({
  page,
}) => {
  await account(page, '192.0.2.93');
  const question = 'Synthetic deletion revision conflict';
  await reading(page, question);
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
  const saved = await savedSnapshot(page);
  const status = await page.evaluate(
    async ({ id, editionId, csrf }) =>
      (
        await fetch(`/api/v1/sessions/${id}/reflections`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({ text: 'Other tab note', stance: 'unspecified', editionId }),
        })
      ).status,
    { id: saved.session.id, editionId: saved.reading.editionId, csrf: saved.me.csrfToken },
  );
  expect(status).toBe(201);
  const remove = async () => {
    await page.getByRole('button', { name: 'Delete reading', exact: true }).click();
    await page.getByLabel('Delete this reading and its reflections permanently').check();
    const response = page.waitForResponse((r) => r.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    return response;
  };
  const first = await remove();
  expect(first.status()).toBe(409);
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  await page.getByRole('button', { name: question, exact: true }).click();
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
  const second = await remove();
  expect(second.status()).toBe(202);
  expect(second.request().headers()['if-match']).not.toBe(first.request().headers()['if-match']);
  expect(second.request().headers()['idempotency-key']).not.toBe(
    first.request().headers()['idempotency-key'],
  );
  await expect(
    page.getByText('Reading and reflections deleted. Downloaded copies are unchanged.', {
      exact: true,
    }),
  ).toBeVisible();
});

for (const mode of ['model', 'template'] as const) {
  test(`reading attribution distinguishes OpenAI and prepared content: ${mode}`, async ({
    page,
  }) => {
    // Presentation fixture only; the D1 suite covers qualified generation itself.
    await account(page, mode === 'model' ? '192.0.2.91' : '192.0.2.92');
    await page.route('**/api/v1/readings/*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.mode = mode;
      body.provenance.provider = 'openai';
      body.provenance.fallbackReason = mode === 'template' ? 'VALIDATION' : null;
      await route.fulfill({ response, json: body });
    });
    await reading(page, 'Compare ways to develop a creative project.');
    await page.getByText('Cards and sources', { exact: true }).click();
    await expect(
      page.getByText(mode === 'model' ? 'Generated by OpenAI.' : 'Prepared reflection template.', {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Generated by the local simulation.', { exact: false }),
    ).toHaveCount(0);
  });
}

test('uploading an offline spread photo recognizes the 3 cards in one step and saves the photo with the reading', async ({
  page,
}) => {
  await account(page, '192.0.2.188');
  await enableAi(page);
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  await page.getByLabel('Your question').fill('What does my offline dealt spread suggest?');
  await page.getByLabel('Use English for this reading').check();
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.getByLabel('Offline spread photo (optional)').setInputFiles({
    name: 'dealt-spread.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  await expect(page.getByTestId('spread-photo-preview')).toBeVisible();
  await expect(page.getByText('dealt-spread.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  const accepted = page.getByTestId('accepted-reading');
  await expect(accepted).toBeVisible();
  const photoCard = accepted.getByTestId('spread-photo-card');
  await expect(photoCard).toBeVisible();
  await expect(photoCard.locator('img')).toHaveAttribute(
    'src',
    /^data:image\/png;base64,iVBORw0KGgo/,
  );
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
  const saved = await savedSnapshot(page);
  if (saved.reading.kind !== 'tarot.accepted.v1' && saved.reading.kind !== 'tarot.accepted.v2')
    throw new Error('Expected accepted tarot reading');
  expect(saved.reading.spreadPhoto).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
});
