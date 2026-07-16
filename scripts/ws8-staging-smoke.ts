// WS8 cutover controlled smoke (runbook §6). Scenario-addressable driver.
//
// Runs against the TARGET environment's injected variables only — like the
// phase-3/4 scripts, it never loads .env.local, because staging's Stripe
// account differs from the one in .env.local.
//
//   railway run --environment staging --service repworth-worker -- \
//     pnpm tsx scripts/ws8-staging-smoke.ts <scenario|seed|cleanup|state>
//
// Every scenario prints one `WS8_SMOKE <id> PASS|FAIL <detail>` line, which is
// the evidence record's per-scenario source. Fixtures are seeded directly into
// the database rather than through /api/auth/signup so the phase-2 producer
// denials stay in force.
import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';

import { getStripe } from '../src/lib/payments/stripe-client';
import { applyTierSnapshot } from '../src/lib/payments/plan-activation';
import { createCheckoutSession } from '../src/lib/payments/create-checkout-session';
import { SubscriptionTier } from '../src/lib/accounts/tier-config';
import { applyTierChange, validateTierChange } from '../src/lib/accounts/tier-change';
import { computeOverageQuantity } from '../src/lib/accounts/quota';
import { syncStripeOverageItem } from '../worker/jobs/billing/overage-sync';
import {
  AutoApprovalExpansionBlockedError,
  patchAutoApprovalSettings,
} from '../src/lib/auto-approval/settings';
import {
  evaluateAutoApprovalCandidate,
  loadAutoApprovalRuntimeState,
} from '../worker/jobs/response-generation/auto-approval';
import { publishAutoPolicyResponse } from '../worker/jobs/publisher/auto-policy-publish';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '../src/lib/shared/worker-types';
import { runDirectCli } from './run-direct-cli';

/**
 * Marks every fixture row this driver owns, so cleanup can never over-delete.
 * Plus-addressed onto a real operator mailbox: Stripe's hosted Checkout page
 * prefills customer_email, and a deliverable address keeps receipts reachable.
 * The `+ws8smoke-` marker is what cleanup keys on — it cannot match the real
 * owner (norbertliverpool@gmail.com), only the fixtures.
 */
const FIXTURE_TAG = 'ws8smoke';
const FIXTURE_EMAIL_PREFIX = 'norbertliverpool+ws8smoke-';
// Named so ci:static-policy's variant-context exemption applies: 'founding'
// here is a PriceVariant, never the retired subscription tier.
const FOUNDING_PRICE_VARIANT = 'founding' as const;
/**
 * EVERY pattern this driver has ever seeded under. Cleanup must match all of
 * them: the address scheme changed mid-run (from an `@ws8smoke.invalid` domain
 * to operator plus-addressing), which silently orphaned the earlier fixtures
 * from cleanup — they still held provider Sessions. Never narrow this list;
 * only ever append.
 */
const FIXTURE_EMAIL_LIKE_PATTERNS = [
  'norbertliverpool+ws8smoke-%@gmail.com',
  '%@ws8smoke.invalid',
] as const;

export interface SmokeFixture {
  accountId: string;
  userId: string;
  businessId: string;
  email: string;
  variant: 'list' | 'founding';
}

function log(scenario: string, pass: boolean, detail: string): void {
  console.log(`WS8_SMOKE ${scenario} ${pass ? 'PASS' : 'FAIL'} ${detail}`);
}

/**
 * The authorized gate-open smoke, scoped to THIS PROCESS. getServerConfig() is
 * lazy + memoized (src/lib/config/server.ts:217), so the flag must be set before
 * the first read and can never be flipped mid-process — hence a whole separate
 * run rather than a wrapper. Process-scoped deliberately: the deployed staging
 * environment keeps AUTOPILOT_PURCHASABLE=false throughout, so no real purchase
 * path opens on an env where AUTO_APPROVAL_ENABLED=true could auto-post.
 */
function applyGateOpenFlagBeforeAnyConfigRead(): boolean {
  if (!process.argv.includes('--gate-open')) return false;
  process.env.AUTOPILOT_PURCHASABLE = 'true';
  return true;
}

function requireGateOpen(scenario: string): void {
  if (process.env.AUTOPILOT_PURCHASABLE === 'true') return;
  throw new Error(
    `${scenario} requires the authorized gate-open run: pass --gate-open`,
  );
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function connect(): Sql {
  return postgres(requireEnv('DATABASE_POOL_URL'), {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 30,
    // Supabase PgBouncer runs transaction pooling; prepared statements do not
    // survive a backend switch. Mirrors src/lib/db/server.ts.
    prepare: false,
    connection: { statement_timeout: 30_000 },
  });
}

// ── fixtures ───────────────────────────────────────────────────────────────

async function seedFixture(
  sql: Sql,
  variant: 'list' | 'founding',
  label: string,
  options: { tier?: string; status?: string } = {},
): Promise<SmokeFixture> {
  const tier = options.tier ?? 'copilot';
  const status = options.status ?? 'pending_payment';
  const userId = randomUUID();
  const accountId = randomUUID();
  const businessId = randomUUID();
  const email = `${FIXTURE_EMAIL_PREFIX}${label}-${Date.now()}@gmail.com`;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO users (id, name, email, role)
      VALUES (${userId}::uuid, ${`WS8 Smoke ${label}`}, ${email}, 'owner')
    `;
    // price_variant is INSERT-only by construction: 077's
    // accounts_price_variant_immutable trigger is BEFORE UPDATE OF, so the
    // variant under test must be stamped here and never updated.
    await tx`
      INSERT INTO accounts (
        id, owner_user_id, display_name, subscription_tier,
        subscription_status, price_variant
      )
      VALUES (
        ${accountId}::uuid, ${userId}::uuid, ${`WS8 Smoke ${label}`}, ${tier},
        ${status}, ${variant}
      )
    `;
    await tx`
      UPDATE users SET account_id = ${accountId}::uuid WHERE id = ${userId}::uuid
    `;
    // onboarded_by NULL = the self-serve discriminator both the checkout route
    // and resolveCheckoutContext use to decide trial eligibility.
    await tx`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id,
        subscription_tier, is_primary, onboarded_by
      )
      VALUES (
        ${businessId}::uuid, ${`WS8 Smoke ${label}`}, 'WS8 Smoke',
        ${email}, ${accountId}::uuid, ${tier}, TRUE, NULL
      )
    `;
  });

  return { accountId, userId, businessId, email, variant };
}

async function cleanupFixtures(sql: Sql): Promise<number> {
  const accounts = await sql<{
    id: string;
    checkout_session_id: string | null;
    stripe_subscription_id: string | null;
  }[]>`
    SELECT a.id, a.checkout_session_id, a.stripe_subscription_id
    FROM accounts a
    JOIN users u ON u.id = a.owner_user_id
    WHERE u.email LIKE ANY(${FIXTURE_EMAIL_LIKE_PATTERNS as unknown as string[]})
  `;

  // Provider objects outlive the rows, and Stripe has no delete-subscription
  // API. A fixture that reached a completed Checkout owns a subscription that
  // will exist forever; deleting its account row makes that subscription
  // UNPROJECTED, which is a hard §4 preflight blocker resolvable only by
  // growing the reviewed-orphan allowlist. That is exactly how this smoke took
  // staging from 10 to 11 reviewed orphans before this was fixed.
  //
  // So: a fixture WITH a subscription keeps its account row (cancelled +
  // projected = passes §4 cleanly, no allowlist entry). Only fixtures that
  // never reached a completed Checkout are deleted outright.
  const preserved: string[] = [];
  for (const account of accounts) {
    if (account.checkout_session_id) {
      try {
        const session = await getStripe().checkout.sessions.retrieve(
          account.checkout_session_id,
        );
        if (session.status === 'open') {
          await getStripe().checkout.sessions.expire(account.checkout_session_id);
        }
      } catch (error) {
        console.error(
          `cleanup: could not resolve Session ${account.checkout_session_id}`,
          error,
        );
      }
    }
    // A live nonterminal subscription is a HARD preflight blocker (§4: only
    // canceled / incomplete_expired pass). Cancelling here is what keeps the
    // smoke from leaving the cutover gate unpassable.
    if (account.stripe_subscription_id) {
      try {
        const subscription = await getStripe().subscriptions.retrieve(
          account.stripe_subscription_id,
        );
        if (
          subscription.status !== 'canceled'
          && subscription.status !== 'incomplete_expired'
        ) {
          await getStripe().subscriptions.cancel(
            account.stripe_subscription_id,
            { invoice_now: false, prorate: false },
            { idempotencyKey: `ws8-smoke-cleanup-cancel:v1:${account.stripe_subscription_id}` },
          );
          console.log(`cleanup: cancelled ${account.stripe_subscription_id}`);
        }
      } catch (error) {
        console.error(
          `cleanup: could not cancel subscription ${account.stripe_subscription_id}`,
          error,
        );
      }
    }
  }

  for (const account of accounts) {
    // Keep the projection alive for anything that owns a provider subscription.
    if (account.stripe_subscription_id) {
      await sql`
        UPDATE accounts
        SET subscription_status = 'cancelled',
            cancelled_at = COALESCE(cancelled_at, NOW()),
            checkout_attempt_state = NULL,
            updated_at = NOW()
        WHERE id = ${account.id}::uuid
      `;
      preserved.push(account.id);
      continue;
    }
    await sql.begin(async (tx) => {
      const businesses = await tx<{ id: string }[]>`
        SELECT id FROM businesses WHERE account_id = ${account.id}::uuid
      `;
      const businessIds = businesses.map((b) => b.id);
      if (businessIds.length > 0) {
        const responses = await tx<{ id: string }[]>`
          SELECT id FROM responses WHERE business_id = ANY(${businessIds}::uuid[])
        `;
        const responseIds = responses.map((r) => r.id);
        if (responseIds.length > 0) {
          // notification_deliveries FKs to responses — it must go first.
          await tx`DELETE FROM notification_deliveries WHERE response_id = ANY(${responseIds}::uuid[])`;
          await tx`DELETE FROM approval_audit_log WHERE response_id = ANY(${responseIds}::uuid[])`;
          await tx`DELETE FROM job_outbox WHERE aggregate_id = ANY(${responseIds}::uuid[])`;
          await tx`DELETE FROM responses WHERE id = ANY(${responseIds}::uuid[])`;
        }
        await tx`DELETE FROM notification_deliveries WHERE business_id = ANY(${businessIds}::uuid[])`;
        await tx`DELETE FROM reviews WHERE business_id = ANY(${businessIds}::uuid[])`;
      }
      await tx`DELETE FROM auto_approval_policies WHERE account_id = ${account.id}::uuid`;
      await tx`DELETE FROM account_audit_log WHERE account_id = ${account.id}::uuid`;
      await tx`DELETE FROM businesses WHERE account_id = ${account.id}::uuid`;
      await tx`UPDATE users SET account_id = NULL WHERE account_id = ${account.id}::uuid`;
      await tx`DELETE FROM accounts WHERE id = ${account.id}::uuid`;
    });
  }
  // Owners of preserved accounts must survive: accounts.owner_user_id is NOT
  // NULL, and an account kept alive for its projection needs its owner row.
  await sql`
    DELETE FROM users
    WHERE email LIKE ANY(${FIXTURE_EMAIL_LIKE_PATTERNS as unknown as string[]})
      AND account_id IS NULL
      AND id NOT IN (SELECT owner_user_id FROM accounts)
  `;
  if (preserved.length > 0) {
    console.log(
      `cleanup: PRESERVED ${preserved.length} account row(s) that own a Stripe `
      + `subscription, so it stays projected and needs no orphan allowlist entry: `
      + preserved.join(','),
    );
  }
  return accounts.length;
}

async function readLease(sql: Sql, accountId: string) {
  const [row] = await sql<{
    subscription_tier: string;
    price_variant: string;
    base_price_cents: number;
    checkout_attempt_state: string | null;
    checkout_session_id: string | null;
    checkout_attempt_id: string | null;
    checkout_attempt_base_price_id: string | null;
    checkout_attempt_trial_period_days: number | null;
    checkout_attempt_tax_enabled: boolean | null;
    checkout_attempt_customer_email: string | null;
    checkout_attempt_success_url: string | null;
  }[]>`
    SELECT subscription_tier, price_variant, base_price_cents,
           checkout_attempt_state, checkout_session_id, checkout_attempt_id,
           checkout_attempt_base_price_id, checkout_attempt_trial_period_days,
           checkout_attempt_tax_enabled, checkout_attempt_customer_email,
           checkout_attempt_success_url
    FROM accounts WHERE id = ${accountId}::uuid
  `;
  return row;
}

/** One selection+create round trip, exactly as the checkout route sequences it. */
async function selectAndCreate(
  sql: Sql,
  fixture: SmokeFixture,
  tier: string,
  trial: boolean,
) {
  const snapshot = await applyTierSnapshot(sql, {
    accountId: fixture.accountId,
    activationLockId: fixture.accountId,
    tier: tier as never,
    ownerEmail: fixture.email,
    trial,
  });
  if (snapshot.kind !== 'ok') {
    throw new Error(`applyTierSnapshot returned ${snapshot.kind}`);
  }
  const session = await createCheckoutSession(
    sql,
    fixture.accountId,
    tier as never,
    snapshot.variant,
    { attemptId: snapshot.attemptId, activationLockId: fixture.accountId },
  );
  return { snapshot, session };
}

// ── scenarios ──────────────────────────────────────────────────────────────

/** §6: explicit Copilot list/founding Checkout — Session shape + frozen lease. */
async function scenarioCheckoutVariant(
  sql: Sql,
  variant: 'list' | 'founding',
): Promise<boolean> {
  const id = `01-copilot-${variant}-checkout`;
  const fixture = await seedFixture(sql, variant, variant);
  const { session } = await selectAndCreate(
    sql,
    fixture,
    SubscriptionTier.COPILOT,
    false,
  );

  const provider = await getStripe().checkout.sessions.retrieve(session.sessionId, {
    expand: ['line_items'],
  });
  const lease = await readLease(sql, fixture.accountId);
  const expectedPriceId = requireEnv(
    variant === 'list' ? 'STRIPE_PRICE_COPILOT_LIST' : 'STRIPE_PRICE_COPILOT_FOUNDING',
  );
  const expectedCents = variant === 'list' ? 2900 : 1900;
  const lineItem = provider.line_items?.data[0];
  const priceId =
    typeof lineItem?.price === 'string' ? lineItem.price : lineItem?.price?.id;

  const checks: Array<[string, boolean]> = [
    ['session_open', provider.status === 'open'],
    ['mode_subscription', provider.mode === 'subscription'],
    ['client_reference_id', provider.client_reference_id === fixture.accountId],
    ['base_price_id', priceId === expectedPriceId],
    ['base_amount_cents', lineItem?.amount_total === expectedCents],
    ['single_line_item_no_overage', provider.line_items?.data.length === 1],
    ['lease_open', lease?.checkout_attempt_state === 'open'],
    ['lease_bound_to_session', lease?.checkout_session_id === session.sessionId],
    ['account_variant_immutable', lease?.price_variant === variant],
    ['snapshot_base_cents', lease?.base_price_cents === expectedCents],
    ['no_trial', lease?.checkout_attempt_trial_period_days === null],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${fixture.accountId} session=${session.sessionId} price=${priceId} ` +
      `amount=${lineItem?.amount_total} ${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/** §6: same-tier Checkout retry returns the same provider-open Session. */
async function scenarioSameTierRetry(sql: Sql): Promise<boolean> {
  const id = '03-same-tier-retry';
  const fixture = await seedFixture(sql, FOUNDING_PRICE_VARIANT, 'retry');
  const first = await selectAndCreate(sql, fixture, SubscriptionTier.COPILOT, false);
  const second = await selectAndCreate(sql, fixture, SubscriptionTier.COPILOT, false);

  const sameSession = first.session.sessionId === second.session.sessionId;
  const sameUrl = first.session.url === second.session.url;
  const provider = await getStripe().checkout.sessions.retrieve(
    first.session.sessionId,
  );
  const pass = sameSession && sameUrl && provider.status === 'open';
  log(
    id,
    pass,
    `account=${fixture.accountId} first=${first.session.sessionId} ` +
      `second=${second.session.sessionId} same=${sameSession} status=${provider.status}`,
  );
  return pass;
}

/**
 * §6: the exact creating/open retry stays stable after Price-map, tax-flag,
 * owner-email, or deployment-URL drift, because it replays the frozen lease
 * create tuple rather than re-reading configuration.
 */
async function scenarioLeaseDriftStability(sql: Sql): Promise<boolean> {
  const id = '04-lease-drift-stability';
  const fixture = await seedFixture(sql, FOUNDING_PRICE_VARIANT, 'drift');
  const first = await selectAndCreate(sql, fixture, SubscriptionTier.COPILOT, false);
  const frozen = await readLease(sql, fixture.accountId);

  // Drift every caller/environment input the create tuple froze. price-tier-map
  // and NEXT_PUBLIC_APP_URL are read at call time and STRIPE_TAX_ENABLED goes
  // through the non-memoized readFlag, so all four genuinely move in-process.
  const restore = {
    price: process.env.STRIPE_PRICE_COPILOT_FOUNDING,
    tax: process.env.STRIPE_TAX_ENABLED,
    url: process.env.NEXT_PUBLIC_APP_URL,
  };
  process.env.STRIPE_PRICE_COPILOT_FOUNDING = requireEnv('STRIPE_PRICE_COPILOT_LIST');
  process.env.STRIPE_TAX_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = 'https://drifted.example.invalid';
  const driftedEmail = `${FIXTURE_EMAIL_PREFIX}drifted-${Date.now()}@gmail.com`;
  await sql`UPDATE users SET email = ${driftedEmail} WHERE id = ${fixture.userId}::uuid`;

  try {
    const retry = await selectAndCreate(
      sql,
      { ...fixture, email: driftedEmail },
      SubscriptionTier.COPILOT,
      false,
    );
    const after = await readLease(sql, fixture.accountId);
    const provider = await getStripe().checkout.sessions.retrieve(
      retry.session.sessionId,
      { expand: ['line_items'] },
    );
    const lineItem = provider.line_items?.data[0];
    const priceId =
      typeof lineItem?.price === 'string' ? lineItem.price : lineItem?.price?.id;

    const checks: Array<[string, boolean]> = [
      ['same_session', retry.session.sessionId === first.session.sessionId],
      ['price_id_frozen', priceId === frozen?.checkout_attempt_base_price_id],
      ['price_not_drifted', priceId !== process.env.STRIPE_PRICE_COPILOT_FOUNDING],
      ['amount_frozen_1900', lineItem?.amount_total === 1900],
      ['tax_flag_frozen', after?.checkout_attempt_tax_enabled === frozen?.checkout_attempt_tax_enabled],
      ['email_frozen', after?.checkout_attempt_customer_email === fixture.email],
      ['url_frozen', after?.checkout_attempt_success_url === frozen?.checkout_attempt_success_url],
      ['url_not_drifted', !after?.checkout_attempt_success_url?.includes('drifted')],
      ['attempt_id_stable', after?.checkout_attempt_id === frozen?.checkout_attempt_id],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    log(
      id,
      failed.length === 0,
      `account=${fixture.accountId} session=${retry.session.sessionId} ` +
        `frozen_price=${frozen?.checkout_attempt_base_price_id} provider_price=${priceId} ` +
        `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
    );
    return failed.length === 0;
  } finally {
    process.env.STRIPE_PRICE_COPILOT_FOUNDING = restore.price;
    if (restore.tax === undefined) delete process.env.STRIPE_TAX_ENABLED;
    else process.env.STRIPE_TAX_ENABLED = restore.tax;
    process.env.NEXT_PUBLIC_APP_URL = restore.url;
  }
}

/**
 * §6: settings expansion denial while the Autopilot gate is closed. Runs on an
 * AUTOPILOT account so the only thing withholding `autopilot_unavailable` is
 * AUTOPILOT_PURCHASABLE itself.
 */
async function scenarioExpansionDenialGateClosed(sql: Sql): Promise<boolean> {
  const id = '12-expansion-denial-gate-closed';
  if (process.env.AUTOPILOT_PURCHASABLE === 'true') {
    log(id, false, 'precondition_failed: AUTOPILOT_PURCHASABLE is true; this scenario requires the closed gate');
    return false;
  }
  const fixture = await seedFixture(sql, 'list', 'expansion', {
    tier: 'autopilot',
    status: 'active',
  });

  let blockReasons: string[] | null = null;
  let thrown = 'none';
  try {
    await patchAutoApprovalSettings(sql, {
      accountId: fixture.accountId,
      actorUserId: fixture.userId,
      impersonated: false,
      operation: 'set_account_default',
      threshold: 5,
      confirmationLevel: 'standard',
    } as never);
  } catch (error) {
    thrown = error instanceof Error ? error.name : 'unknown';
    if (error instanceof AutoApprovalExpansionBlockedError) {
      blockReasons = error.blockReasons;
    }
  }

  // The gate is documented as "blocked => nothing written" structurally, not by
  // rollback, so the absence of a policy row is the load-bearing assertion.
  const policies = await sql<{ id: string }[]>`
    SELECT id FROM auto_approval_policies WHERE account_id = ${fixture.accountId}::uuid
  `;
  const checks: Array<[string, boolean]> = [
    ['expansion_blocked_error', thrown === 'AutoApprovalExpansionBlockedError'],
    ['autopilot_unavailable_reason', blockReasons?.includes('autopilot_unavailable') === true],
    ['no_policy_row_written', policies.length === 0],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${fixture.accountId} tier=autopilot gate=closed threw=${thrown} ` +
      `blockReasons=[${blockReasons?.join('|') ?? ''}] policy_rows=${policies.length} ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/**
 * §6: Copilot grant-time `auto_policy` denial. Asserts by CONTRAST — the same
 * review/policy/moderation inputs are evaluated on copilot and then on
 * autopilot, so the verdict isolates the tier gate rather than merely observing
 * that something blocked.
 */
async function scenarioCopilotGrantDenial(sql: Sql): Promise<boolean> {
  const id = '13-copilot-grant-auto-policy-denial';
  const fixture = await seedFixture(sql, 'list', 'grant', {
    tier: 'copilot',
    status: 'active',
  });
  const reviewId = randomUUID();
  const contentHash = randomUUID().replace(/-/g, '');

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO reviews (
        id, business_id, provider_review_id, provider_review_name,
        provider_location_name, star_rating, review_content_hash
      )
      VALUES (
        ${reviewId}::uuid, ${fixture.businessId}::uuid, ${`${FIXTURE_TAG}-${reviewId}`},
        ${`accounts/x/locations/y/reviews/${reviewId}`}, 'accounts/x/locations/y',
        5, ${contentHash}
      )
    `;
    // An account-default policy that would otherwise ADMIT this 5-star review,
    // so the tier gate is the only thing standing between it and approval.
    await tx`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, auto_approve_min_star, veto_window_minutes
      )
      VALUES (${randomUUID()}::uuid, ${fixture.accountId}::uuid, NULL, 4, 15)
    `;
  });

  const evaluate = async () =>
    sql.begin(async (tx) => {
      const state = await loadAutoApprovalRuntimeState(tx as never, {
        reviewId,
        businessId: fixture.businessId,
        accountId: fixture.accountId,
      });
      return evaluateAutoApprovalCandidate({
        ...state,
        originLane: GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW,
        version: 1,
        suppressNotification: false,
        loadedReviewContentHash: contentHash,
        moderation: { flagged: false, providerStatus: 'clean' } as never,
        held: false,
      } as never);
    });

  const asCopilot = await evaluate();
  await sql`
    UPDATE accounts SET subscription_tier = 'autopilot' WHERE id = ${fixture.accountId}::uuid
  `;
  const asAutopilot = await evaluate();

  const checks: Array<[string, boolean]> = [
    ['copilot_not_approved', asCopilot.approved === false],
    ['copilot_tier_required_reason', asCopilot.blockReasons.includes('autopilot_tier_required')],
    ['autopilot_reason_absent', !asAutopilot.blockReasons.includes('autopilot_tier_required')],
    ['tier_read_authoritatively', asCopilot.blockReasons.length !== asAutopilot.blockReasons.length],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${fixture.accountId} review=${reviewId} ` +
      `copilot_reasons=[${asCopilot.blockReasons.join('|')}] ` +
      `autopilot_reasons=[${asAutopilot.blockReasons.join('|')}] ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/**
 * §6: publish-time downgrade after entitlement loss. Seeds an auto_policy
 * approval on an autopilot account, drops the tier to copilot, then runs the
 * real publisher entry point. The fixture business has no Zernio connection, so
 * even a gate regression cannot reach a provider post from here.
 */
async function scenarioPublishTimeDowngrade(sql: Sql): Promise<boolean> {
  const id = '14-publish-time-downgrade';
  const fixture = await seedFixture(sql, 'list', 'downgrade', {
    tier: 'autopilot',
    status: 'active',
  });
  const reviewId = randomUUID();
  const responseId = randomUUID();
  const outboxId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO reviews (
        id, business_id, provider_review_id, provider_review_name,
        provider_location_name, star_rating, review_content_hash
      )
      VALUES (
        ${reviewId}::uuid, ${fixture.businessId}::uuid, ${`${FIXTURE_TAG}-${reviewId}`},
        ${`accounts/x/locations/y/reviews/${reviewId}`}, 'accounts/x/locations/y',
        5, ${randomUUID().replace(/-/g, '')}
      )
    `;
    await tx`
      INSERT INTO responses (
        id, review_id, business_id, response_text, original_draft_text,
        status, approval_method, approved_text, approved_at
      )
      VALUES (
        ${responseId}::uuid, ${reviewId}::uuid, ${fixture.businessId}::uuid,
        'Thank you for the kind words!', 'Thank you for the kind words!',
        'approved', 'auto_policy', 'Thank you for the kind words!', NOW()
      )
    `;
    // The entitlement gate sits BEHIND the veto gate in LOCKED_GATE_CHECKS, so
    // an un-notified fixture downgrades for 'notice_undelivered' and never
    // reaches the tier check. Satisfy the veto window honestly: a delivered
    // pending_post_notice whose window has fully elapsed, plus the
    // auto_approved_by_policy grant row it anchors to.
    await tx`
      INSERT INTO notification_deliveries (
        id, business_id, response_id, channel, recipient, template, sent_at
      )
      VALUES (
        ${randomUUID()}::uuid, ${fixture.businessId}::uuid, ${responseId}::uuid,
        'email', ${fixture.email}, 'pending_post_notice', NOW() - INTERVAL '60 minutes'
      )
    `;
    await tx`
      INSERT INTO approval_audit_log (
        id, account_id, business_id, response_id, action, metadata
      )
      VALUES (
        ${randomUUID()}::uuid, ${fixture.accountId}::uuid, ${fixture.businessId}::uuid,
        ${responseId}::uuid, 'auto_approved_by_policy',
        ${tx.json({ veto_window_minutes: 15 })}
      )
    `;
    // `attempts` must match the outboxAttempt passed to the publisher:
    // lockProviderAttemptMarkerRow guards on `attempts = ${outboxAttempt}`, so a
    // mismatch silently turns the whole call into a no-op.
    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, status, attempts
      )
      VALUES (
        ${outboxId}::uuid, 'publish_response', 'response', ${responseId}::uuid,
        ${tx.json({ responseId, reviewId, businessId: fixture.businessId })}, 'dispatched', 1
      )
    `;
  });

  // Entitlement loss: the approval was granted under autopilot, publish happens
  // under copilot.
  await sql`
    UPDATE accounts SET subscription_tier = 'copilot' WHERE id = ${fixture.accountId}::uuid
  `;

  await publishAutoPolicyResponse(sql, {
    responseId,
    reviewId,
    businessId: fixture.businessId,
    accountId: fixture.accountId,
    approvedText: 'Thank you for the kind words!',
    outboxId,
    outboxAttempt: 1,
    correlationId: `${FIXTURE_TAG}-${outboxId}`,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as never,
  } as never);

  const [after] = await sql<{
    status: string;
    approval_method: string | null;
    posting_error: string | null;
    posted_at: Date | null;
  }[]>`
    SELECT status, approval_method, posting_error, posted_at
    FROM responses WHERE id = ${responseId}::uuid
  `;
  const audits = await sql<{ action: string }[]>`
    SELECT action FROM approval_audit_log WHERE response_id = ${responseId}::uuid
  `;

  const checks: Array<[string, boolean]> = [
    ['auto_policy_revoked', after?.approval_method === null],
    ['not_posted', after?.posted_at === null],
    ['downgrade_marker', after?.posting_error === 'auto_policy_revoked_tier_entitlement'],
    ['back_to_owner_review', after?.status === 'pending_approval'],
    ['audit_written', audits.some((a) => a.action.includes('tier_entitlement'))],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${fixture.accountId} response=${responseId} status=${after?.status} ` +
      `approval_method=${after?.approval_method} posting_error=${after?.posting_error} ` +
      `posted_at=${after?.posted_at ?? 'null'} audits=[${audits.map((a) => a.action).join('|')}] ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/** §6: card-up-front trial selection freezes a 30-day trial onto the lease. */
async function scenarioTrialSelection(sql: Sql): Promise<boolean> {
  const id = '01c-trial-selection';
  const fixture = await seedFixture(sql, FOUNDING_PRICE_VARIANT, 'trial');
  const { session } = await selectAndCreate(
    sql,
    fixture,
    SubscriptionTier.COPILOT,
    true,
  );
  const provider = await getStripe().checkout.sessions.retrieve(session.sessionId);
  const lease = await readLease(sql, fixture.accountId);

  // Stripe does NOT echo subscription_data back on a retrieved Session — the
  // trial only becomes observable on the subscription the Session creates. So
  // the frozen lease is the assertable WS8 artifact here; provider-side trial
  // confirmation belongs to the human-completed Checkout batch.
  const checks: Array<[string, boolean]> = [
    ['lease_trial_30', lease?.checkout_attempt_trial_period_days === 30],
    ['session_open', provider.status === 'open'],
    ['lease_bound', lease?.checkout_session_id === session.sessionId],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${fixture.accountId} session=${session.sessionId} ` +
      `lease_trial_days=${lease?.checkout_attempt_trial_period_days} ` +
      `provider_trial_days=not_readable_until_completion ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/** §6: explicit Autopilot Checkout — authorized gate-open portion only. */
async function scenarioAutopilotCheckout(
  sql: Sql,
  variant: 'list' | 'founding',
): Promise<boolean> {
  const id = `02-autopilot-${variant}-checkout`;
  requireGateOpen(id);
  const fixture = await seedFixture(sql, variant, `autopilot-${variant}`);

  const result = await selectAndCreate(
    sql,
    fixture,
    SubscriptionTier.AUTOPILOT,
    false,
  );
  const provider = await getStripe().checkout.sessions.retrieve(
    result.session.sessionId,
    { expand: ['line_items'] },
  );
  const lease = await readLease(sql, fixture.accountId);
  const expectedPriceId = requireEnv(
    variant === 'list' ? 'STRIPE_PRICE_AUTOPILOT_LIST' : 'STRIPE_PRICE_AUTOPILOT_FOUNDING',
  );
  const expectedCents = variant === 'list' ? 6900 : 4900;
  const lineItem = provider.line_items?.data[0];
  const priceId =
    typeof lineItem?.price === 'string' ? lineItem.price : lineItem?.price?.id;

  const checks: Array<[string, boolean]> = [
    ['session_open', provider.status === 'open'],
    ['base_price_id', priceId === expectedPriceId],
    ['base_amount_cents', lineItem?.amount_total === expectedCents],
    ['tier_autopilot', lease?.subscription_tier === 'autopilot'],
    ['snapshot_base_cents', lease?.base_price_cents === expectedCents],
    ['lease_bound', lease?.checkout_session_id === result.session.sessionId],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${fixture.accountId} session=${result.session.sessionId} ` +
      `gate=open price=${priceId} amount=${lineItem?.amount_total} ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/**
 * §6 companion to scenario 2, run with the gate CLOSED so the gate is proven
 * load-bearing rather than assumed. Separate process because getServerConfig()
 * memoizes on first read — a mid-process flip cannot work.
 */
async function scenarioAutopilotDeniedGateClosed(sql: Sql): Promise<boolean> {
  const id = '02b-autopilot-denied-gate-closed';
  if (process.env.AUTOPILOT_PURCHASABLE === 'true') {
    log(id, false, 'precondition_failed: this scenario requires the CLOSED gate');
    return false;
  }
  const fixture = await seedFixture(sql, FOUNDING_PRICE_VARIANT, 'autopilot-denied');
  let thrown = 'none';
  try {
    await selectAndCreate(sql, fixture, SubscriptionTier.AUTOPILOT, false);
  } catch (error) {
    thrown = error instanceof Error ? error.name : 'unknown';
  }
  const lease = await readLease(sql, fixture.accountId);
  const checks: Array<[string, boolean]> = [
    ['tier_not_purchasable_error', thrown === 'TierNotPurchasableError'],
    ['no_session_created', lease?.checkout_session_id === null],
    ['tier_not_granted', lease?.subscription_tier !== 'autopilot'],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${fixture.accountId} gate=closed threw=${thrown} ` +
      `session=${lease?.checkout_session_id ?? 'none'} tier=${lease?.subscription_tier} ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/** §6: Copilot → Autopilot reselection expires the prior open Copilot Session. */
async function scenarioReselectionExpiresPrior(sql: Sql): Promise<boolean> {
  const id = '05a-reselection-expires-prior';
  requireGateOpen(id);
  const fixture = await seedFixture(sql, FOUNDING_PRICE_VARIANT, 'reselect');
  const first = await selectAndCreate(sql, fixture, SubscriptionTier.COPILOT, false);
  const priorBefore = await getStripe().checkout.sessions.retrieve(
    first.session.sessionId,
  );

  const second = await selectAndCreate(
    sql,
    fixture,
    SubscriptionTier.AUTOPILOT,
    false,
  );
  const priorAfter = await getStripe().checkout.sessions.retrieve(
    first.session.sessionId,
  );
  const lease = await readLease(sql, fixture.accountId);

  const checks: Array<[string, boolean]> = [
    ['prior_was_open', priorBefore.status === 'open'],
    ['replacement_is_new_session', second.session.sessionId !== first.session.sessionId],
    ['prior_expired_before_replacement_exposed', priorAfter.status === 'expired'],
    ['lease_bound_to_replacement', lease?.checkout_session_id === second.session.sessionId],
    ['tier_now_autopilot', lease?.subscription_tier === 'autopilot'],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${fixture.accountId} prior=${first.session.sessionId} ` +
      `prior_before=${priorBefore.status} prior_after=${priorAfter.status} ` +
      `replacement=${second.session.sessionId} ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/**
 * §6: tier-change preview/execute must price from the account's STORED founder
 * variant, never a re-derived live one. Runs against a real active
 * subscription — the account id is passed in because the fixture was created by
 * a browser-completed Checkout.
 */
async function scenarioTierChange(sql: Sql, accountId: string): Promise<boolean> {
  const id = '09-tier-change-stored-founder-pricing';
  requireGateOpen(id);
  const [before] = await sql<{
    subscription_tier: string;
    price_variant: string;
    base_price_cents: number;
    stripe_subscription_id: string | null;
  }[]>`
    SELECT subscription_tier, price_variant, base_price_cents, stripe_subscription_id
    FROM accounts WHERE id = ${accountId}::uuid
  `;

  const preview = await validateTierChange(sql, accountId, SubscriptionTier.AUTOPILOT);
  const [afterPreview] = await sql<{ subscription_tier: string }[]>`
    SELECT subscription_tier FROM accounts WHERE id = ${accountId}::uuid
  `;

  const outcome = await applyTierChange(sql, {
    accountId,
    tier: SubscriptionTier.AUTOPILOT,
    operationKey: `ws8-smoke-tier-change:${accountId}`,
  });
  const [after] = await sql<{
    subscription_tier: string;
    price_variant: string;
    base_price_cents: number;
  }[]>`
    SELECT subscription_tier, price_variant, base_price_cents
    FROM accounts WHERE id = ${accountId}::uuid
  `;

  // Idempotency: the same operationKey must not double-apply.
  const replay = await applyTierChange(sql, {
    accountId,
    tier: SubscriptionTier.AUTOPILOT,
    operationKey: `ws8-smoke-tier-change:${accountId}`,
  });

  const checks: Array<[string, boolean]> = [
    ['started_copilot_founding', before?.subscription_tier === 'copilot' && before?.price_variant === 'founding'],
    ['preview_allowed', preview.allowed === true],
    // 4900 = autopilot FOUNDING. A re-derived variant would price 6900 (list).
    ['preview_uses_stored_founding_4900', preview.newBillingPreview?.basePriceCents === 4900],
    ['preview_is_non_mutating', afterPreview?.subscription_tier === 'copilot'],
    ['execute_ok', outcome.ok === true],
    ['tier_now_autopilot', after?.subscription_tier === 'autopilot'],
    ['variant_still_founding', after?.price_variant === 'founding'],
    ['base_now_autopilot_founding_4900', after?.base_price_cents === 4900],
    ['replay_idempotent', replay.ok === true || replay.code === 'same_tier'],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${accountId} before=${before?.subscription_tier}/${before?.price_variant}/${before?.base_price_cents} ` +
      `preview_allowed=${preview.allowed} preview_base=${preview.newBillingPreview?.basePriceCents} ` +
      `after=${after?.subscription_tier}/${after?.price_variant}/${after?.base_price_cents} ` +
      `execute_ok=${outcome.ok} replay=${replay.ok ? 'ok' : replay.code} ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/**
 * §6: overage item create/update/delete + quantity math, against a real
 * subscription. Walks the quantity through 2 → 3 → 1 → 0 so each provider
 * mutation is exercised in order, verifying the item on Stripe after each step
 * rather than trusting the returned outcome.
 */
async function scenarioOverageLifecycle(sql: Sql, accountId: string): Promise<boolean> {
  const id = '10-overage-lifecycle-and-quantity-math';
  const [account] = await sql<{
    subscription_tier: string;
    price_variant: string;
    stripe_subscription_id: string | null;
    locations_included: number;
    locations_overage_price_cents: number;
  }[]>`
    SELECT subscription_tier, price_variant, stripe_subscription_id,
           locations_included, locations_overage_price_cents
    FROM accounts WHERE id = ${accountId}::uuid
  `;
  const subscriptionId = account?.stripe_subscription_id;
  if (!subscriptionId) {
    log(id, false, `account=${accountId} has no stripe_subscription_id`);
    return false;
  }
  const overagePriceId = requireEnv(
    account.subscription_tier === 'autopilot'
      ? 'STRIPE_PRICE_AUTOPILOT_OVERAGE'
      : 'STRIPE_PRICE_COPILOT_OVERAGE',
  );
  const logger = { log: () => {}, warn: () => {}, error: () => {} };

  const sync = (newQuantity: number) =>
    syncStripeOverageItem(
      getStripe(),
      {
        accountId,
        subscriptionId,
        tier: account.subscription_tier as never,
        storedOveragePriceCents: account.locations_overage_price_cents,
        overagePriceId,
        newQuantity,
        mutationPolicy: 'allow_all',
        operationScope: `ws8-smoke-overage:${accountId}`,
      },
      logger as never,
    );

  /** Provider-current overage quantity — never trust the returned outcome alone. */
  const observedQuantity = async (): Promise<number | null> => {
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    const item = subscription.items.data.find((i) => i.price.id === overagePriceId);
    return item ? (item.quantity ?? null) : null;
  };

  // computeOverageQuantity(locations, included) = max(0, locations - included).
  const mathIncluded = account.locations_included;
  const math: Array<[string, boolean]> = [
    ['math_1_location_is_0_overage', computeOverageQuantity(1, mathIncluded) === 0],
    ['math_3_locations_is_2_overage', computeOverageQuantity(3, mathIncluded) === 2],
    ['math_never_negative', computeOverageQuantity(0, mathIncluded) === 0],
  ];

  const created = await sync(2);
  const afterCreate = await observedQuantity();
  const updated = await sync(3);
  const afterUpdate = await observedQuantity();
  const contracted = await sync(1);
  const afterContract = await observedQuantity();
  const deleted = await sync(0);
  const afterDelete = await observedQuantity();

  const checks: Array<[string, boolean]> = [
    ...math,
    ['create_applied', created.kind === 'applied' && created.action === 'created'],
    ['create_quantity_2_on_provider', afterCreate === 2],
    ['update_applied', updated.kind === 'applied' && updated.action === 'updated'],
    ['update_quantity_3_on_provider', afterUpdate === 3],
    ['contract_applied', contracted.kind === 'applied' && contracted.action === 'updated'],
    ['contract_quantity_1_on_provider', afterContract === 1],
    ['delete_applied', deleted.kind === 'applied' && deleted.action === 'deleted'],
    ['delete_removes_item_from_provider', afterDelete === null],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${accountId} sub=${subscriptionId} price=${overagePriceId} ` +
      `create=${created.kind}/${'action' in created ? created.action : '-'}→qty=${afterCreate} ` +
      `update=${'action' in updated ? updated.action : updated.kind}→qty=${afterUpdate} ` +
      `contract=${'action' in contracted ? contracted.action : contracted.kind}→qty=${afterContract} ` +
      `delete=${'action' in deleted ? deleted.action : deleted.kind}→qty=${afterDelete ?? 'item_gone'} ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

async function loadFixtureForWindow(sql: Sql, accountId: string): Promise<SmokeFixture> {
  const [row] = await sql<{
    account_id: string;
    user_id: string;
    business_id: string;
    email: string;
    price_variant: string;
  }[]>`
    SELECT a.id AS account_id, u.id AS user_id, b.id AS business_id,
           u.email, a.price_variant
    FROM accounts a
    JOIN users u ON u.id = a.owner_user_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE a.id = ${accountId}::uuid
  `;
  if (!row) throw new Error(`window fixture ${accountId} not found`);
  return {
    accountId: row.account_id,
    userId: row.user_id,
    businessId: row.business_id,
    email: row.email,
    variant: row.price_variant as 'list' | 'founding',
  };
}

/**
 * §6 scenario 5b: a prior COMPLETED Session blocks reselection. Only runnable
 * inside the webhook-disabled window — once projection runs, the account leaves
 * pending_payment and the status guard fires before the completed-lease branch.
 * Asserts both directions: same-tier retry and cross-tier reselection
 * (cross-tier needs --gate-open because assertTierPurchasable runs first).
 */
async function scenarioCompletedSessionBlocksReselection(
  sql: Sql,
  accountId: string,
): Promise<boolean> {
  const id = '05b-completed-session-blocks-reselection';
  requireGateOpen(id);
  const fixture = await loadFixtureForWindow(sql, accountId);
  const before = await readLease(sql, accountId);

  const attempt = async (tier: string): Promise<string> => {
    try {
      await selectAndCreate(sql, fixture, tier, false);
      return 'none';
    } catch (error) {
      return error instanceof Error ? error.name : 'unknown';
    }
  };
  const sameTier = await attempt(SubscriptionTier.COPILOT);
  const crossTier = await attempt(SubscriptionTier.AUTOPILOT);
  const after = await readLease(sql, accountId);

  const checks: Array<[string, boolean]> = [
    ['precondition_lease_open_unprojected', before?.checkout_attempt_state === 'open'],
    ['same_tier_conflict', sameTier === 'CheckoutAttemptConflictError'],
    ['cross_tier_conflict', crossTier === 'CheckoutAttemptConflictError'],
    ['lease_unchanged', after?.checkout_session_id === before?.checkout_session_id
      && after?.checkout_attempt_state === before?.checkout_attempt_state
      && after?.checkout_attempt_id === before?.checkout_attempt_id],
    ['snapshot_unchanged', after?.subscription_tier === before?.subscription_tier
      && after?.base_price_cents === before?.base_price_cents],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log(
    id,
    failed.length === 0,
    `account=${accountId} session=${before?.checkout_session_id} ` +
      `same_tier_threw=${sameTier} cross_tier_threw=${crossTier} ` +
      `lease_state=${after?.checkout_attempt_state} ` +
      `${failed.length ? `failed=${failed.join(',')}` : 'checks=' + checks.length}`,
  );
  return failed.length === 0;
}

/**
 * Post-remediation reselection (§6 scenario 7's "permitting explicit
 * reselection" clause + the setup for scenario 6's superseded delayed
 * completion). Creates the replacement Session on the SAME account.
 */
async function windowReselect(sql: Sql, accountId: string): Promise<boolean> {
  const fixture = await loadFixtureForWindow(sql, accountId);
  const { session } = await selectAndCreate(
    sql,
    fixture,
    SubscriptionTier.COPILOT,
    false,
  );
  const lease = await readLease(sql, accountId);
  const pass = lease?.checkout_session_id === session.sessionId
    && lease?.checkout_attempt_state === 'open';
  log(
    'window-reselect',
    pass,
    `account=${accountId} replacement=${session.sessionId} lease_state=${lease?.checkout_attempt_state}`,
  );
  return pass;
}

/**
 * Seeds one fixture, creates its Checkout Session, and prints the Stripe-hosted
 * URL. That URL is public — completing it needs no app login, so the browser
 * batch never touches the denied signup/auth paths.
 */
async function seedCheckoutForCompletion(sql: Sql, label: string): Promise<boolean> {
  const fixture = await seedFixture(sql, FOUNDING_PRICE_VARIANT, label);
  const { session } = await selectAndCreate(
    sql,
    fixture,
    SubscriptionTier.COPILOT,
    false,
  );
  console.log(
    `WS8_SMOKE seed-checkout PASS label=${label} account=${fixture.accountId} ` +
      `business=${fixture.businessId} email=${fixture.email} session=${session.sessionId}`,
  );
  console.log(`WS8_SMOKE_CHECKOUT_URL ${session.url}`);
  return true;
}

/** Prints the post-completion projection for one fixture account. */
async function reportAccount(sql: Sql, accountId: string): Promise<boolean> {
  const [row] = await sql<Record<string, unknown>[]>`
    SELECT subscription_tier, price_variant, subscription_status, base_price_cents,
           locations_included, locations_paid, trial_ends_at,
           stripe_customer_id IS NOT NULL AS has_customer,
           stripe_subscription_id, checkout_attempt_state, checkout_session_id,
           subscription_activated_at
    FROM accounts WHERE id = ${accountId}::uuid
  `;
  console.log(JSON.stringify(row, null, 2));
  const outbox = await sql`
    SELECT topic, status, attempts FROM job_outbox
    WHERE aggregate_id = ${accountId}::uuid ORDER BY created_at DESC LIMIT 10
  `;
  console.table(outbox);
  return true;
}

// ── entry point ────────────────────────────────────────────────────────────

type ScenarioRunner = (sql: Sql) => Promise<boolean>;

const SCENARIOS: Record<string, ScenarioRunner> = {
  '01-list': (sql) => scenarioCheckoutVariant(sql, 'list'),
  '01-founding': (sql) => scenarioCheckoutVariant(sql, 'founding'),
  '01c-trial': scenarioTrialSelection,
  '02-autopilot-list': (sql) => scenarioAutopilotCheckout(sql, 'list'),
  '02-autopilot-founding': (sql) => scenarioAutopilotCheckout(sql, 'founding'),
  '02b-autopilot-denied-gate-closed': scenarioAutopilotDeniedGateClosed,
  '05a-reselection-expires-prior': scenarioReselectionExpiresPrior,
  '03-same-tier-retry': scenarioSameTierRetry,
  '04-lease-drift-stability': scenarioLeaseDriftStability,
  '12-expansion-denial-gate-closed': scenarioExpansionDenialGateClosed,
  '13-copilot-grant-denial': scenarioCopilotGrantDenial,
  '14-publish-time-downgrade': scenarioPublishTimeDowngrade,
};

async function main(): Promise<number> {
  const gateOpen = applyGateOpenFlagBeforeAnyConfigRead();
  if (gateOpen) {
    console.log(
      `WS8_SMOKE gate-open-window process_scoped AUTOPILOT_PURCHASABLE=true ` +
        `deployed_env_unchanged=true utc=${new Date().toISOString()}`,
    );
  }
  const command = process.argv[2];
  if (!command) {
    console.error(`usage: ws8-staging-smoke.ts <${['cleanup', 'state', ...Object.keys(SCENARIOS)].join('|')}>`);
    return 2;
  }
  const sql = connect();
  try {
    if (command === 'cleanup') {
      const removed = await cleanupFixtures(sql);
      console.log(`WS8_SMOKE cleanup PASS removed_accounts=${removed}`);
      return 0;
    }
    if (command === 'seed-checkout') {
      const label = process.argv[3] ?? 'browser';
      return (await seedCheckoutForCompletion(sql, label)) ? 0 : 1;
    }
    if (command === 'tier-change') {
      const accountId = process.argv[3];
      if (!accountId) {
        console.error('usage: tier-change <accountId> --gate-open');
        return 2;
      }
      return (await scenarioTierChange(sql, accountId)) ? 0 : 1;
    }
    if (command === 'window-5b') {
      const accountId = process.argv[3];
      if (!accountId) {
        console.error('usage: window-5b <accountId> --gate-open');
        return 2;
      }
      return (await scenarioCompletedSessionBlocksReselection(sql, accountId)) ? 0 : 1;
    }
    if (command === 'window-reselect') {
      const accountId = process.argv[3];
      if (!accountId) {
        console.error('usage: window-reselect <accountId>');
        return 2;
      }
      return (await windowReselect(sql, accountId)) ? 0 : 1;
    }
    if (command === 'overage') {
      const accountId = process.argv[3];
      if (!accountId) {
        console.error('usage: overage <accountId>');
        return 2;
      }
      return (await scenarioOverageLifecycle(sql, accountId)) ? 0 : 1;
    }
    if (command === 'report') {
      const accountId = process.argv[3];
      if (!accountId) {
        console.error('usage: report <accountId>');
        return 2;
      }
      return (await reportAccount(sql, accountId)) ? 0 : 1;
    }
    if (command === 'state') {
      const rows = await sql`
        SELECT id, subscription_tier, price_variant, subscription_status,
               checkout_attempt_state, checkout_session_id
        FROM accounts ORDER BY created_at
      `;
      console.table(rows);
      return 0;
    }
    const runner = SCENARIOS[command];
    if (!runner) {
      console.error(`unknown scenario: ${command}`);
      return 2;
    }
    return (await runner(sql)) ? 0 : 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

runDirectCli({
  importMetaUrl: import.meta.url,
  main,
  onError: (error) => {
    console.error('WS8_SMOKE driver error', error);
    return 1;
  },
});
