import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    passWithNoTests: true,
    // All files share one CouchDB; the config-mutation suite must not race
    // replications and user tests in other files.
    fileParallelism: false,
    // CouchDB's replication scheduler can take several seconds to pick up
    // a one-shot _replicate; the default 5s timeout is flaky.
    testTimeout: 60_000,
  },
});
