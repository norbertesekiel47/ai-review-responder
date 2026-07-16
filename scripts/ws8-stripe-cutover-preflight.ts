// Provider-wide WS8 cutover blocker. Dry-run is the default and the only
// mutation it can perform is explicitly expiring open Checkout Sessions that
// contain a retained legacy Price.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres, { type Sql } from 'postgres';

import { STRIPE_PRICE_ENV_VARS } from '../src/lib/payments/price-tier-map';
import { getStripe } from '../src/lib/payments/stripe-client';

export const LEGACY_STRIPE_PRICE_ENV_VARS = [
  'STRIPE_PRICE_BASIC',
  'STRIPE_PRICE_FOUNDING',
  'STRIPE_PRICE_FOUNDERS_OVERAGE',
  'STRIPE_PRICE_STANDARD',
  'STRIPE_PRICE_STANDARD_OVERAGE',
  'STRIPE_PRICE_PREMIUM',
  'STRIPE_PRICE_PREMIUM_OVERAGE',
] as const;

export class Ws8StripePreflightConfigurationError extends Error {
  override readonly name = 'Ws8StripePreflightConfigurationError';
}

const TERMINAL_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);
const PAGE_LIMIT = 100;

export interface AccountProjection {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string;
}

export interface StripeSubscriptionProjection {
  id: string;
  status: string;
  customer: string | { id: string } | null;
}

export interface StripeCheckoutSessionProjection {
  id: string;
  client_reference_id: string | null;
}

export interface StripeLineItemProjection {
  id: string;
  price: string | { id: string } | null;
}

export interface StripePage<T> {
  data: T[];
  has_more: boolean;
}

export interface Ws8StripePreflightStripe {
  listSubscriptions(input: {
    status: 'all';
    limit: number;
    starting_after?: string;
  }): Promise<StripePage<StripeSubscriptionProjection>>;
  listOpenCheckoutSessions(input: {
    status: 'open';
    limit: number;
    starting_after?: string;
  }): Promise<StripePage<StripeCheckoutSessionProjection>>;
  listCheckoutSessionLineItems(
    sessionId: string,
    input: { limit: number; starting_after?: string },
  ): Promise<StripePage<StripeLineItemProjection>>;
  expireCheckoutSession(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<void>;
}

export type Ws8StripePreflightBlocker =
  | {
      kind: 'nonterminal_subscription';
      subscriptionId: string;
      status: string;
      accountId: string | null;
    }
  | {
      kind: 'unprojected_subscription';
      subscriptionId: string;
      customerId: string | null;
    }
  | {
      kind: 'subscription_projection_conflict';
      subscriptionId: string;
      accountIds: string[];
    }
  | {
      kind: 'customer_projection_conflict';
      subscriptionId: string;
      customerId: string;
      accountIds: string[];
    }
  | {
      kind: 'subscription_id_disagreement';
      subscriptionId: string;
      accountId: string;
      projectedSubscriptionId: string | null;
    }
  | {
      kind: 'customer_projection_disagreement';
      subscriptionId: string;
      accountId: string;
      providerCustomerId: string | null;
      projectedCustomerId: string | null;
    }
  | {
      kind: 'database_subscription_missing_from_provider';
      accountId: string;
      projectedSubscriptionId: string;
    }
  | {
      kind: 'legacy_checkout_session';
      sessionId: string;
      legacyPriceIds: string[];
    };

export interface Ws8StripePreflightNotice {
  kind: 'subscription_status_disagreement';
  subscriptionId: string;
  accountId: string;
  providerStatus: string;
  projectedStatus: string;
  resolution:
    | 'requires_status_applier'
    | 'applier_noop_fixed_point'
    | 'requires_manual_resolution';
}

export interface Ws8StripePreflightResult {
  blockers: Ws8StripePreflightBlocker[];
  notices: Ws8StripePreflightNotice[];
  subscriptionsScanned: number;
  openSessionsScanned: number;
  lineItemsScanned: number;
  legacySessionsExpired: number;
}

interface RunPreflightInput {
  accounts: readonly AccountProjection[];
  stripe: Ws8StripePreflightStripe;
  legacyPriceIds: ReadonlySet<string>;
  expireLegacySessions?: boolean;
  requireStatusConvergence?: boolean;
  log?: (line: string) => void;
}

function providerCustomerId(customer: StripeSubscriptionProjection['customer']): string | null {
  if (typeof customer === 'string') return customer;
  return customer?.id ?? null;
}

function lineItemPriceId(price: StripeLineItemProjection['price']): string | null {
  if (typeof price === 'string') return price;
  return price?.id ?? null;
}

function expectedLocalStatus(providerStatus: string): string | null {
  switch (providerStatus) {
    case 'trialing':
    case 'active':
      return providerStatus;
    case 'canceled':
      return 'cancelled';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
      return 'past_due';
    default:
      return null;
  }
}

const STATUS_APPLIER_SOURCES_BY_TARGET: Readonly<Record<string, ReadonlySet<string>>> = {
  trialing: new Set(['pending_payment']),
  active: new Set(['pending_payment', 'trialing', 'past_due']),
  past_due: new Set(['active', 'trialing']),
  cancelled: new Set(['pending_payment', 'active', 'trialing', 'past_due']),
};
const RECOGNIZED_LOCAL_STATUSES = new Set([
  'pending_payment',
  'trialing',
  'active',
  'past_due',
  'cancelled',
]);

function statusNoticeResolution(
  providerStatus: string,
  projectedStatus: string,
): Ws8StripePreflightNotice['resolution'] {
  const target = expectedLocalStatus(providerStatus);
  if (!target || !RECOGNIZED_LOCAL_STATUSES.has(projectedStatus)) {
    return 'requires_manual_resolution';
  }
  return STATUS_APPLIER_SOURCES_BY_TARGET[target]?.has(projectedStatus)
    ? 'requires_status_applier'
    : 'applier_noop_fixed_point';
}

async function paginate<T>(
  listPage: (startingAfter?: string) => Promise<StripePage<T>>,
  idFor: (item: T) => string,
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await listPage(startingAfter);
    all.push(...page.data);
    if (!page.has_more) return all;
    const last = page.data.at(-1);
    if (!last) {
      throw new Error('Stripe pagination returned has_more=true with an empty page');
    }
    startingAfter = idFor(last);
  }
}

function reconciliationFindings(
  subscription: StripeSubscriptionProjection,
  accounts: readonly AccountProjection[],
): {
  blockers: Ws8StripePreflightBlocker[];
  notices: Ws8StripePreflightNotice[];
} {
  const blockers: Ws8StripePreflightBlocker[] = [];
  const notices: Ws8StripePreflightNotice[] = [];
  const customerId = providerCustomerId(subscription.customer);
  const subscriptionMatches = accounts.filter(
    (account) => account.stripe_subscription_id === subscription.id,
  );
  const customerMatches = customerId
    ? accounts.filter((account) => account.stripe_customer_id === customerId)
    : [];

  if (subscriptionMatches.length > 1) {
    blockers.push({
      kind: 'subscription_projection_conflict',
      subscriptionId: subscription.id,
      accountIds: subscriptionMatches.map((account) => account.id).sort(),
    });
    return { blockers, notices };
  }
  if (customerId && customerMatches.length > 1) {
    blockers.push({
      kind: 'customer_projection_conflict',
      subscriptionId: subscription.id,
      customerId,
      accountIds: customerMatches.map((account) => account.id).sort(),
    });
    return { blockers, notices };
  }

  const account = subscriptionMatches[0];
  if (!account) {
    if (customerMatches.length === 1) {
      const customerAccount = customerMatches[0]!;
      blockers.push({
        kind: 'subscription_id_disagreement',
        subscriptionId: subscription.id,
        accountId: customerAccount.id,
        projectedSubscriptionId: customerAccount.stripe_subscription_id,
      });
    } else {
      blockers.push({
        kind: 'unprojected_subscription',
        subscriptionId: subscription.id,
        customerId,
      });
    }
    return { blockers, notices };
  }

  if (!customerId || account.stripe_customer_id !== customerId) {
    blockers.push({
      kind: 'customer_projection_disagreement',
      subscriptionId: subscription.id,
      accountId: account.id,
      providerCustomerId: customerId,
      projectedCustomerId: account.stripe_customer_id,
    });
  }
  const expectedStatus = expectedLocalStatus(subscription.status);
  if (!expectedStatus || account.subscription_status !== expectedStatus) {
    notices.push({
      kind: 'subscription_status_disagreement',
      subscriptionId: subscription.id,
      accountId: account.id,
      providerStatus: subscription.status,
      projectedStatus: account.subscription_status,
      resolution: statusNoticeResolution(subscription.status, account.subscription_status),
    });
  }
  return { blockers, notices };
}

function blockerLogLine(blocker: Ws8StripePreflightBlocker): string {
  switch (blocker.kind) {
    case 'nonterminal_subscription':
      return `BLOCK nonterminal_subscription subscription=${blocker.subscriptionId} status=${blocker.status} account=${blocker.accountId ?? 'none'}`;
    case 'unprojected_subscription':
      return `BLOCK unprojected_subscription subscription=${blocker.subscriptionId} customer=${blocker.customerId ?? 'none'}`;
    case 'subscription_projection_conflict':
      return `BLOCK subscription_projection_conflict subscription=${blocker.subscriptionId} accounts=${blocker.accountIds.join(',')}`;
    case 'customer_projection_conflict':
      return `BLOCK customer_projection_conflict subscription=${blocker.subscriptionId} customer=${blocker.customerId} accounts=${blocker.accountIds.join(',')}`;
    case 'subscription_id_disagreement':
      return `BLOCK subscription_id_disagreement subscription=${blocker.subscriptionId} account=${blocker.accountId} projected_subscription=${blocker.projectedSubscriptionId ?? 'none'}`;
    case 'customer_projection_disagreement':
      return `BLOCK customer_projection_disagreement subscription=${blocker.subscriptionId} account=${blocker.accountId} provider_customer=${blocker.providerCustomerId ?? 'none'} projected_customer=${blocker.projectedCustomerId ?? 'none'}`;
    case 'database_subscription_missing_from_provider':
      return `BLOCK database_subscription_missing_from_provider account=${blocker.accountId} projected_subscription=${blocker.projectedSubscriptionId}`;
    case 'legacy_checkout_session':
      return `BLOCK legacy_checkout_session session=${blocker.sessionId} prices=${blocker.legacyPriceIds.join(',')}`;
  }
}

function noticeLogLine(notice: Ws8StripePreflightNotice): string {
  return `WARN subscription_status_disagreement subscription=${notice.subscriptionId} account=${notice.accountId} provider_status=${notice.providerStatus} projected_status=${notice.projectedStatus} resolution=${notice.resolution}`;
}

/**
 * Enumerate the provider independently from the DB and return every WS8 launch
 * blocker. Passing `expireLegacySessions` removes successfully expired legacy
 * Session blockers from this run; operators still rerun dry-run before 077.
 */
export async function runWs8StripeCutoverPreflight(
  input: RunPreflightInput,
): Promise<Ws8StripePreflightResult> {
  const log = input.log ?? (() => undefined);
  const subscriptions = await paginate(
    (startingAfter) => input.stripe.listSubscriptions({
      status: 'all',
      limit: PAGE_LIMIT,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }),
    (subscription) => subscription.id,
  );

  const blockers: Ws8StripePreflightBlocker[] = [];
  const notices: Ws8StripePreflightNotice[] = [];
  for (const subscription of subscriptions) {
    const reconciliation = reconciliationFindings(subscription, input.accounts);
    blockers.push(...reconciliation.blockers);
    notices.push(...reconciliation.notices);
    if (!TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      const accountId = input.accounts.find(
        (account) => account.stripe_subscription_id === subscription.id,
      )?.id ?? null;
      blockers.push({
        kind: 'nonterminal_subscription',
        subscriptionId: subscription.id,
        status: subscription.status,
        accountId,
      });
    }
  }
  const providerSubscriptionIds = new Set(subscriptions.map((subscription) => subscription.id));
  for (const account of input.accounts) {
    if (
      account.stripe_subscription_id &&
      !providerSubscriptionIds.has(account.stripe_subscription_id)
    ) {
      blockers.push({
        kind: 'database_subscription_missing_from_provider',
        accountId: account.id,
        projectedSubscriptionId: account.stripe_subscription_id,
      });
    }
  }

  const sessions = await paginate(
    (startingAfter) => input.stripe.listOpenCheckoutSessions({
      status: 'open',
      limit: PAGE_LIMIT,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }),
    (session) => session.id,
  );

  let lineItemsScanned = 0;
  let legacySessionsExpired = 0;
  for (const session of sessions) {
    const lineItems = await paginate(
      (startingAfter) => input.stripe.listCheckoutSessionLineItems(session.id, {
        limit: PAGE_LIMIT,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      }),
      (lineItem) => lineItem.id,
    );
    lineItemsScanned += lineItems.length;
    const legacyPriceIds = [...new Set(lineItems
      .map((lineItem) => lineItemPriceId(lineItem.price))
      .filter((priceId): priceId is string => Boolean(priceId && input.legacyPriceIds.has(priceId))))]
      .sort();
    if (legacyPriceIds.length === 0) continue;

    if (input.expireLegacySessions) {
      await input.stripe.expireCheckoutSession(
        session.id,
        `ws8_expire_legacy_session_${session.id}`,
      );
      legacySessionsExpired += 1;
      log(`EXPIRED legacy_checkout_session session=${session.id} prices=${legacyPriceIds.join(',')}`);
    } else {
      blockers.push({ kind: 'legacy_checkout_session', sessionId: session.id, legacyPriceIds });
    }
  }

  log(`SCANNED subscriptions=${subscriptions.length} open_sessions=${sessions.length} line_items=${lineItemsScanned} expired_sessions=${legacySessionsExpired} status_notices=${notices.length}`);
  for (const blocker of blockers) log(blockerLogLine(blocker));
  for (const notice of notices) log(noticeLogLine(notice));
  log(blockers.length === 0 ? 'WS8_PREFLIGHT_PASS blockers=0' : `WS8_PREFLIGHT_FAIL blockers=${blockers.length}`);
  if (input.requireStatusConvergence) {
    const actionableNotices = notices.filter(
      (notice) => notice.resolution !== 'applier_noop_fixed_point',
    ).length;
    const fixedPointNotices = notices.length - actionableNotices;
    log(
      blockers.length === 0 && actionableNotices === 0
        ? `WS8_STATUS_CONVERGENCE_PASS blockers=0 actionable_notices=0 fixed_point_notices=${fixedPointNotices}`
        : `WS8_STATUS_CONVERGENCE_FAIL blockers=${blockers.length} actionable_notices=${actionableNotices} fixed_point_notices=${fixedPointNotices}`,
    );
  }

  return {
    blockers,
    notices,
    subscriptionsScanned: subscriptions.length,
    openSessionsScanned: sessions.length,
    lineItemsScanned,
    legacySessionsExpired,
  };
}

interface ConfiguredPriceId<Name extends string> {
  name: Name;
  value: string;
}

function configuredPriceIds<Name extends string>(
  names: readonly Name[],
  env: Readonly<Record<string, string | undefined>>,
): ConfiguredPriceId<Name>[] {
  return names.map((name) => ({ name, value: env[name]?.trim() ?? '' }));
}

function launchStripePriceEntries(
  env: Readonly<Record<string, string | undefined>>,
): ConfiguredPriceId<(typeof STRIPE_PRICE_ENV_VARS)[number]>[] {
  const values = configuredPriceIds(STRIPE_PRICE_ENV_VARS, env);
  const missing = values.filter(({ value }) => value.length === 0).map(({ name }) => name);
  if (missing.length > 0) {
    throw new Ws8StripePreflightConfigurationError(
      `Missing WS8 launch Stripe Price configuration: ${missing.join(', ')}`,
    );
  }
  const firstNameById = new Map<string, (typeof STRIPE_PRICE_ENV_VARS)[number]>();
  for (const { name, value } of values) {
    const firstName = firstNameById.get(value);
    if (firstName) {
      throw new Ws8StripePreflightConfigurationError(
        `WS8 launch Stripe Price IDs must be unique: ${firstName} duplicates ${name}`,
      );
    }
    firstNameById.set(value, name);
  }
  return values;
}

export function readWs8LaunchStripePriceIds(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  return new Set(launchStripePriceEntries(env).map(({ value }) => value));
}

export function readLegacyStripePriceIds(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  const values = configuredPriceIds(LEGACY_STRIPE_PRICE_ENV_VARS, env);
  const missing = values.filter(({ value }) => value.length === 0).map(({ name }) => name);
  if (missing.length > 0) {
    throw new Ws8StripePreflightConfigurationError(
      `Missing retained legacy Stripe Price configuration: ${missing.join(', ')}`,
    );
  }
  return new Set(values.map(({ value }) => value));
}

export function safeStripeErrorSummary(error: unknown): string {
  if (!error || typeof error !== 'object') return 'type=unknown';
  const candidate = error as { type?: unknown; code?: unknown; requestId?: unknown };
  const fields = [
    typeof candidate.type === 'string' ? `type=${candidate.type}` : null,
    typeof candidate.code === 'string' ? `code=${candidate.code}` : null,
    typeof candidate.requestId === 'string' ? `request_id=${candidate.requestId}` : null,
  ].filter((field): field is string => Boolean(field));
  return fields.length > 0 ? fields.join(' ') : 'type=unknown';
}

export function safeWs8StripePreflightErrorSummary(error: unknown): string {
  if (error instanceof Ws8StripePreflightConfigurationError) {
    return `type=configuration message=${error.message}`;
  }
  return safeStripeErrorSummary(error);
}

export async function loadAccountProjections(sql: Sql): Promise<AccountProjection[]> {
  return sql<AccountProjection[]>`
    SELECT id, stripe_customer_id, stripe_subscription_id, subscription_status
    FROM accounts
    WHERE stripe_customer_id IS NOT NULL
       OR stripe_subscription_id IS NOT NULL
    ORDER BY id
  `;
}

export type Ws8StripePreflightMode =
  | 'dry_run'
  | 'expire_legacy_sessions'
  | 'require_status_convergence';

const PREFLIGHT_USAGE =
  'Usage: pnpm ws8:stripe-preflight [--expire-legacy-sessions | --require-status-convergence]';

export function parseWs8StripePreflightArgs(
  args: readonly string[],
): Ws8StripePreflightMode {
  if (args.length === 0) return 'dry_run';
  if (args.length === 1 && args[0] === '--expire-legacy-sessions') {
    return 'expire_legacy_sessions';
  }
  if (args.length === 1 && args[0] === '--require-status-convergence') {
    return 'require_status_convergence';
  }
  throw new Ws8StripePreflightConfigurationError(PREFLIGHT_USAGE);
}

export function prepareWs8StripePreflightCli(
  env: Readonly<Record<string, string | undefined>>,
  args: readonly string[],
): {
  databaseUrl: string;
  launchPriceIds: ReadonlySet<string>;
  legacyPriceIds: ReadonlySet<string>;
  expireLegacySessions: boolean;
  requireStatusConvergence: boolean;
  mode: Ws8StripePreflightMode;
} {
  const mode = parseWs8StripePreflightArgs(args);
  const databaseUrl = env.DATABASE_POOL_URL?.trim();
  if (!databaseUrl) {
    throw new Ws8StripePreflightConfigurationError('DATABASE_POOL_URL is required');
  }
  const launchEntries = launchStripePriceEntries(env);
  const legacyEntries = configuredPriceIds(LEGACY_STRIPE_PRICE_ENV_VARS, env);
  const missingLegacy = legacyEntries
    .filter(({ value }) => value.length === 0)
    .map(({ name }) => name);
  if (missingLegacy.length > 0) {
    throw new Ws8StripePreflightConfigurationError(
      `Missing retained legacy Stripe Price configuration: ${missingLegacy.join(', ')}`,
    );
  }
  for (const launchEntry of launchEntries) {
    const overlappingLegacy = legacyEntries.find(
      (legacyEntry) => legacyEntry.value === launchEntry.value,
    );
    if (overlappingLegacy) {
      throw new Ws8StripePreflightConfigurationError(
        `WS8 launch and retained legacy Stripe Price IDs must be disjoint: ${launchEntry.name} overlaps ${overlappingLegacy.name}`,
      );
    }
  }
  return {
    databaseUrl,
    launchPriceIds: new Set(launchEntries.map(({ value }) => value)),
    legacyPriceIds: new Set(legacyEntries.map(({ value }) => value)),
    expireLegacySessions: mode === 'expire_legacy_sessions',
    requireStatusConvergence: mode === 'require_status_convergence',
    mode,
  };
}

export function ws8StripePreflightExitCode(
  result: Ws8StripePreflightResult | null,
  error: unknown = null,
  mode: Ws8StripePreflightMode = 'dry_run',
): 0 | 1 {
  if (error !== null || result === null) return 1;
  if (
    mode === 'require_status_convergence' &&
    result.notices.some((notice) => notice.resolution !== 'applier_noop_fixed_point')
  ) {
    return 1;
  }
  return result.blockers.length === 0 ? 0 : 1;
}

async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const {
    databaseUrl,
    legacyPriceIds,
    expireLegacySessions,
    requireStatusConvergence,
    mode,
  } = prepareWs8StripePreflightCli(process.env, args);
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { statement_timeout: 30_000 },
  });
  try {
    const accounts = await loadAccountProjections(sql);
    const stripe = getStripe();
    const result = await runWs8StripeCutoverPreflight({
      accounts,
      legacyPriceIds,
      expireLegacySessions,
      requireStatusConvergence,
      log: console.log,
      stripe: {
        listSubscriptions: async (input) => stripe.subscriptions.list(input),
        listOpenCheckoutSessions: async (input) => stripe.checkout.sessions.list(input),
        listCheckoutSessionLineItems: async (sessionId, input) =>
          stripe.checkout.sessions.listLineItems(sessionId, input),
        expireCheckoutSession: async (sessionId, idempotencyKey) => {
          await stripe.checkout.sessions.expire(sessionId, {}, { idempotencyKey });
        },
      },
    });
    return ws8StripePreflightExitCode(result, null, mode);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      console.error(`WS8 Stripe preflight ERROR ${safeWs8StripePreflightErrorSummary(error)}`);
      process.exitCode = ws8StripePreflightExitCode(null, error);
    });
}
