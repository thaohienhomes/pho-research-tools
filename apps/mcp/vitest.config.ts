import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Every outbound call replays from a cassette, so nothing here waits on the
    // network. The first format_citations call still loads the CSL styles cold:
    // ~1s alone, 6s+ when turbo runs every package's suite at once in CI.
    testTimeout: 30_000,
  },
});
