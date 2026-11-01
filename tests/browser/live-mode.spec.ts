import { expect, test } from '@playwright/test';
import {
  account,
  authenticator,
  backToReadings,
  enableAi,
  keepKit,
  openAccount,
  reading,
} from '../fixtures/browser-reading.ts';

test('failed runtime discovery never describes a possible live call as simulation', async ({
  page,
}) => {
  await page.context().setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.201' });
  await page.route('**/health', (route) => route.abort());
  await authenticator(page);
  await page.goto('/');
  await expect(page.getByText(/never contacts an AI provider|local simulated writer/)).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await keepKit(page);
  await expect(page.getByRole('button', { name: 'Saved readings', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'New reading', exact: true })).toBeDisabled();
  await openAccount(page);
  await expect(
    page.getByRole('button', { name: 'Enable AI readings', exact: true }),
  ).toBeDisabled();
});

for (const mode of ['live-local', 'live-preview', 'production'] as const) {
  test(`${mode} makes provider disclosure clear before enabling AI or submitting a question`, async ({
    page,
  }) => {
    await page.context().setExtraHTTPHeaders({
      'CF-Connecting-IP': mode === 'live-local' ? '192.0.2.202' : '192.0.2.203',
    });
    await page.route('**/health', (route) =>
      route.fulfill({ json: { mode, provider: 'openai', generationReady: true } }),
    );
    await authenticator(page);
    await page.goto('/');
    const environment = {
      'live-local': 'This development app sends new readings to a live AI provider.',
      'live-preview': 'This hosted preview sends new readings to a live AI provider.',
      production: 'New readings can be sent to a live AI provider.',
    }[mode];
    await expect(page.getByText(environment, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
    await keepKit(page);
    await openAccount(page);
    await expect(
      page.getByText(/Your question, cards and selected source meanings are sent to OpenAI/),
    ).toBeVisible();
    await expect(
      page.getByText(/Any spread photo you attach is sent to Meta for recognition/),
    ).toBeVisible();
    await expect(page.getByText(/OpenAI and Meta may retain request data/)).toBeVisible();
    await expect(
      page.getByText(/never contacts an AI provider|local simulated writer/),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'AI readings are on', exact: true }),
    ).toBeVisible();
    await backToReadings(page);
    await page.getByRole('button', { name: 'New reading', exact: true }).click();
    await expect(page.getByText(/Starting a reading sends this question to OpenAI/)).toBeVisible();
    const preflight = page.getByRole('complementary', { name: 'Before you start' });
    await expect(preflight).toContainText('sends your attached photo to Meta');
    await expect(preflight).toContainText('zero retention is not guaranteed');
    await expect(
      page.getByRole('button', { name: 'Choose photo', exact: true }),
    ).toHaveAccessibleDescription(
      /sends your attached photo to Meta.*zero retention is not guaranteed/,
    );
    await page.getByLabel('Photo of your spread (optional)').setInputFiles({
      name: 'spread.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(
      page.getByText(/Your attached photo is sent to Meta to recognize the cards/),
    ).toHaveCount(0);
    await expect(preflight.getByText(/sends your attached photo to Meta/)).toHaveCount(1);
  });
}

test('explicit hosted synthetic readiness retains simulation disclosure', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.243' });
  await page.route('**/health', (route) =>
    route.fulfill({ json: { mode: 'hosted-synthetic', generationReady: true } }),
  );
  await authenticator(page);
  await page.goto('/');
  await expect(
    page.getByText(
      'This hosted preview simulates readings and does not contact an AI provider. Use test accounts and synthetic text only.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(/local build|local simulation/)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create a test account', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create a test account', exact: true }).click();
  await keepKit(page);
  await enableAi(page);
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  const preflight = page.getByRole('complementary', { name: 'Before you start' });
  await expect(preflight).toContainText('Use synthetic text only.');
  await expect(preflight).toContainText('does not contact an AI provider');
});

test('unavailable hosted synthetic generation retains its environment without enabling readings', async ({
  page,
}) => {
  await page.context().setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.244' });
  await page.route('**/health', (route) =>
    route.fulfill({ json: { mode: 'hosted-synthetic', generationReady: false } }),
  );
  await authenticator(page);
  await page.goto('/');
  const environment = page.getByText(/^This hosted preview/);
  await expect(environment).toContainText('Use test accounts and synthetic text only.');
  await expect(environment).toContainText('Saved readings remain available.');
  await page.getByRole('link', { name: 'Recover with your saved kit', exact: true }).click();
  await expect(environment).toBeVisible();
  await page.getByRole('link', { name: 'Back to sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await expect(environment).toBeVisible();
  await keepKit(page);
  await expect(page.getByRole('button', { name: 'Saved readings', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'New reading', exact: true })).toBeDisabled();
  await openAccount(page);
  await expect(
    page.getByRole('button', { name: 'Enable AI readings', exact: true }),
  ).toBeDisabled();
});

for (const discovery of ['pending', 'failed'] as const) {
  test(`saved simulation attribution stays neutral while runtime discovery is ${discovery}`, async ({
    page,
  }) => {
    await page.route('**/health', (route) =>
      route.fulfill({ json: { mode: 'hosted-synthetic', generationReady: true } }),
    );
    await account(page, discovery === 'pending' ? '192.0.2.245' : '192.0.2.246');
    const question = 'Synthetic saved reading attribution';
    await reading(page, question);
    await page.getByRole('button', { name: 'Save reading', exact: true }).click();
    await expect(page.getByText('Saved until you delete it.', { exact: true })).toBeVisible();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/health', async (route) => {
      if (discovery === 'failed') return route.abort();
      await pending;
      await route.fulfill({ json: { mode: 'hosted-synthetic', generationReady: true } });
    });
    try {
      await page.goto('/');
      await page.getByRole('button', { name: question, exact: true }).click();
      await expect(page.getByText('Simulated reading', { exact: true })).toBeVisible();
      await page.getByText('Cards and sources', { exact: true }).click();
      await expect(page.getByText(/Generated by a simulation\./)).toBeVisible();
      await expect(
        page.getByText(/Local simulated reading|Generated by the local simulation/),
      ).toHaveCount(0);
      if (discovery === 'pending') {
        release();
        await expect(page.getByText(/Generated by the hosted simulation\./)).toBeVisible();
      }
    } finally {
      release();
    }
  });
}
