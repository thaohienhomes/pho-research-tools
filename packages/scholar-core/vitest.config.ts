import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'test/**/*.test.ts'],
    // The quality suite replays ~60 references through the real pipeline;
    // in record/live mode it talks to Crossref one request at a time.
    testTimeout: 30 * 60 * 1000,
  },
});
