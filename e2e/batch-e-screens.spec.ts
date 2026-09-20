// e2e/batch-e-screens.spec.ts
//
// Screenshot evidence for Batch E (#1314, #1054) at the two widths CLAUDE.md
// requires. Not a behaviour suite — the behaviour is pinned by 63 component
// assertions in AutoApprovalClient.test.tsx and BillingPanel.test.tsx. This
// exists so the diff can be judged by eye, which is the acceptance bar for a
// UI change ("visibly different at a glance").
//
// Gated on `isAuthHarnessConfigured` like every other signed-in lane here, so
// it self-skips in CI where the staging Supabase secrets never land — and on
// any machine whose `TEST_DATABASE_POOL_URL` is the LOCAL docker Postgres.
// The harness needs that URL and `E2E_SUPABASE_URL` to name the SAME database
// (its own note says why: the app reads `users` through both Postgres.js and
// PostgREST), so a local test DB plus remote Supabase Auth cannot resolve a
// seeded owner. Run it with the staging pair set, which is also the only
// configuration where these screenshots mean anything.
//
// STATE NOTE. The Posting block reasons come from process env, which a test
// cannot vary per-case. Locally `OPENAI_MODERATION_ENABLED=false` and the
// autonomy flags are unset, so the page renders BLOCKED — the #1314 fix —
// with several reasons at once. That is the state worth photographing, and it
// is also production's posture today. The unblocked headline needs a server
// started with those flags on; captured separately when it is.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  createOwnerUser,
  deleteOwnerUser,
  isAuthHarnessConfigured,
  signInViaMagicLink,
  type OwnerHandle,
} from './harness';
import { getE2eSql } from './seed';

const EVIDENCE = 'docs/reviews/fix-batch-e-screens-vs-runtime/evidence';
const WIDTHS = [
  { label: '390', width: 390, height: 844 },
  { label: '1440', width: 1440, height: 900 },
] as const;

/** Arms the account default at 4–5★ so the headline has a policy to describe. */
async function armAccountPolicy(accountId: string): Promise<void> {
  const sql = getE2eSql();
  await sql`
    INSERT INTO auto_approval_policies (
      id, account_id, location_id, persona, action_class,
      auto_approve_min_star, veto_window_minutes, daily_auto_post_cap, updated_at
    ) VALUES (
      ${randomUUID()}::uuid, ${accountId}::uuid, NULL,
      'reply', 'posting', 4, 15, 10, NOW()
    )
  `;
}

async function setTier(accountId: string, tier: 'copilot' | 'autopilot'): Promise<void> {
  const sql = getE2eSql();
  await sql`UPDATE accounts SET subscription_tier = ${tier} WHERE id = ${accountId}::uuid`;
}

test.describe('Batch E — screenshot evidence', () => {
  // Environment gate, not a disabled test: without E2E_SUPABASE_URL /
  // E2E_SUPABASE_SERVICE_KEY there is no owner to sign in as. Four existing
  // specs gate the same way (forgot-password, reset-password, operator,
  // zernio-connect). Marked explicitly rather than written multi-line, which
  // the audit's single-line matcher would simply miss — the point is to be
  // reported, not to slip past.
  test.skip(!isAuthHarnessConfigured, 'E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_KEY not set — auth-harness specs run against staging (e2e/README.md)'); // weakened-check-ok: environment precondition; the spec cannot seed an owner without the auth harness, and it is the screenshot mechanism for #1314/#1054 (deviation D16)

  let owner: OwnerHandle;

  test.beforeAll(() => {
    mkdirSync(EVIDENCE, { recursive: true });
  });

  test.afterEach(async () => {
    if (owner) await deleteOwnerUser(owner);
  });

  test('#1314: the auto-approval headline on a Copilot account with an armed policy', async ({ page }) => {
    owner = await createOwnerUser();
    await setTier(owner.seed.accountId, 'copilot');
    await armAccountPolicy(owner.seed.accountId);
    await signInViaMagicLink(page, owner.email, '/settings/auto-approval');
    const banner = page.getByTestId('auto-approval-status');
    await expect(banner).toBeVisible();

    // The point of the shot: the headline must NOT claim replies post.
    await expect(banner).not.toContainText('post a reply automatically');
    await expect(banner).toContainText('not set up to post automatically right now');

    for (const { label, width, height } of WIDTHS) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: `${EVIDENCE}/1314-blocked-${label}.png`, fullPage: true });
    }
  });

  test('#1054: the Copilot card reads Downgrade for an Autopilot account', async ({ page }) => {
    owner = await createOwnerUser();
    await setTier(owner.seed.accountId, 'autopilot');
    await signInViaMagicLink(page, owner.email, '/settings/billing');
    const grid = page.locator('.billing-plan-grid');
    await expect(grid).toBeVisible();

    // The bug this replaces read "Upgrade to Copilot" for an Autopilot account.
    await expect(grid).toContainText('Downgrade to Copilot');

    for (const { label, width, height } of WIDTHS) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: `${EVIDENCE}/1054-tier-direction-${label}.png`, fullPage: true });
    }
  });
});
