import { expect, test } from '@playwright/test';
import { authenticator, keepKit } from '../fixtures/browser-reading.ts';

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
  await expect(
    page.getByRole('button', { name: 'Enable AI readings', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Saved readings', exact: true })).toBeEnabled();
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
    await expect(
      page.getByText('Live AI readings are enabled for this development app.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
    await keepKit(page);
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
    await page.getByRole('button', { name: 'New reading', exact: true }).click();
    await expect(page.getByText(/Starting a reading sends this question to OpenAI/)).toBeVisible();
    await expect(page.locator('#reading-spread-photo-help')).toContainText(
      'sends your attached photo to Meta',
    );
    await expect(page.locator('#reading-spread-photo-help')).toContainText(
      'zero retention is not guaranteed',
    );
    await page.getByLabel('Offline spread photo (optional)').setInputFiles({
      name: 'spread.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(
      page.getByText(/Your attached photo is sent to Meta to recognize the cards/),
    ).toBeVisible();
  });
}

test('explicit hosted synthetic readiness retains simulation disclosure', async ({ page }) => {
  await page.route('**/health', (route) =>
    route.fulfill({ json: { mode: 'hosted-synthetic', generationReady: true } }),
  );
  await page.goto('/');
  await expect(
    page.getByText(/This local build simulates readings and never contacts an AI provider/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create a test account', exact: true }),
  ).toBeVisible();
});
