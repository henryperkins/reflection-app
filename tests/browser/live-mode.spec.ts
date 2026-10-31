import { expect, test } from '@playwright/test';
import {
  authenticator,
  backToReadings,
  keepKit,
  openAccount,
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
  await page.route('**/health', (route) =>
    route.fulfill({ json: { mode: 'hosted-synthetic', generationReady: true } }),
  );
  await page.goto('/');
  await expect(
    page.getByText(
      'This hosted preview simulates readings and does not contact an AI provider. Use test accounts only.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(/local build|local simulation/)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create a test account', exact: true }),
  ).toBeVisible();
});
