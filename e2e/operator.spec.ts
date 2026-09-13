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
//     a seeded turn with a `proposal` segment and a pending voice or policy Proposal,
//     so the browser flow does not depend on a running Railway worker or on a
//     provider key. It completes the turn THROUGH THE PRODUCTION BUILDERS
//     (`readVoiceConfig` / `readPolicySnapshot` → `buildProposalRows` → `insertProposals`), so the
//     stored preview carries the six-key shape a real run stores (RB-01).
import { test, expect } from '@playwright/test';
import { parseReceipt } from '@/lib/agents/operator/schema';
import {
  createOwnerUser,
  deleteOwnerUser,
  isAuthHarnessConfigured,
  signInViaMagicLink,
  type OwnerHandle,
} from './harness';
import {
  cleanupOperatorSeed,
  completeTurnWithProposal,
  completeTurnWithPolicyProposal,
  countTurns,
  findAcceptedTurn,
  moveVoiceRow,
  readProposalRow,
  readTone,
  readPolicyOutcomes,
  seedPolicyHistory,
} from './helpers/operator-seed';

const EVIDENCE = 'docs/reviews/codex-owner-operator-run-c/evidence';

test.describe('Operator screen — unauthenticated', () => {
  test('unauthenticated /dashboard/operator redirects to the owner login', async ({ page }) => {
    await page.goto('/dashboard/operator');
    await page.waitForURL(/\/login\?from=/, { timeout: 10_000 });
  });
});

test.describe('Operator screen — authenticated', () => {
  // The Supabase secrets never reach a CI runner, so these self-skip there and
  // run locally against the harness (e2e/harness.ts:31-32). The unauthenticated
  // redirect above runs everywhere.
  //
  // ONE DATABASE, both halves. `src/proxy.ts` readSelf() resolves the owner's
  // role through supabase-js/PostgREST while the harness seeds the row through
  // Postgres.js, so `TEST_DATABASE_POOL_URL` must be the SAME Postgres as
  // `E2E_SUPABASE_URL` — the deep tier's rule
  // (docs/runbooks/e2e-local-setup.md §auth-harness), and it binds every owner
  // PAGE, not only the four specs listed there. With the two split, the callback
  // logs PGRST116 and every /dashboard path bounces to /login.
  test.skip(!isAuthHarnessConfigured, 'auth harness env not set (local only)');

  let owner: OwnerHandle;

  test.beforeEach(async () => { owner = await createOwnerUser(); });

  test.afterEach(async () => {
    if (owner) {
      // Operator rows FIRST: `deleteOwnerUser` deletes the businesses and the
      // account they reference by foreign key (e2e/harness.ts:214-217).
      await cleanupOperatorSeed(owner.seed.accountId);
      await deleteOwnerUser(owner);
    }
  });

  test('e2e: owner sends a turn, applies the tone proposal and sees the receipt at 390 and 1440', async ({ page }) => {
    await signInViaMagicLink(page, owner.email, '/dashboard/operator');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard/operator');
    await expect(page.getByRole('heading', { name: 'Operator' })).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/empty-screen-1440.png`, fullPage: true });

    // THE OWNER SENDS. This is the POST route, the transaction and the outbox
    // row — not a hand-written conversation.
    await page.getByRole('textbox', { name: /message/i }).fill('Make my replies warmer.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Preparing your plan')).toBeVisible();
    expect(await countTurns(owner.seed.accountId)).toBe(1);

    // THE WORKER'S HALF, through the production builders — `readVoiceConfig`,
    // `buildProposalRows`, `insertProposals`. The stored preview therefore has
    // the real six-key shape, which is the shape the card has to render.
    const completed = await completeTurnWithProposal({
      accountId: owner.seed.accountId,
      userId: owner.seed.userId,
    });

    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await expect(page.getByText('Set the reply tone to "warm and brief"')).toBeVisible({ timeout: 15_000 });
      await page.screenshot({
        path: `${EVIDENCE}/proposal-card-${viewport.width}.png`,
        fullPage: true,
      });
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('Remembered fact', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Make my replies warmer.').first()).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/receipt-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${EVIDENCE}/receipt-390.png`, fullPage: true });

    // THE ROW BEHIND THE SCREEN. A green browser assertion over a Receipt that
    // did not commit is the failure this asserts away.
    const row = await readProposalRow(completed.proposalId);
    expect(row.status).toBe('applied');
    expect(row.failure_reason).toBeNull();
    expect(row.receipt).not.toBeNull();
    expect(row.decided_by_user_id).toBe(owner.seed.userId);
    expect(await readTone(owner.seed.businessId)).toBe('warm and brief');
    // ONE turn: the send was not duplicated by a retry or a re-render.
    expect(await countTurns(owner.seed.accountId)).toBe(1);
  });

  test('e2e: policy expansion requires the exact scope, saves consequence counts and replays one receipt', async ({ page }) => {
    test.setTimeout(60_000);
    await seedPolicyHistory({ accountId: owner.seed.accountId, businessId: owner.seed.businessId });
    await signInViaMagicLink(page, owner.email, '/dashboard/operator');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard/operator');
    const instruction = 'Auto-reply to 4 and 5 star reviews at all locations.';
    await page.getByRole('textbox', { name: /message/i }).fill(instruction);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Preparing your plan')).toBeVisible();
    const completed = await completeTurnWithPolicyProposal({
      accountId: owner.seed.accountId, userId: owner.seed.userId,
    });
    const confirmation = page.getByRole('textbox', { name: 'Type “all locations” to confirm this scope' });
    const apply = page.getByRole('button', { name: 'Confirm and apply', exact: true });
    await expect(confirmation).toBeVisible({ timeout: 15_000 });
    await expect(apply).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
    await expect(page.getByText(/Under this rule, 2 of your 3 reviews/)).toBeVisible();
    // Only the three initial live markers enter the five-review fixture's consequence.
    await expect(page.getByText('Excluded 1 imported reviews and 1 reviews whose origin is unknown.')).toBeVisible();
    await expect(page.getByText(/Affects 1 locations that inherit the account default/)).toBeVisible();
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await expect(confirmation).toBeVisible();
      await page.screenshot({ path: `${EVIDENCE}/policy-proposal-${viewport.width}.png`, fullPage: true });
    }

    // Client friction rejects a near match. The same-origin route assertion
    // also proves a caller cannot bypass that friction by submitting directly.
    await confirmation.fill('all locations ');
    await expect(apply).toBeDisabled();
    const applyUrl = `/api/operator/proposals/${completed.proposalId}/apply`;
    const headers = { origin: new URL(page.url()).origin };
    const mismatch = await page.request.post(applyUrl, {
      headers,
      data: { expectedVersionToken: completed.versionToken, confirmationLevel: 'all locations ' },
    });
    expect(mismatch.status()).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: 'confirmation_mismatch' });
    expect(await readProposalRow(completed.proposalId)).toMatchObject({ status: 'pending', receipt: null });
    expect(await readPolicyOutcomes(owner.seed.accountId)).toEqual({
      policy_rows: 0, threshold: null, policy_audits: 0, reviews: 5,
    });

    await confirmation.fill('all locations');
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.getByText('Active rule', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Old rule: 0 of 3 eligible; new rule: 2 of 3 eligible.')).toBeVisible();
    await expect(page.getByText('0 drafts keep their granted veto window.')).toBeVisible();
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: `${EVIDENCE}/policy-receipt-${viewport.width}.png`, fullPage: true });
    }

    const stored = await readProposalRow(completed.proposalId);
    expect(stored).toMatchObject({ status: 'applied', failure_reason: null, decided_by_user_id: owner.seed.userId });
    const receipt = parseReceipt(stored.receipt);
    expect(receipt).toMatchObject({
      affects: 'future_eligible_reviews',
      scope: { accountId: owner.seed.accountId, locationId: null },
      actorUserId: owner.seed.userId, ownerText: instruction, turnId: completed.turnId,
      before: { threshold: null, rowExists: false, consequence: {
        total: 3, eligible: 0, held: { manual: 3, below_threshold: 0, cap_reached: 0 },
        excludedImported: 1, excludedUnknown: 1,
      } },
      after: { threshold: 4, rowExists: true, affectedLocationCount: 1, consequence: {
        total: 3, eligible: 2, held: { manual: 0, below_threshold: 1, cap_reached: 0 },
        excludedImported: 1, excludedUnknown: 1,
      } },
      retainedVeto: { count: 0 },
    });
    expect(await readPolicyOutcomes(owner.seed.accountId)).toEqual({
      policy_rows: 1, threshold: 4, policy_audits: 1, reviews: 5,
    });
    const repeated = await page.request.post(applyUrl, {
      headers,
      data: { expectedVersionToken: completed.versionToken, confirmationLevel: 'all locations' },
    });
    expect(repeated.status()).toBe(200);
    expect((await readProposalRow(completed.proposalId)).receipt).toEqual(stored.receipt);
    expect(await readPolicyOutcomes(owner.seed.accountId)).toEqual({
      policy_rows: 1, threshold: 4, policy_audits: 1, reviews: 5,
    });
    expect(await countTurns(owner.seed.accountId)).toBe(1);
  });

  test('e2e: a settings write between proposal and Apply produces a stale card with Refresh plan', async ({ page }) => {
    await signInViaMagicLink(page, owner.email, '/dashboard/operator');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard/operator');

    await page.getByRole('textbox', { name: /message/i }).fill('Make my replies warmer.');
    await page.getByRole('button', { name: 'Send' }).click();
    // WAIT FOR THE POST TO LAND before standing in for the worker: "Preparing
    // your plan" renders only once the response carried a turn id back, so it
    // is the signal that the row this helper looks for is committed. Without
    // it `findAcceptedTurn` races the transaction and throws.
    await expect(page.getByText('Preparing your plan')).toBeVisible();
    const completed = await completeTurnWithProposal({
      accountId: owner.seed.accountId,
      userId: owner.seed.userId,
    });
    await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible({ timeout: 15_000 });

    // THE CONCURRENT WRITE, after the card rendered and before the click.
    await moveVoiceRow({
      accountId: owner.seed.accountId,
      businessId: owner.seed.businessId,
      tone: 'formal and precise',
    });

    await page.getByRole('button', { name: 'Apply' }).click();
    // `.first()`: the stale sentence lands twice by design — once as the
    // card's state line, once as the refusal notice beside the buttons.
    await expect(
      page.getByText(/settings changed after this plan was prepared/i).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Refresh plan' })).toBeVisible();
    await page.screenshot({ path: `${EVIDENCE}/stale-card-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${EVIDENCE}/stale-card-390.png`, fullPage: true });

    const row = await readProposalRow(completed.proposalId);
    expect(row.status).toBe('stale');
    expect(row.failure_reason).toBe('version_mismatch');
    expect(row.receipt).toBeNull();
    // NOTHING was applied: the concurrent write's value stands untouched.
    expect(await readTone(owner.seed.businessId)).toBe('formal and precise');

    // REFRESH PLAN posts a NEW turn from the original instruction and the
    // original location (RB-03).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Refresh plan' }).click();
    await expect(page.getByText('Preparing your plan')).toBeVisible({ timeout: 15_000 });
    expect(await countTurns(owner.seed.accountId)).toBe(2);
    const refreshed = await findAcceptedTurn(owner.seed.accountId);
    expect(refreshed.ownerText).toBe('Make my replies warmer.');
    expect(refreshed.locationId).toBe(owner.seed.businessId);
  });
});
