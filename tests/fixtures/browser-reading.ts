import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { apiSchemas } from '../../src/contracts/index.ts';

export async function authenticator(page: Page) {
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
export async function keepKit(page: Page) {
  await expect(page.getByRole('heading', { name: 'Keep your recovery kit' })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery kit' }).click();
  const kit = JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
  await page.getByLabel('I have saved the complete kit with the handle and codes.').check();
  await page.getByRole('button', { name: 'Continue to account' }).click();
  await expect(page.getByRole('heading', { name: 'Your readings' })).toBeVisible();
  return kit;
}
export async function account(page: Page, ip: string) {
  await page.context().setExtraHTTPHeaders({ 'CF-Connecting-IP': ip });
  const auth = await authenticator(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a test account' }).click();
  return { auth, kit: await keepKit(page) };
}
export async function openAccount(page: Page) {
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
}
export async function backToReadings(page: Page) {
  await page.getByRole('link', { name: 'Back to readings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your readings' })).toBeVisible();
}
/** Returns with browser Back, so the readings keep their original history entry. */
export async function enableAi(page: Page) {
  await openAccount(page);
  await page.getByRole('button', { name: 'Enable AI readings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'AI readings are on', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your readings' })).toBeVisible();
}
export async function reading(page: Page, question: string) {
  await enableAi(page);
  await page.getByRole('button', { name: 'New reading', exact: true }).click();
  await page.getByLabel('Your question').fill(question);
  await page.getByLabel('Use English for this reading').check();
  await expect(page.getByText(/Start temporarily stores/)).toBeVisible();
  await page.getByRole('button', { name: 'Start reading', exact: true }).click();
  await expect(page.getByTestId('accepted-reading')).toBeVisible();
}
export async function savedSnapshot(page: Page) {
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
