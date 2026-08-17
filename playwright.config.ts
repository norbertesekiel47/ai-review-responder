import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Playwright owns only *.spec.ts. Vitest unit tests colocated under
  // e2e/**/__tests__/ must NOT be collected — Playwright's default testMatch
  // also matches *.test.ts, and loading a vitest file aborts collection for
  // the entire run (0 tests in 0 files).
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 1,
  reporter: 'html',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
  // One owner for app boot, locally AND in CI (the CI `e2e` job relies on
  // this block — see .github/workflows/e2e.yml). Locally the dev server, so a
  // running `pnpm dev` is reused. In CI a production build: `next dev`
  // compiles each route on its first hit, and on a loaded runner that first
  // hit alone exceeded the 30s test timeout — every run showed 1–2 "flaky"
  // tests that were really compile stalls, each costing a 30s timeout plus a
  // retry. `next build` compiles everything once (~40s on 4 vCPU), then every
  // page is served prebuilt. The timeout covers the build.
  webServer: {
    command: process.env.CI ? 'pnpm build && pnpm start' : 'pnpm dev',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 300_000 : 180_000,
    // When E2E tests use a dedicated test DB, the app under test must
    // read from the same database so it can find seeded approval tokens.
    env: {
      ...(process.env.TEST_DATABASE_POOL_URL
        ? { DATABASE_POOL_URL: process.env.TEST_DATABASE_POOL_URL }
        : {}),
      ...(process.env.ACCOUNT_OFFBOARDING_ENABLED
        ? { ACCOUNT_OFFBOARDING_ENABLED: process.env.ACCOUNT_OFFBOARDING_ENABLED }
        : {}),
      ...(process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS
        ? { ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS: process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS }
        : {}),
    },
  },
});
