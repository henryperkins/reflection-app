import { afterEach, vi } from 'vitest';

// Installed before test modules import application code. D1 bindings do not use global fetch.
const unexpected: string[] = [];
vi.stubGlobal('fetch', async () => {
  unexpected.push('Unexpected outbound request');
  throw new Error('Unexpected outbound request: tests allow no external network');
});
afterEach(() => {
  if (unexpected.length !== 0) {
    unexpected.length = 0;
    throw new Error('Unexpected outbound request attempted, even if application code caught it');
  }
});
