import { defineConfig } from 'vitest/config';
import path from 'path';

// The 45 `*.integration.test.ts` suites all talk to ONE shared test database,
// and several re-apply migrations and DELETE from the same tables. Run in
// parallel they deadlock each other nondeterministically — a different set of
// files fails every run, always with `deadlock detected` or a `beforeAll`
// timeout, never a failed assertion. They are therefore split into their own
// project and serialized; the other ~738 files stay fully parallel.
//
// This costs CI nothing: the integration suites self-skip there because
// `TEST_DATABASE_POOL_URL` is unset, which is precisely why CI never surfaced
// the contention (the #520 blind spot). `groupOrder` keeps the two groups from
// overlapping, so a parallel-project file can never hold a lock an integration
// file is waiting on.
const INTEGRATION_GLOB = '**/__tests__/**/*.integration.test.ts';

const VITEST_DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**'];

// Project configs do not inherit the root `test` block, so the shared options
// are spread into both rather than declared once above them.
const sharedTestOptions = {
  globals: true,
  environment: 'node' as const,
  include: [
    'scripts/ci/**/__tests__/**/*.test.ts',
    'src/**/__tests__/**/*.test.{ts,tsx}',
    'worker/**/__tests__/**/*.test.{ts,tsx}',
    'tests/**/__tests__/**/*.test.ts',
    // E2E *fixtures* carry vitest unit tests under __tests__/ (e.g. the
    // Zernio fixture-server review-name contract). Playwright specs live at
    // e2e/*.spec.ts and are NOT matched by this __tests__/*.test.ts glob, so
    // they stay in the `pnpm test:e2e` lane.
    'e2e/**/__tests__/**/*.test.ts',
  ],
  setupFiles: ['./vitest.setup.ts'],
};

const sharedViteOptions = {
  oxc: {
    jsx: {
      // `as const` because hoisting this out of defineConfig() loses the
      // contextual typing that kept the literal from widening to `string`.
      runtime: 'automatic' as const,
      pragma: 'React.createElement',
      importSource: 'react',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
};

export default defineConfig({
  ...sharedViteOptions,
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'html'],
      // Write the report even when the run has failures. Vitest defaults this
      // to false, so one red test left `coverage/` absent entirely and every
      // downstream consumer died with "failed to read coverage file" — naming a
      // missing file instead of the test that actually broke (#581).
      reportOnFailure: true,
      // `include` makes the report cover every matching file (untested ones
      // show 0%), giving fallow a real repo-wide untested-risk signal.
      include: ['src/**/*.{ts,tsx}', 'worker/**/*.{ts,tsx}', 'scripts/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.d.ts'],
    },
    projects: [
      {
        ...sharedViteOptions,
        test: {
          ...sharedTestOptions,
          name: 'parallel',
          exclude: [...VITEST_DEFAULT_EXCLUDE, INTEGRATION_GLOB],
          sequence: { groupOrder: 0 },
        },
      },
      {
        ...sharedViteOptions,
        test: {
          ...sharedTestOptions,
          name: 'integration',
          include: [INTEGRATION_GLOB],
          exclude: VITEST_DEFAULT_EXCLUDE,
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
});
