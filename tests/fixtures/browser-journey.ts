import { chromium, expect, type Page } from '@playwright/test';
import { account } from './browser-reading.ts';

export const spreadPhotoPath = new URL('./spread-photo.jpg', import.meta.url).pathname;
export const longQuestion = (
  'What should I consider as I make room for a different direction, while keeping the commitments that already matter to me? '.repeat(
    4,
  ) + 'A'.repeat(28)
).slice(0, 500);
export const longFilename = `synthetic-spread-${'long-unbroken-filename'.repeat(8)}.jpg`;

/** Firefox/WebKit exercise signed-in UI with a real synthetic session, not mocked APIs.
 * Only Chromium/CDP can provision the virtual passkey; this is not cross-engine WebAuthn proof. */
export async function journeyAccount(
  page: Page,
  browserName: string,
  baseURL: string | undefined,
  ip: string,
) {
  if (browserName === 'chromium' && !baseURL?.startsWith('https:')) return account(page, ip);
  const seed = await chromium.launch();
  try {
    const context = await seed.newContext({
      baseURL: baseURL?.startsWith('https:') ? 'http://localhost:8787' : baseURL!,
    });
    await account(await context.newPage(), ip);
    await page.context().addCookies((await context.storageState()).cookies);
    await page.context().setExtraHTTPHeaders({ 'CF-Connecting-IP': ip });
    await page.goto('/');
    await page.getByRole('link', { name: 'Account', exact: true }).waitFor();
  } finally {
    await seed.close();
  }
}

export async function themeContrast(page: Page, selector?: string) {
  return page.evaluate((selector): Record<string, number> => {
    const style = getComputedStyle(document.documentElement);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const color = (name: string) => rgba(style.getPropertyValue(name));
    const luminance = (rgba: number[]) => {
      const values = rgba.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
    };
    const ratio = (foreground: number[], background: number[]) => {
      const alpha = foreground[3]! / 255;
      const composed = foreground
        .slice(0, 3)
        .map((value, index) => value * alpha + background[index]! * (1 - alpha));
      const a = luminance(composed),
        b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    if (selector) {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Contrast target missing: ${selector}`);
      const rendered = getComputedStyle(element);
      return { selectedText: ratio(rgba(rendered.color), rgba(rendered.backgroundColor)) };
    }
    return {
      inputOnCard: ratio(color('--input'), color('--card')),
      inputOnBackground: ratio(color('--input'), color('--background')),
      mutedOnCard: ratio(color('--muted-foreground'), color('--card')),
      mutedOnBackground: ratio(color('--muted-foreground'), color('--background')),
      destructiveOnCard: ratio(color('--destructive-text'), color('--card')),
      destructiveOnBackground: ratio(color('--destructive-text'), color('--background')),
      primaryButton: ratio(color('--primary-foreground'), color('--primary')),
      destructiveButton: ratio(color('--destructive-foreground'), color('--destructive-button')),
    };
  }, selector);
}

/** Complete synthetic note responses with fixed server dates, only at the browser boundary. */
export async function datedNotesFixture(page: Page) {
  const session = await page.request.get('/api/v1/sessions?status=saved').then((r) => r.json());
  const parent = session.items[0];
  const notes = [
    {
      kind: 'revisit.v2',
      id: '00000000-0000-4000-8000-000000000001',
      sessionId: parent.id,
      editionId: parent.latestEditionId,
      revision: 1,
      note: 'Synthetic February thought.',
      stance: 'unspecified',
      createdAt: '2026-02-01T10:00:00.000Z',
      updatedAt: '2026-02-01T10:00:00.000Z',
    },
    {
      kind: 'revisit.v2',
      id: '00000000-0000-4000-8000-000000000002',
      sessionId: parent.id,
      editionId: parent.latestEditionId,
      revision: 1,
      note: 'Synthetic March thought.',
      stance: 'unsure',
      createdAt: '2026-03-02T11:30:00.000Z',
      updatedAt: '2026-03-02T11:30:00.000Z',
    },
  ];
  const generationRequests: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/requests')) generationRequests.push(r.url());
  });
  await page.route('**/api/v1/revisits**', async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split('/').at(-1);
    if (request.method() === 'GET')
      return route.fulfill({
        json:
          id === 'revisits' ? { items: notes, nextCursor: null } : notes.find((n) => n.id === id),
      });
    if (request.method() === 'PUT') {
      const note = notes.find((n) => n.id === id)!;
      Object.assign(note, request.postDataJSON(), {
        revision: note.revision + 1,
        updatedAt: '2026-04-03T12:45:00.000Z',
      });
      return route.fulfill({ json: note });
    }
    return route.continue();
  });
  return { notes, generationRequests };
}

/** Every note state uses the real local synthetic server, including a real stale revision. */
export async function noteJourneyStates(page: Page, capture: (state: string) => Promise<void>) {
  const notes = page.getByRole('region', { name: 'Revisit notes', exact: true });
  await expect(notes.getByText('No revisit notes yet.', { exact: true })).toBeVisible();
  await capture('notes-empty');
  await notes.getByRole('button', { name: 'Add revisit note', exact: true }).click();
  const text = page.getByLabel('Your revisit note', { exact: true });
  await expect(text).toBeFocused();
  await text.fill(`Synthetic dated thought.\n\n${'LongUnbrokenAuthoredText'.repeat(50)}`);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Your response (optional)', { exact: true })).toBeFocused();
  await page.getByLabel('Your response (optional)', { exact: true }).selectOption('unsure');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save note', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(notes.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
  await expect(notes.getByRole('heading', { level: 3 })).toBeFocused();
  await capture('notes-populated');
  await notes.getByRole('button', { name: 'Edit note', exact: true }).click();
  await text.fill(`Synthetic unsaved later thought. ${'Word'.repeat(200)}`);
  await capture('notes-edit');
  const me = await page.request.get('/api/v1/me').then((r) => r.json());
  const sessions = await page.request.get('/api/v1/sessions?status=saved').then((r) => r.json());
  const list = await page.request
    .get(`/api/v1/revisits?editionId=${sessions.items[0].latestEditionId}`)
    .then((r) => r.json());
  const note = list.items[0];
  const response = await page.request.put(`/api/v1/revisits/${note.id}`, {
    headers: {
      Origin: new URL(page.url()).origin,
      'X-CSRF-Token': me.csrfToken,
      'If-Match': '"1"',
      'Idempotency-Key': crypto.randomUUID(),
    },
    data: { note: 'Synthetic current saved version from another tab.', stance: 'disagree' },
  });
  expect(response.status()).toBe(200);
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(notes.getByText(/saved note changed/)).toBeVisible();
  await page.getByRole('button', { name: 'Refresh saved note', exact: true }).click();
  await expect(notes.getByRole('blockquote')).toContainText('Synthetic current saved version');
  await capture('notes-conflict');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(notes.getByRole('button', { name: 'Edit note', exact: true })).toBeFocused();
  await notes.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect(notes.getByRole('article')).toContainText('Synthetic current saved version');
  await notes.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(
    page.getByLabel('Delete this note and all saved versions permanently'),
  ).toBeFocused();
  await page.getByLabel('Delete this note and all saved versions permanently').check();
  await capture('notes-deletion');
  await page.getByRole('button', { name: 'Confirm note deletion', exact: true }).click();
  await expect(notes.getByRole('heading', { name: 'Deletion receipt', exact: true })).toBeVisible();
  await expect(notes.getByRole('button', { name: 'Add revisit note', exact: true })).toBeFocused();
  await capture('notes-receipt');
  await page.getByRole('button', { name: 'Dismiss receipt', exact: true }).click();
  await notes.getByRole('button', { name: 'Add revisit note', exact: true }).click();
  await text.fill('Synthetic dated thought kept for return.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(notes.getByRole('status').filter({ hasText: 'Note saved.' })).toBeVisible();
}
