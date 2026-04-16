import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
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
  webServer: process.env.CI
    ? undefined
    : {
        command: 'pnpm dev',
        port: 3000,
        reuseExistingServer: true,
        // When E2E tests use a dedicated test DB, the app under test must
        // read from the same database so it can find seeded approval tokens.
        ...(process.env.TEST_DATABASE_POOL_URL
          ? { env: { DATABASE_POOL_URL: process.env.TEST_DATABASE_POOL_URL } }
          : {}),
      },
});
