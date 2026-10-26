import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/domain/**/*.test.ts', 'tests/tooling/**/*.test.ts'],
    setupFiles: ['tests/deny-network.ts'],
    environment: 'node',
    testTimeout: 10000,
  },
});
