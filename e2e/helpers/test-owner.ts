// e2e/helpers/test-owner.ts
//
// Single source for owner-login E2E credentials + the test Postgres URL,
// sourced from the environment. NEVER hardcode credentials in spec files —
// they leak into git history. Provide these via .env.local (gitignored):
//   E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD          — a confirmed owner login on the test Supabase project
//   E2E_DATABASE_URL (or TEST_DATABASE_POOL_URL) — Postgres connection for the raw-psql fixtures
export const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? '';
export const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? '';
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_POOL_URL ?? '';

/** True when the owner-login E2E specs have everything they need to run. */
export const isOwnerE2eConfigured: boolean =
  Boolean(OWNER_EMAIL && OWNER_PASSWORD && E2E_DATABASE_URL);
