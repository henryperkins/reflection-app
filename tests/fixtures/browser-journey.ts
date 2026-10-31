import { chromium, type Page } from '@playwright/test';
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

export async function themeContrast(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const color = (name: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = style.getPropertyValue(name);
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
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
  });
}
