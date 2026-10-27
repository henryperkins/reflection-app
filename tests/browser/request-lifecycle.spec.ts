import { expect, test, type Page } from '@playwright/test';
import { apiSchemas, AcceptedReading } from '../../src/contracts/index.ts';
import { account, reading, savedSnapshot } from '../fixtures/browser-reading.ts';

async function form(page: Page, question = 'Synthetic request interruption') {
  await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  await page.getByLabel('Your question').fill(question);
  await page.getByLabel('Use English for this reading').check();
}
async function emptyStorage(page: Page) {
  expect(
    await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      databases: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
    })),
  ).toEqual({ local: 0, session: 0, databases: 0, caches: 0 });
}

test('lost Start acknowledgement then reload reopens the same request without another Start', async ({
  page,
}) => {
  await account(page, '198.51.100.81');
  await form(page);
  let posts = 0;
  await page.route('**/api/v1/requests', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    const response = await route.fetch();
    expect(apiSchemas.StartResponse.parse(await response.json()).status.state).toBe('prepared');
    await route.abort('connectionreset');
  });
  // Hold observation until reload; the genuine Worker request still completes.
  let reconnect = false;
  await page.route('**/api/v1/requests?*', (route) =>
    reconnect ? route.continue() : route.abort('internetdisconnected'),
  );
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reading progress' })).toBeVisible();
  await expect(page).toHaveURL(/\/request-intents\/[0-9a-f-]+$/);
  await expect(page.getByRole('status').filter({ hasText: /Connection lost/ })).toBeVisible();
  reconnect = true;
  await page.reload();
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]+$/);
  expect(posts).toBe(1);
  expect((await page.request.get('/api/v1/me').then((r) => r.json())).remainingDay).toBe(2);
  await emptyStorage(page);
});

test('an unreceived Start after reload explains the uncertainty and allows a deliberate new draft', async ({
  page,
}) => {
  await account(page, '198.51.100.99');
  await form(page);
  let posts = 0;
  await page.route('**/api/v1/requests', async (route) => {
    posts++;
    await route.abort('internetdisconnected');
  });
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /Connection lost/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: /not been found yet/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New reading', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  await expect(page.getByLabel('Your question')).toHaveValue('');
  expect(posts).toBe(1);
});

test('a lost Save response is reconciled by reloading the same accepted reading', async ({
  page,
}) => {
  await account(page, '198.51.100.82');
  await reading(page, 'Synthetic save interruption');
  // biome-ignore lint/performance/useDomNodeTextContent: compare visible text, excluding collapsed sources.
  const text = await page.getByTestId('accepted-reading').innerText();
  let saves = 0;
  await page.route('**/api/v1/sessions/*/save', async (route) => {
    saves++;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Save reading', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /fetch|connection|completed/i }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
  await expect(page.getByTestId('accepted-reading')).toHaveText(text, { useInnerText: true });
  await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
  const snapshot = await savedSnapshot(page);
  expect(snapshot.session.reflectionIds).toEqual([]);
  expect(snapshot.me.remainingDay).toBe(2);
  expect(saves).toBe(1);
});

test('accepted completion refreshes displayed allowance even when progress unmounts during refresh', async ({
  page,
}) => {
  await account(page, '198.51.100.98');
  await form(page);
  let first = true,
    release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/v1/me', async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.getByRole('button', { name: 'Start reading', exact: true }).click();
    await expect(page.getByTestId('accepted-reading')).toBeVisible();
    release();
    await page.getByRole('button', { name: 'New reading', exact: true }).click();
    await expect(page.getByText('Local allowance: 2 today · 29 this month.')).toBeVisible();
  } finally {
    release();
  }
});

test('explicit Start retry preserves its body and key and joins the original reading', async ({
  page,
}) => {
  await account(page, '198.51.100.97');
  await form(page);
  const attempts: Array<{ key: string | undefined; body: string | null }> = [];
  await page.route('**/api/v1/requests', async (route) => {
    attempts.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    const response = await route.fetch();
    if (attempts.length === 1) return route.abort('connectionreset');
    const started = apiSchemas.StartResponse.parse(await response.json());
    expect(started.joined).toBe(true);
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await page.getByRole('button', { name: 'Retry the same Start' }).click();
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect((await page.request.get('/api/v1/me').then((r) => r.json())).remainingDay).toBe(2);
  const open = await page.request.get('/api/v1/sessions?status=open').then((r) => r.json());
  expect(open.items).toHaveLength(1);
});

test('signing in to an owned request URL resumes the unsaved reading with no new Start', async ({
  page,
}) => {
  await account(page, '198.51.100.95');
  let starts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/requests') starts++;
  });
  await reading(page, 'Synthetic sign-in resume');
  const url = page.url();
  const original = await page.getByTestId('accepted-reading').textContent();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.goto(url);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByTestId('accepted-reading')).toHaveText(original!);
  expect(starts).toBe(1);
  await emptyStorage(page);
});

test('a delayed status cannot reopen a view after leaving progress; explicit resume can', async ({
  page,
}) => {
  await account(page, '198.51.100.96');
  await form(page);
  await pendingFixture(page);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    arrived = r;
  });
  await page.route(/\/api\/v1\/requests\/[0-9a-f-]+\?after=/, async (route) => {
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await ready;
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  release();
  await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeVisible();
  await expect(page.getByTestId('accepted-reading')).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume reading request' }).click();
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
});

test('reading inspection has semantic labels, keyboard source expansion and completion focus', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await account(page, '198.51.100.83');
  await form(page, 'Synthetic source inspection');
  await page.getByRole('button', { name: 'Start reading', exact: true }).focus();
  await page.keyboard.press('Enter');
  const accepted = page.getByTestId('accepted-reading');
  await expect(
    accepted.getByRole('heading', { name: 'Synthetic source inspection' }),
  ).toBeFocused();
  await expect(accepted.getByRole('heading', { name: 'Drawn card', exact: true })).toHaveCount(3);
  await expect(accepted.getByRole('heading', { name: 'Interpretation', exact: true })).toHaveCount(
    3,
  );
  const summary = accepted.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(
    accepted.getByRole('heading', { name: 'Traditional source material' }),
  ).toBeVisible();
  const id = page.url().split('/').at(-1)!;
  const status = apiSchemas.RequestStatus.parse(
    await (await page.request.get(`/api/v1/requests/${id}`)).json(),
  );
  const artifact = AcceptedReading.parse(
    await (await page.request.get(`/api/v1/readings/${status.editionId}`)).json(),
  );
  for (let i = 0; i < 3; i++) {
    const card = artifact.basis.cards[i]!,
      source = artifact.sources[i]!;
    await expect(
      accepted.getByRole('heading', {
        name: `${card.position}: ${card.cardId} · ${card.orientation}`,
      }),
    ).toBeVisible();
    await expect(
      accepted.locator('.source').nth(i).getByText(source.text, { exact: true }),
    ).toBeVisible();
    await expect(
      accepted.getByText(source.rights.attribution, { exact: true }).first(),
    ).toBeVisible();
  }
  await page.screenshot({ path: '/tmp/reflection-request-inspection-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/reflection-request-inspection-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

// Content-free protocol fixtures exercise UI outcome handling; real D1 barriers verify the
// corresponding cancellation/consent/provider transitions in request-lifecycle.test.ts.
async function pendingFixture(page: Page) {
  let snapshot: ReturnType<typeof apiSchemas.RequestStatus.parse> | undefined;
  await page.route('**/api/v1/requests', async (route) => {
    const response = await route.fetch();
    const started = apiSchemas.StartResponse.parse(await response.json());
    snapshot = {
      ...started.status,
      state: 'dispatching',
      revision: 2,
      editionId: null,
      events: [],
      nextSequence: 2,
    };
    await route.fulfill({ response, json: { ...started, status: snapshot } });
  });
  await page.route(/\/api\/v1\/requests\/[0-9a-f-]+\?after=/, async (route) => {
    await route.fulfill({ json: snapshot });
  });
  return {
    get: () => snapshot!,
    set: (value: Partial<NonNullable<typeof snapshot>>) => {
      snapshot = { ...snapshot!, ...value };
    },
  };
}

test('cancel uses the observed revision and lost cancellation responses reconnect safely', async ({
  page,
}) => {
  await account(page, '198.51.100.84');
  await form(page);
  const fixture = await pendingFixture(page);
  let key: string | undefined;
  await page.route('**/api/v1/requests/*/cancel', async (route) => {
    expect(route.request().headers()['if-match']).toBe('"2"');
    key = route.request().headers()['idempotency-key'];
    fixture.set({ state: 'cancelled', errorCode: 'CANCELLED', revision: 3, nextSequence: 3 });
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel reading', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel reading', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reading cancelled' })).toBeVisible();
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByTestId('accepted-reading')).toHaveCount(0);
});

test('revoking AI during progress keeps the stopped request and history available', async ({
  page,
}) => {
  await account(page, '198.51.100.85');
  await form(page);
  const fixture = await pendingFixture(page);
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reading progress' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel reading' })).toBeEnabled();
  await page.getByRole('button', { name: 'Turn off AI readings' }).click();
  fixture.set({ state: 'blocked', errorCode: 'CONSENT_REQUIRED', revision: 3, nextSequence: 3 });
  await expect(
    page.getByRole('status').filter({ hasText: /AI permission was turned off/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'New reading', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Saved readings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeVisible();
});

for (const [state, errorCode, copy] of [
  ['blocked', 'PROVIDER_REFUSAL', 'The AI provider declined this request'],
  ['expired', 'EXPIRED', 'This reading request expired'],
  ['failed', 'PROVIDER_UNCERTAIN', 'The writer did not confirm a result'],
  ['failed', 'PROVIDER_UNAVAILABLE', 'The writer is unavailable'],
] as const) {
  test(`progress explains ${errorCode} without another generation`, async ({ page }) => {
    await account(
      page,
      `198.51.100.${90 + ['PROVIDER_REFUSAL', 'EXPIRED', 'PROVIDER_UNCERTAIN', 'PROVIDER_UNAVAILABLE'].indexOf(errorCode)}`,
    );
    await form(page);
    const fixture = await pendingFixture(page);
    await page.getByRole('button', { name: 'Start reading', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reading progress' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel reading' })).toBeEnabled();
    fixture.set({ state, errorCode, revision: 3, nextSequence: 3 });
    await expect(page.getByRole('status').filter({ hasText: copy })).toBeVisible();
    await expect(page.getByTestId('accepted-reading')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel reading' })).toHaveCount(0);
  });
}

test('explicit New reading after a stopped request uses a fresh identity for the same question', async ({
  page,
}) => {
  await account(page, '198.51.100.201');
  await form(page);
  const submitted: Array<{ intent: string; key: string | undefined; id: string; joined: boolean }> =
    [];
  await page.route('**/api/v1/requests', async (route) => {
    const input = apiSchemas.StartRequest.parse(route.request().postDataJSON());
    const response = await route.fetch();
    const started = apiSchemas.StartResponse.parse(await response.json());
    submitted.push({
      intent: input.clientIntentId,
      key: route.request().headers()['idempotency-key'],
      id: started.requestId,
      joined: started.joined,
    });
    await route.fulfill({
      response,
      json: {
        ...started,
        status: {
          ...started.status,
          state: 'failed',
          errorCode: 'PROVIDER_UNAVAILABLE',
          revision: 3,
          events: [],
          nextSequence: 3,
        },
      },
    });
  });
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'The writer is unavailable' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1]!.intent).not.toBe(submitted[0]!.intent);
  expect(submitted[1]!.key).not.toBe(submitted[0]!.key);
  expect(submitted[1]!.id).not.toBe(submitted[0]!.id);
  expect(submitted[1]!.joined).toBe(false);
});

for (const boundary of ['status', 'reading'] as const) {
  test(`browser Back fences a late ${boundary} response and Forward can resume the request`, async ({
    page,
  }) => {
    await account(page, boundary === 'status' ? '198.51.100.202' : '198.51.100.203');
    await form(page);
    if (boundary === 'status') await pendingFixture(page);
    let release!: () => void, arrived!: () => void, delivered!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      arrived = r;
    });
    const finished = new Promise<void>((r) => {
      delivered = r;
    });
    let first = true;
    await page.route(
      boundary === 'status' ? /\/api\/v1\/requests\/[0-9a-f-]+\?after=/ : '**/api/v1/readings/*',
      async (route) => {
        if (!first) return route.continue();
        first = false;
        const response = await route.fetch();
        arrived();
        await held;
        await route.fulfill({ response }).catch(() => undefined);
        delivered();
      },
    );
    await page.getByRole('button', { name: 'Start reading', exact: true }).click();
    await ready;
    try {
      await page.goBack();
      await expect(page).toHaveURL('http://localhost:8787/');
      await expect(
        page.getByRole('heading', { name: 'Saved readings', exact: true }),
      ).toBeVisible();
      release();
      await finished;
      await expect(page).toHaveURL('http://localhost:8787/');
      await expect(page.getByTestId('accepted-reading')).toHaveCount(0);
      await page.goForward();
      await expect(page.getByTestId('accepted-reading')).toBeVisible();
    } finally {
      release();
    }
  });
}

test('browser Back keeps a dirty reflection until discard is explicitly confirmed', async ({
  page,
}) => {
  await account(page, '198.51.100.204');
  await reading(page, 'Synthetic native navigation draft');
  const url = page.url();
  await page.getByLabel('Your reflection', { exact: true }).fill('Synthetic unsaved reflection');
  let dialogs = 0;
  page.once('dialog', async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  });
  await page.goBack();
  await expect.poll(() => dialogs).toBe(1);
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel('Your reflection', { exact: true })).toHaveValue(
    'Synthetic unsaved reflection',
  );
  page.once('dialog', async (dialog) => {
    dialogs++;
    await dialog.accept();
  });
  await page.goBack();
  await expect.poll(() => dialogs).toBe(2);
  await expect(page.getByRole('heading', { name: 'Saved readings', exact: true })).toBeVisible();
  await expect(page.getByTestId('accepted-reading')).toHaveCount(0);
});
