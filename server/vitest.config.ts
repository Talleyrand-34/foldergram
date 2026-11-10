import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the Foldergram server package.
 *
 * The server suite is filesystem- and database-heavy: most files create a
 * throw-away data root, run dbmate migrations against it and then tear it
 * down again. The defaults (5s test timeout, 10s hook timeout) are too tight
 * for that on a cold cache, so the timeouts below are deliberately generous.
 */

/**
 * The PostgreSQL path is disk bound: every commit writes WAL, and the tests
 * run against a live database. One worker per core turns the run into a
 * throughput test of the disk and makes single tests time out, so the
 * PostgreSQL run gets fewer workers.
 */
const runsAgainstPostgres =
  (process.env.DB_DRIVER ?? '').trim().toLowerCase() === 'postgres' ||
  (process.env.DATABASE_URL ?? '').trim().length > 0;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    setupFiles: ['./test/setup.ts'],

    // Every test file gets its own module registry and its own temp data root,
    // so DB-backed files can never share state.
    isolate: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        // One fork per test file keeps the `vi.resetModules()` + dynamic
        // import pattern used across the suite free of cross-file leakage.
        singleFork: false,
        isolate: true,
        // The PostgreSQL path runs one fork at a time.
        //
        // The files of a worker share one schema, and the rows are deleted
        // before every test. Two files running at the same time would delete
        // each other's rows in the middle of a test, so they have to be
        // serialized.
        maxForks: runsAgainstPostgres ? 1 : undefined,
        minForks: runsAgainstPostgres ? 1 : undefined
      }
    },

    // Every test file applies the full migration set to its own scratch
    // schema. That is a couple of dozen commits, and on a loaded host with a
    // slow WAL that alone can take longer than the default timeout. The
    // limits below are generous on purpose: a test that times out on a busy
    // machine is a false alarm, and a flaky suite is worse than a slow one.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,

    reporters: ['default'],
    clearMocks: true,
    restoreMocks: false
  }
});
