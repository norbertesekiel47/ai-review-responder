// e2e/operator.spec.ts
//
// The Operator screen end to end. Three lanes, on purpose:
//
//  1. The unauthenticated redirect runs EVERYWHERE, CI included — it needs no
//     database and no Supabase Auth.
//  2. The signed-in flows are gated on `isAuthHarnessConfigured` (e2e/harness.ts),
//     which is false in CI because the staging Supabase secrets never reach a
//     CI runner. They self-skip there and run locally.
//  3. The worker is STOOD IN FOR by SQL: e2e/helpers/operator-seed.ts completes
//     a seeded turn with a `proposal` segment and a pending set_tone Proposal,
//     so the browser flow does not depend on a running Railway worker or on a
//     provider key.
//
// T7 converts the two fixmes below. They are `test.fixme`, not `it.todo`:
// Playwright has no todo, and this file is not matched by vitest's include glob.
import { test } from '@playwright/test';

test.describe('Operator screen — unauthenticated', () => {
  test('unauthenticated /dashboard/operator redirects to the owner login', async ({ page }) => {
    await page.goto('/dashboard/operator');
    await page.waitForURL(/\/login\?from=/, { timeout: 10_000 });
  });
});

test.describe('Operator screen — authenticated', () => {
  test.fixme('e2e: owner sends a turn, applies the tone proposal and sees the receipt at 390 and 1440', async () => {
    // T7 writes this body.
  });

  test.fixme('e2e: a settings write between proposal and Apply produces a stale card with Refresh plan', async () => {
    // T7 writes this body.
  });
});
