import { readFile } from 'node:fs/promises';
import { expect, test, type Dialog, type Page, type Request } from '@playwright/test';
import { apiSchemas } from '../../src/contracts/index.ts';
import {
  account,
  authenticator,
  backToReadings,
  keepKit,
  openAccount,
  reading,
  savedSnapshot,
} from '../fixtures/browser-reading.ts';
import { datedNotesFixture } from '../fixtures/browser-journey.ts';

async function savedReading(page: Page, ip: string) {
  const credentials = await account(page, ip);
  await reading(page, 'Synthetic dated return');
  await page.getByLabel('Your reflection', { exact: true }).fill('Original synthetic reflection.');
  await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
  await expect(page.getByText('Reflection saved.', { exact: true })).toBeVisible();
  const original = await savedSnapshot(page);
  await openAccount(page);
  await page.getByRole('button', { name: 'Turn off AI readings', exact: true }).click();
  await backToReadings(page);
  return { ...credentials, original };
}
async function add(page: Page, text: string) {
  await page.getByRole('button', { name: 'Add revisit note', exact: true }).click();
  await page.getByLabel('Your revisit note', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
}

test('dated notes keep chronological server dates, edited dates, full text and the original reading separate', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.141');
  const before = await page.getByTestId('accepted-reading').textContent();
  const fixture = await datedNotesFixture(page);
  await page.reload();
  const notes = page.getByRole('region', { name: 'Revisit notes', exact: true });
  await expect(notes.getByRole('article')).toHaveCount(2);
  await expect(notes.locator('article time').first()).toHaveAttribute(
    'datetime',
    '2026-02-01T10:00:00.000Z',
  );
  await expect(notes.locator('article time').nth(1)).toHaveAttribute(
    'datetime',
    '2026-03-02T11:30:00.000Z',
  );
  await notes.getByRole('button', { name: 'Edit note', exact: true }).first().click();
  await page.getByLabel('Your revisit note', { exact: true }).fill('😀'.repeat(2001));
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('1–2,000 characters');
  await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
    '😀'.repeat(2001),
  );
  await page.getByLabel('Your revisit note', { exact: true }).fill('😀'.repeat(2000));
  await expect(page.getByText('2,000 / 2,000 characters', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save note', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(notes.getByRole('article').first()).toContainText('😀'.repeat(2000));
  await expect(notes.getByRole('article').first()).toContainText('Edited');
  await expect(page.getByTestId('accepted-reading')).toHaveText(before!);
  await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
    'Original synthetic reflection.',
  );
  expect(fixture.generationRequests).toEqual([]);
});

test('an offline initial note list stops loading and can be retried explicitly', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.170');
  await add(page, 'Synthetic note retained across a transient read failure');
  await page.route('**/api/v1/revisits?*', (route) => route.abort('internetdisconnected'));
  await page.reload();
  const notes = page.getByRole('region', { name: 'Revisit notes', exact: true });
  await expect(notes.getByRole('alert')).toBeVisible();
  await expect(notes.getByText('Loading notes…', { exact: true })).toHaveCount(0);
  await expect(notes.getByText('No revisit notes yet.', { exact: true })).toHaveCount(0);
  await expect(notes.getByRole('button', { name: 'Add revisit note', exact: true })).toBeDisabled();
  await expect(notes.getByRole('alert')).not.toContainText('draft');
  await page.unroute('**/api/v1/revisits?*');
  await notes.getByRole('button', { name: 'Retry loading notes', exact: true }).click();
  await expect(notes.getByRole('article')).toContainText(
    'Synthetic note retained across a transient read failure',
  );
  await expect(notes.getByRole('alert')).toHaveCount(0);
  await expect(notes.getByRole('button', { name: 'Add revisit note', exact: true })).toBeEnabled();
});

test('lost create response retries the same intent once, preserves offline drafts, and stops retries after seven days', async ({
  page,
}) => {
  const { original } = await savedReading(page, '192.0.2.142');
  const keys: string[] = [];
  let lose = true;
  await page.route('**/api/v1/revisits', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']!);
    const response = await route.fetch();
    if (lose) {
      lose = false;
      return route.abort('failed');
    }
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Add revisit note', exact: true }).click();
  await page.getByLabel('Your revisit note', { exact: true }).fill('Synthetic lost response');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('draft');
  await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
    'Synthetic lost response',
  );
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const list = await page.request
    .get(`/api/v1/revisits?editionId=${original.reading.editionId}`)
    .then((r) => r.json());
  expect(list.items).toHaveLength(1);
  await page.unroute('**/api/v1/revisits');
  await page.route('**/api/v1/revisits', (route) => route.abort('internetdisconnected'));
  await page.getByRole('button', { name: 'Add revisit note', exact: true }).click();
  await page.getByLabel('Your revisit note', { exact: true }).fill('Synthetic offline draft');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('draft');
  await page.clock.setFixedTime(new Date(Date.now() + 604800001));
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/revisits')) posts++;
  });
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Seven days have passed' }),
  ).toBeVisible();
  expect(posts).toBe(0);
  await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
    'Synthetic offline draft',
  );
  await page.unroute('**/api/v1/revisits');
  await page.getByRole('button', { name: 'Reconcile saved notes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save as a new note', exact: true })).toBeVisible();
  expect(posts).toBe(0);
});

for (const mutation of ['create', 'update'] as const) {
  test(`save/cancel: accepted ${mutation} survives attempted cancellation and editor replacement`, async ({
    page,
  }) => {
    const { original } = await savedReading(
      page,
      mutation === 'create' ? '192.0.2.171' : '192.0.2.172',
    );
    const otherText = 'Synthetic other note retained during save';
    await add(page, otherText);
    if (mutation === 'update') await add(page, 'Synthetic note before guarded update');
    const before = apiSchemas.RevisitPage.parse(
      await page.request
        .get(`/api/v1/revisits?editionId=${original.reading.editionId}`)
        .then((response) => response.json()),
    );
    const region = page.getByRole('region', { name: 'Revisit notes', exact: true });
    const otherEdit = region
      .getByRole('article')
      .filter({ hasText: otherText })
      .getByRole('button', { name: 'Edit note', exact: true });
    const addNote = region.getByRole('button', { name: 'Add revisit note', exact: true });
    if (mutation === 'create') await addNote.click();
    else
      await region
        .getByRole('article')
        .filter({ hasText: 'Synthetic note before guarded update' })
        .getByRole('button', { name: 'Edit note', exact: true })
        .click();
    const submitted = `Synthetic accepted ${mutation} must reach the displayed list`;
    const newerDraft = 'Synthetic typing retained while the accepted update is pending';
    const editor = page.getByLabel('Your revisit note', { exact: true });
    await editor.fill(submitted);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accepted!: () => void;
    const pending = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const method = mutation === 'create' ? 'POST' : 'PUT';
    const writes: { method: string; path: string; revision: string | undefined }[] = [];
    let savedId = '';
    const acceptDialog = (dialog: Dialog) => dialog.accept();
    page.on('dialog', acceptDialog);
    await page.route('**/api/v1/revisits**', async (route) => {
      const request = route.request();
      if (request.method() !== method) return route.continue();
      writes.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        revision: request.headers()['if-match'],
      });
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      savedId = apiSchemas.Revisit.parse(await response.json()).id;
      if (writes.length === 1) {
        accepted();
        await gate;
      }
      await route.fulfill({ response });
    });
    try {
      await page.getByRole('button', { name: 'Save note', exact: true }).click();
      await pending;
      if (mutation === 'update') await editor.fill(newerDraft);
      const cancel = region.getByRole('button', { name: 'Cancel', exact: true });
      const controls =
        mutation === 'create' ? [cancel, otherEdit, addNote] : [otherEdit, addNote, cancel];
      const disabled = await Promise.all(controls.map((control) => control.isDisabled()));
      // Native button activation respects disabled controls without Playwright waiting for enablement.
      for (const control of controls)
        await control.evaluate((button: HTMLButtonElement) => button.click());
      const finished = page.waitForEvent('requestfinished', {
        predicate: (request) => request.method() === method,
      });
      release();
      await finished;
      // This must arrive through the delayed acknowledgement, with no manual refresh/reopen.
      await expect(region.getByRole('article').filter({ hasText: submitted })).toBeVisible();
      await expect(region.getByRole('article')).toHaveCount(2);
      expect(disabled).toEqual([true, true, true]);
      expect(writes).toHaveLength(1);
      await expect(addNote).toBeEnabled();
      await expect(otherEdit).toBeEnabled();
      if (mutation === 'update') {
        await expect(editor).toHaveValue(newerDraft);
        await expect(cancel).toBeEnabled();
        await page.getByRole('button', { name: 'Save note', exact: true }).click();
        await expect(region.getByRole('article').filter({ hasText: newerDraft })).toBeVisible();
        expect(writes).toEqual([
          { method: 'PUT', path: `/api/v1/revisits/${savedId}`, revision: '"1"' },
          { method: 'PUT', path: `/api/v1/revisits/${savedId}`, revision: '"2"' },
        ]);
      } else {
        await expect(editor).toHaveCount(0);
        expect(writes[0]).toEqual({
          method: 'POST',
          path: '/api/v1/revisits',
          revision: undefined,
        });
      }
      const after = apiSchemas.RevisitPage.parse(
        await page.request
          .get(`/api/v1/revisits?editionId=${original.reading.editionId}`)
          .then((response) => response.json()),
      );
      expect(after.items).toHaveLength(2);
      expect(after.items.find((note) => note.id === savedId)).toMatchObject({
        note: mutation === 'create' ? submitted : newerDraft,
        revision: mutation === 'create' ? 1 : 3,
      });
      expect(after.items.find((note) => note.note === otherText)).toEqual(
        before.items.find((note) => note.note === otherText),
      );
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
      page.off('dialog', acceptDialog);
    }
  });
}

test('conflicts keep the editable draft, require refreshed revision, and stale deletion needs new confirmation', async ({
  page,
}) => {
  const { original } = await savedReading(page, '192.0.2.143');
  await add(page, 'Synthetic initial note');
  const list = apiSchemas.RevisitPage.parse(
    await page.request
      .get(`/api/v1/revisits?editionId=${original.reading.editionId}`)
      .then((r) => r.json()),
  );
  const note = list.items[0]!;
  const update = async (revision: number, text: string) => {
    expect(
      (
        await page.request.put(`/api/v1/revisits/${note.id}`, {
          headers: {
            Origin: 'http://localhost:8787',
            'X-CSRF-Token': original.me.csrfToken,
            'If-Match': `"${revision}"`,
            'Idempotency-Key': crypto.randomUUID(),
          },
          data: { note: text },
        })
      ).status(),
    ).toBe(200);
  };
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await page.getByLabel('Your revisit note', { exact: true }).fill('Synthetic kept draft');
  await update(1, 'Synthetic other-tab revision');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByText(/saved note changed/)).toBeVisible();
  await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
    'Synthetic kept draft',
  );
  await page.getByRole('button', { name: 'Refresh saved note', exact: true }).click();
  await expect(page.getByRole('blockquote')).toHaveText('Synthetic other-tab revision');
  await page
    .getByRole('button', { name: 'Use this revision for my next save', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByLabel('Delete this note and all saved versions permanently').check();
  await update(3, 'Synthetic revision before deletion');
  await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(page.getByText(/confirm deletion again/)).toBeVisible();
  await expect(page.getByLabel('Delete this note and all saved versions permanently')).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByLabel('Delete this note and all saved versions permanently').check();
  await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Deletion receipt', exact: true })).toBeVisible();
  await expect(page.getByText(/Backups are kept until/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add revisit note', exact: true })).toBeFocused();
  expect((await page.request.get(`/api/v1/revisits/${note.id}?revision=1`)).status()).toBe(410);
});

test('notes and saved history survive sign-in and downloaded-kit recovery with no extra generation', async ({
  page,
  browser,
}) => {
  const { kit, original } = await savedReading(page, '192.0.2.144');
  let starts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/requests')) starts++;
  });
  await add(page, 'Synthetic first saved note');
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await page.getByLabel('Your revisit note', { exact: true }).fill('Synthetic current saved note');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
  await add(page, 'Synthetic second saved note');
  await openAccount(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export my records', exact: true }).click();
  const records = (await readFile((await (await download).path())!, 'utf8'))
    .trim()
    .split('\n')
    .flatMap((line) => apiSchemas.ExportPage.parse(JSON.parse(line)).records);
  expect(records.filter((r) => r.kind === 'revisit').map((r) => r.value.note)).toEqual(
    expect.arrayContaining([
      'Synthetic first saved note',
      'Synthetic current saved note',
      'Synthetic second saved note',
    ]),
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Revisit notes', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic dated return', exact: true }).click();
  await expect(page.getByText('Synthetic current saved note', { exact: true })).toBeVisible();
  const fresh = await browser.newContext({
    baseURL: 'http://localhost:8787',
    extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.144' },
  });
  try {
    const recovered = await fresh.newPage();
    await authenticator(recovered);
    await recovered.goto('/recover');
    await recovered.getByLabel('Recovery handle').fill(kit.recoveryHandle);
    await recovered.getByLabel('Unused recovery code').fill(kit.codes[0]);
    await recovered.getByRole('button', { name: 'Verify recovery kit', exact: true }).click();
    await recovered
      .getByRole('button', { name: 'Create replacement passkey', exact: true })
      .click();
    await keepKit(recovered);
    await recovered.getByRole('button', { name: 'Synthetic dated return', exact: true }).click();
    await expect(
      recovered.getByText('Synthetic current saved note', { exact: true }),
    ).toBeVisible();
    await expect(recovered.getByText('Synthetic second saved note', { exact: true })).toBeVisible();
    expect((await savedSnapshot(recovered)).reading).toEqual(original.reading);
  } finally {
    await fresh.close();
  }
  expect(starts).toBe(0);
});

test('note drafts participate in Account, navigation, Back and reload guards; withdrawn readings retain exact note identity', async ({
  page,
}) => {
  const { original } = await savedReading(page, '192.0.2.145');
  await add(page, 'Synthetic note for withdrawn reading');
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await page.getByLabel('Your revisit note', { exact: true }).fill('Synthetic unsaved note');
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
    'Synthetic unsaved note',
  );
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  await expect(page.getByLabel('Your revisit note', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Your revisit note', { exact: true })).toBeVisible();
  const prevented = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.route(`**/api/v1/readings/${original.reading.editionId}`, (route) =>
    route.fulfill({
      status: 410,
      json: readingError('CONTENT_UNAVAILABLE', 'Reading content is unavailable.'),
    }),
  );
  await page.reload();
  await expect(
    page.getByText('This reading is unavailable. Your saved notes remain available.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Synthetic note for withdrawn reading', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await page
    .getByLabel('Your revisit note', { exact: true })
    .fill('Synthetic edited after withdrawal');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByText('Synthetic edited after withdrawal', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByLabel('Delete this note and all saved versions permanently').check();
  await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Deletion receipt', exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic edited after withdrawal', { exact: true })).toHaveCount(0);
});

test('session expiry removes private drafts and sign-in restores only saved notes', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.146');
  await add(page, 'Synthetic saved before expiry');
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await page
    .getByLabel('Your revisit note', { exact: true })
    .fill('Synthetic draft must die with account state');
  await page.route('**/api/v1/revisits/*', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'UNAUTHENTICATED', message: 'Synthetic session ended.' } },
    }),
  );
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(
    page.getByText('Your session ended. Please sign in again.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Revisit notes', exact: true })).toHaveCount(0);
  await page.unroute('**/api/v1/revisits/*');
  await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
  await expect(page.getByText('Synthetic saved before expiry', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Synthetic draft must die with account state', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveCount(0);
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Create a test account', exact: true }).click();
  await keepKit(page);
  await expect(page.getByText('No saved readings yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic saved before expiry', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('Synthetic draft must die with account state', { exact: true }),
  ).toHaveCount(0);
});

test('late note responses cannot repopulate Account or a different reading', async ({ page }) => {
  const { original } = await savedReading(page, '192.0.2.147');
  await add(page, 'Synthetic old private note');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/revisits?*', async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await requestStarted;
  await openAccount(page);
  release();
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic old private note', { exact: true })).toHaveCount(0);
  await page.unroute('**/api/v1/revisits?*');
  await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
  await backToReadings(page);
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic dated return', exact: true }).click();
  await expect(page.getByText('Synthetic old private note', { exact: true })).toBeVisible();
  let releaseEdition!: () => void;
  const editionGate = new Promise<void>((resolve) => {
    releaseEdition = resolve;
  });
  let startedEdition!: () => void;
  const editionStarted = new Promise<void>((resolve) => {
    startedEdition = resolve;
  });
  let finishedEdition!: () => void;
  const editionFinished = new Promise<void>((resolve) => {
    finishedEdition = resolve;
  });
  const oldEdition = original.reading.editionId;
  await page.route(`**/api/v1/revisits?editionId=${oldEdition}`, async (route) => {
    const response = await route.fetch();
    startedEdition();
    await editionGate;
    await route.fulfill({ response });
    finishedEdition();
  });
  await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await editionStarted;
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  await page.getByLabel('Your question', { exact: true }).fill('Synthetic different edition');
  await page.getByLabel('Use English for this reading').check();
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
  releaseEdition();
  await editionFinished;
  await expect(page.getByText('Synthetic old private note', { exact: true })).toHaveCount(0);
});

test('legacy unsaved-parent notes show actual expiry and require the existing explicit Save reading action', async ({
  page,
}) => {
  const { original } = await savedReading(page, '192.0.2.148');
  await add(page, 'Synthetic legacy note retained on temporary parent');
  await page.route(`**/api/v1/sessions/${original.session.id}`, async (route) => {
    const response = await route.fetch();
    if (route.request().method() !== 'GET') return route.fulfill({ response });
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        status: 'open',
        savedAt: null,
        retentionExpiresAt: '2026-11-02T06:15:00.000Z',
      },
    });
  });
  await page.reload();
  const notes = page.getByRole('region', { name: 'Revisit notes', exact: true });
  await expect(
    notes.getByText('Synthetic legacy note retained on temporary parent', { exact: true }),
  ).toBeVisible();
  await expect(notes.locator('time').first()).toHaveAttribute(
    'datetime',
    '2026-11-02T06:15:00.000Z',
  );
  await expect(notes.getByRole('button', { name: 'Edit note', exact: true })).toBeDisabled();
  await expect(notes.getByRole('button', { name: 'Add revisit note', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(notes.getByRole('button', { name: 'Edit note', exact: true })).toBeEnabled();
});

test('chronological pagination keeps the active editor and authored whitespace intact', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.149');
  const fixture = await datedNotesFixture(page);
  const notes = Array.from({ length: 21 }, (_, index) => ({
    ...fixture.notes[0],
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    note: `Synthetic chronological note ${index + 1}`,
    createdAt: '2026-02-01T10:00:00.000Z',
    updatedAt: '2026-02-01T10:00:00.000Z',
  }));
  await page.route('**/api/v1/revisits?*', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).searchParams.has('cursor')
        ? { items: notes.slice(20), nextCursor: null }
        : { items: notes.slice(0, 20), nextCursor: 'synthetic-next-page' },
    }),
  );
  await page.reload();
  const region = page.getByRole('region', { name: 'Revisit notes', exact: true });
  await expect(region.getByRole('article')).toHaveCount(20);
  await region.getByRole('button', { name: 'Edit note', exact: true }).first().click();
  const draft = '  Synthetic authored spacing\n\nwith a later line.  ';
  await page.getByLabel('Your revisit note', { exact: true }).fill(draft);
  await region.getByRole('button', { name: 'Load more notes', exact: true }).click();
  await expect(region.getByRole('article')).toHaveCount(21);
  await expect(region.getByRole('article').last()).toContainText('Synthetic chronological note 21');
  await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(draft);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    region.getByRole('button', { name: 'Edit note', exact: true }).first(),
  ).toBeFocused();
});

test('parent deletion during reading fetch clears a workspace with no reflections', async ({
  page,
}) => {
  await account(page, '192.0.2.184');
  await reading(page, 'Synthetic parent deletion without reflections');
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
  const original = await savedSnapshot(page);
  expect(original.session.reflectionIds).toEqual([]);
  await add(page, 'Synthetic note before parent deletion');
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  const editor = page.getByLabel('Your revisit note', { exact: true });
  await editor.fill('Synthetic private draft on the deleted parent');
  const sessionPath = `/api/v1/sessions/${original.session.id}`;
  let deleted = false;
  await page.route(`**${sessionPath}`, async (route) => {
    if (deleted || route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const stale = apiSchemas.SessionRecord.parse(await response.json());
    expect(stale.reflectionIds).toEqual([]);
    const deletion = await page.request.delete(sessionPath, {
      headers: {
        Origin: 'http://localhost:8787',
        'X-CSRF-Token': original.me.csrfToken,
        'Idempotency-Key': crypto.randomUUID(),
        'If-Match': `"${stale.revision}"`,
      },
      data: {
        receiptId: crypto.randomUUID(),
        receiptToken: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
      },
    });
    expect(deletion.status()).toBe(202);
    deleted = true;
    await route.fulfill({ response });
  });
  const missing = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/readings/${original.reading.editionId}`) &&
      response.status() === 410,
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const response = await missing;
  expect(apiSchemas.ErrorEnvelope.parse(await response.json()).error.code).toBe(
    'CONTENT_UNAVAILABLE',
  );
  await expect(page).toHaveURL('http://localhost:8787/');
  await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeVisible();
  await expect(page.getByTestId('accepted-reading')).toHaveCount(0);
  await expect(editor).toHaveCount(0);
  expect((await page.request.get(sessionPath)).status()).toBe(410);
  expect(deleted).toBe(true);
});

for (const outcome of [
  'remaining reflection',
  'no remaining reflection',
  'deleted parent',
] as const) {
  test(`reflection deletion race: ${outcome}`, async ({ page }) => {
    const { original } = await savedReading(
      page,
      outcome === 'remaining reflection'
        ? '192.0.2.181'
        : outcome === 'no remaining reflection'
          ? '192.0.2.182'
          : '192.0.2.183',
    );
    const sessionPath = `/api/v1/sessions/${original.session.id}`;
    const headers = {
      Origin: 'http://localhost:8787',
      'X-CSRF-Token': original.me.csrfToken,
      'Idempotency-Key': crypto.randomUUID(),
    };
    if (outcome === 'remaining reflection') {
      const response = await page.request.post(`${sessionPath}/reflections`, {
        headers,
        data: {
          editionId: original.reading.editionId,
          text: 'Synthetic remaining reflection.',
          stance: 'disagree',
        },
      });
      expect(response.status()).toBe(201);
    }
    // Use the service's actual ordering, since reflection IDs are random.
    await page.reload();
    const before = apiSchemas.SessionRecord.parse(
      await page.request.get(sessionPath).then((response) => response.json()),
    );
    const erased = apiSchemas.Reflection.parse(
      await page.request
        .get(`/api/v1/reflections/${before.reflectionIds[0]}`)
        .then((response) => response.json()),
    );
    const reflectionEditor = page.getByLabel('Your reflection', { exact: true });
    await expect(reflectionEditor).toHaveValue(erased.text);
    const requestUrl = page.url();
    const readingText = await page.getByTestId('accepted-reading').textContent();
    await add(page, 'Synthetic saved note retained across reflection deletion.');
    await page.getByRole('button', { name: 'Edit note', exact: true }).click();
    const noteEditor = page.getByLabel('Your revisit note', { exact: true });
    const noteDraft = 'Synthetic unsaved revisit draft must survive reflection deletion.';
    await noteEditor.fill(noteDraft);
    const reflectionDraft = 'Synthetic unsaved reflection to reconcile after deletion.';
    if (outcome === 'remaining reflection') await reflectionEditor.fill(reflectionDraft);
    let deleted = false;
    const fetched: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET') fetched.push(new URL(request.url()).pathname);
    });
    await page.route(`**${sessionPath}`, async (route) => {
      if (deleted || route.request().method() !== 'GET') return route.continue();
      // Another tab deletes after this genuine snapshot, before the client reads its IDs.
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const stale = apiSchemas.SessionRecord.parse(await response.json());
      expect(stale.reflectionIds).toContain(erased.id);
      const deletionPath =
        outcome === 'deleted parent'
          ? sessionPath
          : `/api/v1/reflections/${erased.id}/revisions/${erased.revision}`;
      const deletion = await page.request.delete(deletionPath, {
        headers: {
          ...headers,
          'Idempotency-Key': crypto.randomUUID(),
          'If-Match': `"${outcome === 'deleted parent' ? stale.revision : erased.revision}"`,
        },
        data: {
          receiptId: crypto.randomUUID(),
          receiptToken: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
            'base64url',
          ),
        },
      });
      expect(deletion.status()).toBe(202);
      const unavailable = await page.request.get(`/api/v1/reflections/${erased.id}`);
      expect(unavailable.status()).toBe(410);
      expect(apiSchemas.ErrorEnvelope.parse(await unavailable.json()).error.code).toBe(
        'CONTENT_UNAVAILABLE',
      );
      deleted = true;
      await route.fulfill({ response });
    });
    const missing = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/reflections/${erased.id}`) && response.status() === 410,
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await missing;
    if (outcome === 'deleted parent') {
      await expect(page).toHaveURL('http://localhost:8787/');
      await expect(
        page.getByRole('heading', { name: 'Saved readings', exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId('accepted-reading')).toHaveCount(0);
      await expect(noteEditor).toHaveCount(0);
      expect((await page.request.get(sessionPath)).status()).toBe(410);
    } else {
      if (outcome === 'remaining reflection') {
        await expect(
          page.getByRole('button', { name: 'Keep my draft for the next save', exact: true }),
        ).toBeEnabled();
        await expect(reflectionEditor).toHaveValue(reflectionDraft);
        expect(fetched).toContain(`/api/v1/reflections/${before.reflectionIds[1]}`);
        await page
          .getByRole('button', { name: 'Keep my draft for the next save', exact: true })
          .click();
      } else {
        await expect(reflectionEditor).toHaveValue('');
        await reflectionEditor.fill(reflectionDraft);
      }
      await expect(page).toHaveURL(requestUrl);
      await expect(page.getByTestId('accepted-reading')).toHaveText(readingText!);
      await expect(noteEditor).toHaveValue(noteDraft);
      const persisted = page.waitForResponse(
        (response) =>
          response.request().method() === (outcome === 'remaining reflection' ? 'PUT' : 'POST') &&
          new URL(response.url()).pathname ===
            (outcome === 'remaining reflection'
              ? `/api/v1/reflections/${before.reflectionIds[1]}`
              : `${sessionPath}/reflections`),
      );
      await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
      const savedResponse = await persisted;
      expect(savedResponse.ok()).toBe(true);
      const saved = apiSchemas.Reflection.parse(await savedResponse.json());
      expect(saved).toMatchObject({
        sessionId: original.session.id,
        editionId: original.reading.editionId,
        text: reflectionDraft,
      });
      expect(saved.id).not.toBe(erased.id);
      if (outcome === 'remaining reflection') expect(saved.id).toBe(before.reflectionIds[1]);
      const after = apiSchemas.SessionRecord.parse(
        await page.request.get(sessionPath).then((response) => response.json()),
      );
      expect(after.reflectionIds).toEqual([saved.id]);
      const readback = apiSchemas.Reflection.parse(
        await page.request
          .get(`/api/v1/reflections/${saved.id}`)
          .then((response) => response.json()),
      );
      expect(readback).toEqual(saved);
      await expect(noteEditor).toHaveValue(noteDraft);
      expect((await page.request.get(`/api/v1/reflections/${erased.id}`)).status()).toBe(410);
    }
    expect(deleted).toBe(true);
  });
}

// These fixtures supply multiple editions at the HTTP boundary; selected-edition
// reflection writes and readback still use the real synthetic local service.
test('older request and latest history keep owned edition reflections across matching and new saves', async ({
  page,
}) => {
  const { original } = await savedReading(page, '192.0.2.180');
  const originalUrl = page.url();
  const originalId = original.session.reflectionIds[0]!;
  const readReflection = async (id: string) =>
    apiSchemas.Reflection.parse(
      await page.request.get(`/api/v1/reflections/${id}`).then((response) => response.json()),
    );
  const secondResponse = await page.request.post(
    `/api/v1/sessions/${original.session.id}/reflections`,
    {
      headers: {
        Origin: 'http://localhost:8787',
        'X-CSRF-Token': original.me.csrfToken,
        'Idempotency-Key': crypto.randomUUID(),
      },
      data: {
        editionId: original.reading.editionId,
        text: 'Synthetic second reflection stays unchanged.',
        stance: 'disagree',
      },
    },
  );
  expect(secondResponse.ok()).toBe(true);
  const second = apiSchemas.Reflection.parse(await secondResponse.json());
  const sessionRoute = `**/api/v1/sessions/${original.session.id}`;
  for (const destination of ['older request', 'latest history'] as const) {
    for (const matching of [true, false]) {
      await test.step(`${destination}: ${matching ? 'edit the first exact match' : 'create without an exact match'}`, async () => {
        // Fresh persisted snapshots prevent a prior scenario's writes from supplying expectations.
        const before = apiSchemas.SessionRecord.parse(
          await page.request
            .get(`/api/v1/sessions/${original.session.id}`)
            .then((response) => response.json()),
        );
        const beforeRecords = await Promise.all(before.reflectionIds.map(readReflection));
        const originalReflection = beforeRecords.find((value) => value.id === originalId)!;
        const secondBefore = beforeRecords.find((value) => value.id === second.id)!;
        expect(originalReflection).toBeDefined();
        expect(secondBefore).toBeDefined();
        const otherEdition = '00000000-0000-4000-8000-000000000181';
        const other = apiSchemas.Reflection.parse({
          ...originalReflection,
          id: '00000000-0000-4000-8000-000000000182',
          editionId: otherEdition,
          text: 'Synthetic other edition reflection must not appear.',
        });
        // Defensive boundary: matching edition identity alone cannot select another session.
        const foreign = apiSchemas.Reflection.parse({
          ...originalReflection,
          id: '00000000-0000-4000-8000-000000000183',
          sessionId: '00000000-0000-4000-8000-000000000184',
          text: 'Synthetic other session reflection must not appear.',
        });
        // The complete candidate list is explicit; persisted writes cannot add a later match.
        const reflectionIds = matching
          ? [other.id, foreign.id, originalId, second.id]
          : [other.id, foreign.id];
        const fixture = apiSchemas.SessionRecord.parse({
          ...before,
          editionIds:
            destination === 'older request'
              ? [original.reading.editionId, otherEdition]
              : [otherEdition, original.reading.editionId],
          reflectionIds,
        });
        const reflectionReads: string[] = [];
        const collectReads = (request: Request) => {
          if (request.method() === 'GET') reflectionReads.push(new URL(request.url()).pathname);
        };
        const reflectionRoutes = [foreign, other].map(
          (value) => `**/api/v1/reflections/${value.id}`,
        );
        try {
          for (const value of [foreign, other]) {
            await page.route(`**/api/v1/reflections/${value.id}`, (route) =>
              route.fulfill({ json: value }),
            );
          }
          await page.route(sessionRoute, (route) => route.fulfill({ json: fixture }));
          page.on('request', collectReads);
          const openedSession = page.waitForResponse((response) =>
            response.url().endsWith(`/api/v1/sessions/${original.session.id}`),
          );
          if (destination === 'older request') await page.goto(originalUrl);
          else {
            await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
            await page
              .getByRole('region', { name: 'Saved reading history', exact: true })
              .getByRole('button', { name: 'Synthetic dated return', exact: true })
              .click();
          }
          expect(
            apiSchemas.SessionRecord.parse(await (await openedSession).json()).reflectionIds,
          ).toEqual(
            matching ? [other.id, foreign.id, originalId, second.id] : [other.id, foreign.id],
          );
          const editor = page.getByLabel('Your reflection', { exact: true });
          await expect(editor).toHaveValue(matching ? originalReflection.text : '');
          await expect(page).toHaveURL(originalUrl);
          const draft = `Synthetic ${destination} ${matching ? 'matching' : 'new'} edition-specific draft.`;
          await editor.fill(draft);
          const refreshed = page.waitForResponse((response) =>
            response.url().endsWith(`/api/v1/reflections/${other.id}`),
          );
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await refreshed;
          await expect(
            page.getByRole('button', { name: 'Save reflection', exact: true }),
          ).toBeEnabled();
          await expect(editor).toHaveValue(draft);
          await expect(page).toHaveURL(originalUrl);
          const saved = page.waitForResponse((response) =>
            ['POST', 'PUT'].includes(response.request().method()),
          );
          await page.getByRole('button', { name: 'Save reflection', exact: true }).click();
          const response = await saved;
          expect(response.request().method()).toBe(matching ? 'PUT' : 'POST');
          expect(new URL(response.url()).pathname).toBe(
            matching
              ? `/api/v1/reflections/${originalId}`
              : `/api/v1/sessions/${original.session.id}/reflections`,
          );
          expect(response.request().postDataJSON()).toEqual({
            editionId: original.reading.editionId,
            text: draft,
            stance: matching ? originalReflection.stance : 'unspecified',
          });
          expect(response.ok()).toBe(true);
          const result = apiSchemas.Reflection.parse(await response.json());
          await expect(page.getByText('Reflection saved.', { exact: true })).toBeVisible();
          expect(await readReflection(result.id)).toMatchObject({
            sessionId: original.session.id,
            editionId: original.reading.editionId,
            text: draft,
          });
          expect(await readReflection(second.id)).toEqual(secondBefore);
          if (matching) expect(reflectionReads).not.toContain(`/api/v1/reflections/${second.id}`);
          if (!matching) {
            expect(result.id).not.toBe(originalId);
            expect(await readReflection(originalId)).toEqual(originalReflection);
          }
          for (const value of beforeRecords) {
            if (value.id !== result.id) expect(await readReflection(value.id)).toEqual(value);
          }
        } finally {
          page.off('request', collectReads);
          for (const route of [sessionRoute, ...reflectionRoutes]) await page.unroute(route);
        }
      });
    }
  }
});

test('an older unavailable request keeps its exact edition, notes and URL through focus refresh and note edits', async ({
  page,
}) => {
  const { original } = await savedReading(page, '192.0.2.150');
  await add(page, 'Synthetic older-edition note');
  const requestId = new URL(page.url()).pathname.split('/').at(-1)!;
  const newerEdition = '00000000-0000-4000-8000-000000000099';
  const newerRequest = '00000000-0000-4000-8000-000000000098';
  await page.route(`**/api/v1/sessions/${original.session.id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), editionIds: [original.reading.editionId, newerEdition] },
    });
  });
  await page.route(`**/api/v1/readings/${original.reading.editionId}`, (route) =>
    route.fulfill({
      status: 410,
      json: readingError('CONTENT_UNAVAILABLE', 'Reading content is unavailable.'),
    }),
  );
  const accepted = original.reading;
  if (accepted.kind !== 'tarot.accepted.v2') throw new Error('Expected synthetic v2');
  await page.route(`**/api/v1/readings/${newerEdition}`, (route) =>
    route.fulfill({
      json: {
        ...accepted,
        editionId: newerEdition,
        editionNumber: 2,
        provenance: { ...accepted.provenance, requestId: newerRequest },
      },
    }),
  );
  await page.route(`**/api/v1/revisits?editionId=${newerEdition}`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.reload();
  await expect(
    page.getByText('This reading is unavailable. Your saved notes remain available.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('Synthetic older-edition note', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/requests/${requestId}$`));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Synthetic older-edition note', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await page
    .getByLabel('Your revisit note', { exact: true })
    .fill('Synthetic older-edition note edited');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
  await expect(
    page.getByText('This reading is unavailable. Your saved notes remain available.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/requests/${requestId}$`));
  // Successful unavailable representations remain compatible too. These fixtures
  // qualify client boundary handling; D1 tests establish actual withdrawal behavior.
  await page.unroute(`**/api/v1/readings/${original.reading.editionId}`);
  await page.route(`**/api/v1/readings/${original.reading.editionId}`, (route) =>
    route.fulfill({
      json: {
        kind: 'reading.unavailable.v1',
        sessionId: original.session.id,
        editionId: original.reading.editionId,
        editionNumber: 1,
        parentEditionId: null,
        reason: 'content_withdrawn',
        unavailableAt: '2026-10-01T00:00:00.000Z',
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByText('Synthetic older-edition note edited', { exact: true }),
  ).toBeVisible();
  const savedUrl = page.url();
  await page.unroute(`**/api/v1/readings/${original.reading.editionId}`);
  await page.route(`**/api/v1/readings/${original.reading.editionId}`, (route) =>
    route.abort('internetdisconnected'),
  );
  await page.goto(savedUrl);
  await expect(page.getByRole('alert')).toContainText('Failed to fetch');
  await expect(page.getByRole('region', { name: 'Revisit notes', exact: true })).toHaveCount(0);
  for (const [status, code] of [
    [404, 'NOT_FOUND'],
    [503, 'DEPENDENCY_UNAVAILABLE'],
    [410, 'EXPIRED'],
    [401, 'UNAUTHENTICATED'],
  ] as const) {
    await page.unroute(`**/api/v1/readings/${original.reading.editionId}`);
    await page.route(`**/api/v1/readings/${original.reading.editionId}`, (route) =>
      route.fulfill({
        status,
        json: readingError(code, `Synthetic reading error ${status}`),
      }),
    );
    await page.goto(savedUrl);
    await expect(
      page.getByText(
        status === 401
          ? 'Your session ended. Please sign in again.'
          : `Synthetic reading error ${status}`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Revisit notes', exact: true })).toHaveCount(0);
  }
  await page.unrouteAll({ behavior: 'wait' });
});

test('an expired offline deletion reconciles notes and requires a fresh dated confirmation', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.151');
  await add(page, 'Synthetic note for bounded deletion');
  await page.route('**/api/v1/revisits/*', (route) =>
    route.request().method() === 'DELETE' ? route.abort('internetdisconnected') : route.continue(),
  );
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByLabel('Delete this note and all saved versions permanently').check();
  await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('draft');
  await page.clock.setFixedTime(new Date(Date.now() + 604800001));
  let deletes = 0;
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && request.url().includes('/revisits/')) deletes++;
  });
  await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Seven days have passed' }),
  ).toBeVisible();
  expect(deletes).toBe(0);
  await page.getByRole('button', { name: 'Reconcile saved notes', exact: true }).click();
  await expect(page.getByLabel('Delete this note and all saved versions permanently')).toHaveCount(
    0,
  );
  await expect(page.getByText(/confirm deletion again/)).toBeVisible();
  expect(deletes).toBe(0);
  await page.unroute('**/api/v1/revisits/*');
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByLabel('Delete this note and all saved versions permanently').check();
  await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(page.getByText('Synthetic note for bounded deletion', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Add revisit note', exact: true })).toBeFocused();
});

test('cancelling a deletion while editing does not replace the editor Cancel focus target', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.152');
  await add(page, 'Synthetic separate cancel origins');
  const edit = page.getByRole('button', { name: 'Edit note', exact: true });
  const remove = page.getByRole('button', { name: 'Delete note', exact: true });
  await edit.click();
  await page.getByLabel('Your revisit note', { exact: true }).fill('Synthetic retained draft');
  await remove.click();
  await page.getByRole('button', { name: 'Cancel note deletion', exact: true }).click();
  await expect(remove).toBeFocused();
  await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
    'Synthetic retained draft',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(edit).toBeFocused();
});

test('review: acknowledged create retains its identity when a newer draft survives a failed list refresh', async ({
  page,
}) => {
  const { original } = await savedReading(page, '192.0.2.153');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acknowledged!: () => void;
  const accepted = new Promise<void>((resolve) => {
    acknowledged = resolve;
  });
  const writes: Array<{ method: string; path: string; revision: string | undefined }> = [];
  let savedId = '',
    failList = false;
  await page.route('**/api/v1/revisits**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET' && failList) {
      failList = false;
      return route.abort('internetdisconnected');
    }
    if (request.method() === 'POST' || request.method() === 'PUT') {
      writes.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        revision: request.headers()['if-match'],
      });
      const response = await route.fetch();
      if (request.method() === 'POST') {
        savedId = (await response.json()).id;
        acknowledged();
        await gate;
        failList = true;
      }
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Add revisit note', exact: true }).click();
  await page
    .getByLabel('Your revisit note', { exact: true })
    .fill('Synthetic acknowledged first draft');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await accepted;
  await page
    .getByLabel('Your revisit note', { exact: true })
    .fill('Synthetic newer draft after acknowledgement');
  release();
  await expect(page.getByRole('alert')).toContainText(
    'Note saved, but the note list could not be refreshed.',
  );
  await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
    'Synthetic newer draft after acknowledgement',
  );
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
  expect(writes).toEqual([
    { method: 'POST', path: '/api/v1/revisits', revision: undefined },
    { method: 'PUT', path: `/api/v1/revisits/${savedId}`, revision: '"1"' },
  ]);
  const list = apiSchemas.RevisitPage.parse(
    await page.request
      .get(`/api/v1/revisits?editionId=${original.reading.editionId}`)
      .then((response) => response.json()),
  );
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({
    id: savedId,
    revision: 2,
    note: 'Synthetic newer draft after acknowledgement',
  });
});

for (const action of ['begin', 'cancel'] as const) {
  test(`review: delayed accepted deletion keeps its full receipt through editor ${action}`, async ({
    page,
  }) => {
    await savedReading(page, action === 'begin' ? '192.0.2.154' : '192.0.2.155');
    await add(page, 'Synthetic note A retained during delayed deletion');
    await add(page, 'Synthetic note B for delayed deletion');
    const articles = page
      .getByRole('region', { name: 'Revisit notes', exact: true })
      .getByRole('article');
    const first = articles.filter({ hasText: 'Synthetic note A retained during delayed deletion' });
    const second = articles.filter({ hasText: 'Synthetic note B for delayed deletion' });
    if (action === 'cancel') {
      await first.getByRole('button', { name: 'Edit note', exact: true }).click();
      await page
        .getByLabel('Your revisit note', { exact: true })
        .fill('Synthetic editable draft before delete');
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accepted!: () => void;
    const pending = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    let proof: { receiptId: string; receiptToken: string };
    await page.route('**/api/v1/revisits/*', async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      proof = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      accepted();
      await gate;
      await route.fulfill({ response });
    });
    await second.getByRole('button', { name: 'Delete note', exact: true }).click();
    await page.getByLabel('Delete this note and all saved versions permanently').check();
    await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
    await pending;
    if (action === 'begin') {
      await first.getByRole('button', { name: 'Edit note', exact: true }).click();
      await page
        .getByLabel('Your revisit note', { exact: true })
        .fill('Synthetic new draft while delete finishes');
    } else await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    release();
    await expect(
      page.getByRole('heading', { name: 'Deletion receipt', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Backups are kept until/)).toBeVisible();
    await expect(
      page.getByText('Synthetic note B for delayed deletion', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: 'Note deletion accepted.' }),
    ).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download deletion receipt', exact: true }).click();
    const receipt = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
    expect(receipt).toMatchObject(proof!);
    if (action === 'begin')
      await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
        'Synthetic new draft while delete finishes',
      );
    else await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveCount(0);
  });
}

for (const destination of ['adjacent', 'add'] as const) {
  test(`review: deletion restores ${destination} focus independently of the active editor draft`, async ({
    page,
  }) => {
    await savedReading(page, destination === 'adjacent' ? '192.0.2.156' : '192.0.2.157');
    if (destination === 'adjacent') await add(page, 'Synthetic adjacent note A');
    await add(page, 'Synthetic deleted note B');
    const region = page.getByRole('region', { name: 'Revisit notes', exact: true });
    const first = region.getByRole('article').filter({ hasText: 'Synthetic adjacent note A' });
    const second = region.getByRole('article').filter({ hasText: 'Synthetic deleted note B' });
    if (destination === 'adjacent')
      await first.getByRole('button', { name: 'Edit note', exact: true }).click();
    else await region.getByRole('button', { name: 'Add revisit note', exact: true }).click();
    await page
      .getByLabel('Your revisit note', { exact: true })
      .fill('Synthetic editor draft kept through deletion focus');
    await second.getByRole('button', { name: 'Delete note', exact: true }).click();
    await page.getByLabel('Delete this note and all saved versions permanently').check();
    await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Deletion receipt', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
      'Synthetic editor draft kept through deletion focus',
    );
    await expect(
      destination === 'adjacent'
        ? first.getByRole('heading', { level: 3 })
        : region.getByRole('button', { name: 'Add revisit note', exact: true }),
    ).toBeFocused();
  });
}

test('review: an older list response cannot revive a note deleted by an independent action', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.158');
  await add(page, 'Synthetic retained note before held list');
  await add(page, 'Synthetic deleted note from older list');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/revisits?*', async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  const refresh = page.getByRole('button', { name: 'Refresh notes', exact: true });
  await refresh.click();
  await pending;
  const deleted = page
    .getByRole('article')
    .filter({ hasText: 'Synthetic deleted note from older list' });
  await deleted.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByLabel('Delete this note and all saved versions permanently').check();
  await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Deletion receipt', exact: true })).toBeVisible();
  release();
  // Enabled means the held list response has been processed and its operation finished.
  await expect(refresh).toBeEnabled();
  await expect(deleted).toHaveCount(0);
  await expect(
    page.getByText('Synthetic retained note before held list', { exact: true }),
  ).toBeVisible();
});

for (const mutation of ['create', 'update'] as const) {
  test(`review: acknowledged ${mutation} survives an older independent conflict refresh`, async ({
    page,
  }) => {
    const { original } = await savedReading(
      page,
      mutation === 'create' ? '192.0.2.159' : '192.0.2.160',
    );
    await add(page, 'Synthetic earlier note to retain');
    await add(page, 'Synthetic stale deletion target');
    const notes = apiSchemas.RevisitPage.parse(
      await page.request
        .get(`/api/v1/revisits?editionId=${original.reading.editionId}`)
        .then((response) => response.json()),
    );
    const stale = notes.items.find((note) => note.note === 'Synthetic stale deletion target')!;
    expect(
      (
        await page.request.put(`/api/v1/revisits/${stale.id}`, {
          headers: {
            Origin: 'http://localhost:8787',
            'X-CSRF-Token': original.me.csrfToken,
            'If-Match': '"1"',
            'Idempotency-Key': crypto.randomUUID(),
          },
          data: { note: 'Synthetic newer deletion target' },
        })
      ).status(),
    ).toBe(200);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    await page.route('**/api/v1/revisits?*', async (route) => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    });
    const region = page.getByRole('region', { name: 'Revisit notes', exact: true });
    await region
      .getByRole('article')
      .filter({ hasText: 'Synthetic stale deletion target' })
      .getByRole('button', { name: 'Delete note', exact: true })
      .click();
    await page.getByLabel('Delete this note and all saved versions permanently').check();
    await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
    await pending;
    if (mutation === 'update')
      await region
        .getByRole('article')
        .filter({ hasText: 'Synthetic earlier note to retain' })
        .getByRole('button', { name: 'Edit note', exact: true })
        .click();
    else await region.getByRole('button', { name: 'Add revisit note', exact: true }).click();
    const authored = `Synthetic acknowledged ${mutation} after the old list`;
    await page.getByLabel('Your revisit note', { exact: true }).fill(authored);
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
    // This marker was absent locally: seeing it proves the newer list has committed.
    await expect(
      region.getByRole('article').filter({ hasText: 'Synthetic newer deletion target' }),
    ).toBeVisible();
    release();
    await expect(page.getByText(/confirm deletion again/)).toBeVisible();
    await expect(region.getByRole('article').filter({ hasText: authored })).toBeVisible();
    const current = apiSchemas.RevisitPage.parse(
      await page.request
        .get(`/api/v1/revisits?editionId=${original.reading.editionId}`)
        .then((response) => response.json()),
    );
    expect(current.items).toHaveLength(mutation === 'create' ? 3 : 2);
    expect(current.items.find((note) => note.note === authored)?.revision).toBe(
      mutation === 'create' ? 1 : 2,
    );
  });
}

for (const draft of ['same-note', 'unrelated'] as const) {
  test(`review round2: accepted deletion dominates a delayed PUT while preserving ${draft} editor ownership`, async ({
    page,
  }) => {
    await savedReading(page, draft === 'same-note' ? '192.0.2.161' : '192.0.2.162');
    await add(page, 'Synthetic race note A');
    if (draft === 'unrelated') await add(page, 'Synthetic unrelated note B');
    const region = page.getByRole('region', { name: 'Revisit notes', exact: true });
    const first = region.getByRole('article').filter({ hasText: 'Synthetic race note A' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let committed!: () => void;
    const accepted = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let deletedId = '',
      proof: { receiptId: string; receiptToken: string } | null = null;
    let failRefresh = false;
    await page.route('**/api/v1/revisits**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET' && failRefresh) return route.abort('internetdisconnected');
      if (request.method() === 'PUT') {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        deletedId = (await response.json()).id;
        committed();
        await gate;
        return route.fulfill({ response });
      }
      if (request.method() === 'DELETE') proof = request.postDataJSON();
      return route.continue();
    });
    await first.getByRole('button', { name: 'Edit note', exact: true }).click();
    await page
      .getByLabel('Your revisit note', { exact: true })
      .fill('Synthetic committed revision two');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await accepted;
    await page
      .getByLabel('Your revisit note', { exact: true })
      .fill('Synthetic newer draft for deleted note');
    await first.getByRole('button', { name: 'Delete note', exact: true }).click();
    await page.getByLabel('Delete this note and all saved versions permanently').check();
    const rejected = page.waitForResponse((response) => response.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(page.getByText(/confirm deletion again/)).toBeVisible();
    const refreshed = region
      .getByRole('article')
      .filter({ hasText: 'Synthetic committed revision two' });
    await refreshed.getByRole('button', { name: 'Delete note', exact: true }).click();
    await page.getByLabel('Delete this note and all saved versions permanently').check();
    const removed = page.waitForResponse((response) => response.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
    expect((await removed).status()).toBe(202);
    await expect(
      page.getByRole('heading', { name: 'Deletion receipt', exact: true }),
    ).toBeVisible();
    if (draft === 'unrelated') {
      // Accepted deletion ends this editor's save ownership before the held PUT returns.
      await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveCount(0);
      await region
        .getByRole('article')
        .filter({ hasText: 'Synthetic unrelated note B' })
        .getByRole('button', { name: 'Edit note', exact: true })
        .click();
      await page
        .getByLabel('Your revisit note', { exact: true })
        .fill('Synthetic unrelated draft must remain');
    }
    failRefresh = true;
    const finished = page.waitForEvent('requestfinished', {
      predicate: (request) => request.method() === 'PUT',
    });
    release();
    await finished;
    // Check the rendered outcome after the held acknowledgement's body and render turns.
    for (let frame = 0; frame < 3; frame++) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      await expect(region.locator(`#note-${deletedId}`)).toHaveCount(0);
      await expect(region.getByText(/^Note saved/)).toHaveCount(0);
    }
    if (draft === 'same-note')
      await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveCount(0);
    else
      await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(
        'Synthetic unrelated draft must remain',
      );
    await expect(page.getByText(/Backups are kept until/)).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download deletion receipt', exact: true }).click();
    expect(JSON.parse(await readFile((await (await download).path())!, 'utf8'))).toMatchObject(
      proof!,
    );
    expect((await page.request.get(`/api/v1/revisits/${deletedId}`)).status()).toBe(410);
    await page.unrouteAll({ behavior: 'wait' });
  });
}

test('review round2: accepted deletion suppresses a delayed saved-note refresh failure announcement', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.163');
  await add(page, 'Synthetic note for post-acknowledgement read');
  const region = page.getByRole('region', { name: 'Revisit notes', exact: true });
  await region.getByRole('button', { name: 'Edit note', exact: true }).click();
  await page
    .getByLabel('Your revisit note', { exact: true })
    .fill('Synthetic acknowledged edit awaiting refresh');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/revisits?*', async (route) => {
    const response = await route.fetch();
    expect((await response.json()).items[0].note).toBe(
      'Synthetic acknowledged edit awaiting refresh',
    );
    started();
    await gate;
    await route.abort('internetdisconnected');
  });
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await pending;
  const article = region
    .getByRole('article')
    .filter({ hasText: 'Synthetic acknowledged edit awaiting refresh' });
  await article.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByLabel('Delete this note and all saved versions permanently').check();
  await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Deletion receipt', exact: true })).toBeVisible();
  const failed = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url().includes('/revisits?'),
  });
  release();
  await failed;
  for (let frame = 0; frame < 3; frame++) {
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(region.getByText(/^Note saved/)).toHaveCount(0);
  }
  await expect(article).toHaveCount(0);
  await expect(
    region.getByRole('status').filter({ hasText: 'Note deletion accepted.' }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
});

// Valid HTTP error/page fixtures qualify client classification only. Real D1 limit
// admission/rollback is covered separately by revisit-records.test.ts.
const admissionMessages = {
  STORAGE_LIMIT_EXCEEDED:
    'Your account storage is full. Export your records or delete notes or readings to free space. Reading and deletion remain available.',
  NOTE_LIMIT_EXCEEDED:
    'This reading has 100 active notes. Delete a note and all its saved versions before adding another.',
  REVISION_LIMIT_EXCEEDED:
    'This note has 100 saved versions. Keep it and add a new note, or delete the whole note and its saved versions.',
  IDEMPOTENCY_MISMATCH: 'This action identifier was already used for different content.',
};
function admissionError(code: keyof typeof admissionMessages) {
  return apiSchemas.ErrorEnvelope.parse({
    error: {
      code,
      message: admissionMessages[code],
      correlationId: crypto.randomUUID(),
      retry: code === 'IDEMPOTENCY_MISMATCH' ? 'refresh_then_retry' : 'never',
      retryAfterSeconds: null,
      currentRevision: null,
    },
  });
}
for (const [index, [mode, code, retryAfterRemediation]] of (
  [
    ['new', 'STORAGE_LIMIT_EXCEEDED', true],
    ['initial-page', 'NOTE_LIMIT_EXCEEDED', true],
    ['edit', 'STORAGE_LIMIT_EXCEEDED', true],
    ['edit', 'REVISION_LIMIT_EXCEEDED', false],
    ['new', 'IDEMPOTENCY_MISMATCH', false],
  ] as const
).entries()) {
  test(`FR-1: ${mode} ${code} keeps actionable guidance and the unchanged draft intent`, async ({
    page,
  }) => {
    const { original } = await savedReading(page, `192.0.2.${211 + index}`);
    if (mode === 'edit') await add(page, 'Synthetic saved note before admission rejection');
    let blocked = true;
    const writes: Array<{ key: string; body: string; revision: string | undefined }> = [];
    const method = mode === 'edit' ? 'PUT' : 'POST';
    const at = new Date().toISOString();
    const initialPage = apiSchemas.RevisitPage.parse({
      items: Array.from({ length: 20 }, (_, i) => ({
        kind: 'revisit.v2',
        id: crypto.randomUUID(),
        sessionId: original.reading.sessionId,
        editionId: original.reading.editionId,
        revision: 1,
        note: `Synthetic first-page note ${i}`,
        stance: 'unspecified',
        createdAt: at,
        updatedAt: at,
      })),
      nextCursor: 'synthetic-next-page',
    });
    await page.route('**/api/v1/revisits**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET' && mode === 'initial-page' && blocked)
        return route.fulfill({ json: initialPage });
      if (request.method() !== method) return route.continue();
      writes.push({
        key: request.headers()['idempotency-key']!,
        body: request.postData()!,
        revision: request.headers()['if-match'],
      });
      if (blocked) return route.fulfill({ status: 409, json: admissionError(code) });
      return route.continue();
    });
    const notes = page.getByRole('region', { name: 'Revisit notes', exact: true });
    if (mode === 'initial-page') {
      await page.reload();
      await expect(notes.getByRole('article')).toHaveCount(20);
      await expect(
        notes.getByRole('button', { name: 'Load more notes', exact: true }),
      ).toBeVisible();
    }
    await notes
      .getByRole('button', {
        name: mode === 'edit' ? 'Edit note' : 'Add revisit note',
        exact: true,
      })
      .click();
    const draft = ` Synthetic retained ${mode} ${code} draft 😀\n`;
    await page.getByLabel('Your revisit note', { exact: true }).fill(draft);
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await expect(notes.getByRole('alert')).toHaveText(
      `${admissionMessages[code]} Your draft is still here.`,
    );
    await expect(page.getByLabel('Your revisit note', { exact: true })).toHaveValue(draft);
    await expect(
      notes.getByRole('button', { name: 'Refresh saved note', exact: true }),
    ).toHaveCount(0);
    await expect(notes.getByText(/The saved note changed/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save note', exact: true })).toBeEnabled();
    expect(writes).toHaveLength(1);
    if (retryAfterRemediation) {
      // Simulate capacity/slot remediation at the HTTP boundary, then allow the
      // deliberate same-intent retry through to the real synthetic service.
      blocked = false;
      await page.getByRole('button', { name: 'Save note', exact: true }).click();
      await expect(notes.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      const result = apiSchemas.RevisitPage.parse(
        await page.request
          .get(`/api/v1/revisits?editionId=${original.reading.editionId}`)
          .then((r) => r.json()),
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ note: draft, revision: mode === 'edit' ? 2 : 1 });
    } else {
      await expect(notes.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
      await expect(
        notes.getByRole('button', { name: 'Add revisit note', exact: true }),
      ).toBeEnabled();
    }
  });
}

test('FR-1: a typed deletion idempotency rejection does not invent a changed note or discard confirmation', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.216');
  await add(page, 'Synthetic retained note for typed deletion rejection');
  const keys: string[] = [];
  let listReads = 0;
  await page.route('**/api/v1/revisits**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') listReads++;
    if (request.method() !== 'DELETE') return route.continue();
    keys.push(request.headers()['idempotency-key']!);
    return route.fulfill({ status: 409, json: admissionError('IDEMPOTENCY_MISMATCH') });
  });
  const notes = page.getByRole('region', { name: 'Revisit notes', exact: true });
  await notes.getByRole('button', { name: 'Delete note', exact: true }).click();
  const confirmation = page.getByLabel('Delete this note and all saved versions permanently');
  await confirmation.check();
  const before = listReads;
  await notes.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(
    notes.getByRole('alert').filter({ hasText: admissionMessages.IDEMPOTENCY_MISMATCH }),
  ).toBeVisible();
  await expect(confirmation).toBeChecked();
  await expect(notes.getByText(/The note changed/)).toHaveCount(0);
  expect(listReads).toBe(before);
  expect(keys).toHaveLength(1);
  await notes.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect(notes.getByRole('article')).toContainText(
    'Synthetic retained note for typed deletion rejection',
  );
});

// Reading HTTP-boundary fixtures above use the service's typed withdrawal response;
// deletion requests here reach the real synthetic local service unless explicitly aborted.
test('undismissed deletion receipts survive later success, failure and same-proof retries', async ({
  page,
}) => {
  await savedReading(page, '192.0.2.183');
  for (const label of ['first', 'second', 'third'])
    await add(page, `Synthetic ${label} receipt note`);
  const proofs: { receiptId: string; receiptToken: string }[] = [];
  let attempt = 0;
  await page.route('**/api/v1/revisits/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    proofs.push(route.request().postDataJSON());
    attempt++;
    if (attempt === 2) {
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      return route.abort('internetdisconnected');
    }
    if (attempt === 4) return route.abort('internetdisconnected');
    return route.continue();
  });
  const panels = page.getByRole('region', { name: 'Deletion receipt', exact: true });
  for (const [index, label] of ['first', 'second', 'third'].entries()) {
    const article = page
      .getByRole('article')
      .filter({ hasText: `Synthetic ${label} receipt note` });
    await article.getByRole('button', { name: 'Delete note', exact: true }).click();
    await page.getByLabel('Delete this note and all saved versions permanently').check();
    await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
    await expect(panels).toHaveCount(index + 1);
    if (index > 0) {
      await expect(page.getByRole('alert')).toContainText('draft');
      await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
    }
    await expect(
      page.getByRole('status').filter({ hasText: 'Note deletion accepted.' }),
    ).toBeVisible();
    await expect(panels).toHaveCount(index + 1);
    await expect(panels.nth(index)).toContainText('Deletion is complete for active storage.');
  }
  expect(proofs[1]).toEqual(proofs[2]);
  expect(proofs[3]).toEqual(proofs[4]);
  const downloaded: { receiptId: string; receiptToken: string }[] = [];
  for (let index = 0; index < 3; index++) {
    const download = page.waitForEvent('download');
    await panels
      .nth(index)
      .getByRole('button', { name: 'Download deletion receipt', exact: true })
      .click();
    const receipt = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
    expect(receipt).toMatchObject({
      format: 'reflection-deletion-receipt.v1',
      ...proofs[[0, 1, 3][index]!],
    });
    downloaded.push(receipt);
  }
  expect(new Set(downloaded.map((proof) => proof.receiptId)).size).toBe(3);
  expect(new Set(downloaded.map((proof) => proof.receiptToken)).size).toBe(3);
  await panels.nth(1).getByRole('button', { name: 'Dismiss receipt', exact: true }).click();
  await expect(panels).toHaveCount(2);
  for (const [index, originalIndex] of [0, 2].entries()) {
    const download = page.waitForEvent('download');
    await panels
      .nth(index)
      .getByRole('button', { name: 'Download deletion receipt', exact: true })
      .click();
    expect(JSON.parse(await readFile((await (await download).path())!, 'utf8'))).toEqual(
      downloaded[originalIndex],
    );
  }
  await page.context().clearCookies();
  await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect(
    page.getByText('Your session ended. Please sign in again.', { exact: true }),
  ).toBeVisible();
  await expect(panels).toHaveCount(0);
  for (const proof of downloaded) {
    const response = await page.request.get(`/api/v1/deletions/${proof.receiptId}`, {
      headers: { 'X-Deletion-Token': proof.receiptToken },
    });
    expect(response.ok()).toBe(true);
    expect((await response.json()).state).toBe('complete');
  }
});

function readingError(code: string, message: string) {
  return apiSchemas.ErrorEnvelope.parse({
    error: {
      code,
      message,
      correlationId: '00000000-0000-4000-8000-000000000183',
      retry: 'never',
      retryAfterSeconds: null,
      currentRevision: null,
    },
  });
}
