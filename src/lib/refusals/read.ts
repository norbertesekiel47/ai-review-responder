/**
 * The Refusal Log read — one tenant-scoped, owner-safe projection of the
 * refusals RepWorth ALREADY records.
 *
 * Design of record: `docs/superpowers/plans/feat-refusal-log-plan.md` §2 (the
 * six sources and their anchors) and §4 (this module's seam). Vocabulary:
 * `./vocabulary.ts` — the one place a verbatim source code becomes a
 * {@link RefusalCategory}. CONTEXT.md → **Refusal**, **Refusal category**,
 * **Refusal source**.
 *
 * THE SHAPE IS `getAgentTeamSummary`'s (`src/lib/agents/read.ts:424`): the same
 * three parameters, the same {@link DashboardReadScope} discriminant, the same
 * `dashboardWindowParams(window)` handling, the same aggregate-vs-location
 * branch. A caller who knows one owner read knows this one.
 *
 * ONE `UNION ALL`, NOT SIX QUERIES (plan review finding 24). Each source is one
 * arm projecting an IDENTICAL safe column set, so there is one final sort, one
 * window vocabulary and one place the location predicate lives. All six arms
 * are here — S1 the held draft, S3 the revoked auto-post, S4 the autonomy
 * suspension, S5 the withheld ask, S6 the withheld outreach and S7 the halted
 * batch. To add an arm: alias its root table `r`, spell
 * `r.account_id = ${scope.accountId}` in the arm itself (see
 * {@link locationFilter} for why that half is not extracted), add
 * `AND ${inLocation}` as its own conjunct unless the source is account-wide,
 * project the five columns in order, and give the arm its OWN foreign-account
 * or foreign-location test — one statement means a structural assertion over
 * the combined SQL can prove nothing about any single arm (intake invariant 1).
 *
 * THIS MODULE IS SERVER-ONLY, and `./vocabulary.ts` deliberately is not. The
 * vocabulary is a client-safe leaf whose every import is `import type`, so a
 * `'use client'` component can read `REFUSAL_CATEGORY_META` for the owner
 * labels; the audit-action key space S3 needs reaches `node:crypto` through
 * `@/lib/approval/audit`, which Next polyfills for nobody, so it lives HERE
 * instead — the read is the only thing that ever sees a stored audit action.
 * A component that wants this module's `RefusalLog` shape must take it
 * `import type`, exactly as `BatchReport.tsx` receives its `BatchView`.
 *
 * EVERY JOIN IS SCOPED ON BOTH SIDES, and the bridge is always `businesses loc`
 * pinned to the scoped account. Neither `reviews` nor `responses` carries an
 * `account_id` at all, and the two audited root tables hold INDEPENDENT foreign
 * keys rather than tenant-composite ones (migration 051:15), so a correctly
 * scoped root row can still name a review or a response belonging to somebody
 * else. Joining `loc.account_id = ${scope.accountId}` and then tying the child
 * to `loc.id` closes both halves at once — the root's business must belong to
 * the scoped account, and the child must belong to that business. The joins are
 * INNER on purpose: a child row that is gone drops the entry rather than
 * rendering a dangling link.
 *
 * ONE QUERY, ISSUED SEQUENTIALLY. Never fan this out across a `Promise`
 * combinator: postgres.js has no admission control and the #773 chokepoint
 * (`src/lib/db/admission.ts`) is what stands between a busy pool and pipelining
 * onto a busy connection. `ci:pool-fanout` does not audit this directory; the
 * reason it exists applies here regardless.
 *
 * INVARIANT #15. `sql` arrives as an explicit parameter. This module must never
 * import the db-server singleton — only the route (a composition root) does.
 * `__tests__/read.test.ts` proves it by scanning this directory for that import
 * path as a fixed string, so do not name the path here either: a mention in
 * prose reads to that scan exactly like an import.
 */

import type { PendingQuery, Row, Sql } from 'postgres';
import type { DashboardReadScope } from '@/lib/agents/read';
import {
  AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT,
  type AutoPolicyAuditAction,
} from '@/lib/approval/audit';
import { dashboardWindowParams, type DashboardWindow } from '@/lib/kpi/types';
import {
  ASK_WITHHELD_REFUSAL_CATEGORIES,
  AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES,
  AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
  BATCH_HALTED_REFUSAL_CATEGORIES,
  OUTREACH_WITHHELD_REFUSAL_CATEGORIES,
  REFUSAL_CATEGORIES,
  RENDER_WITHHOLD_REASONS,
  UnknownRefusalCodeError,
  refusalCategoryFor,
  type RefusalCategory,
  type RefusalSource,
} from './vocabulary';
import type { AutoPolicyDowngradeReason } from '../../../worker/jobs/publisher/auto-policy-downgrade';

/** One thing RepWorth declined to do, dated, with nothing owner-unsafe on it. */
export interface RefusalEntry {
  /** The source row's own id. A stable render key — never prose, never a code. */
  id: string;
  source: RefusalSource;
  category: RefusalCategory;
  /** ISO-8601. The LANE's refusal anchor, never a generic mutation stamp. */
  occurredAt: string;
  /** The review this refusal belongs to, for the lanes that name one. */
  reviewId: string | null;
}

export interface RefusalCategoryGroup {
  category: RefusalCategory;
  count: number;
  entries: RefusalEntry[];
}

/**
 * The whole owner-facing answer for one scope and one window, as ONE object:
 * the Restraint tab renders `total` and `categories` from the same value, so
 * the stated total and the breakdown cannot disagree (plan §6 T7).
 *
 * `categories` carries only the categories that actually have entries, in
 * `REFUSAL_CATEGORIES` precedence order. An empty window is `{ total: 0,
 * categories: [] }` — a fact, not an error.
 */
export interface RefusalLog {
  total: number;
  categories: RefusalCategoryGroup[];
}

/**
 * The safe column set every arm projects, in order. `source` is typed as the
 * closed union rather than `string` because the value is a constant THIS module
 * binds into the arm — the database echoes back what we sent it — while `code`
 * is genuinely read from the row and is therefore untrusted until
 * `refusalCategoryFor` rules on it.
 */
interface RefusalRow {
  entry_id: string;
  source: RefusalSource;
  code: string | null;
  occurred_at: Date | string;
  review_id: string | null;
}

/** S1 · the held draft. Checked against the closed union at compile time. */
const HELD_DRAFT_SOURCE = 'held_draft' satisfies RefusalSource;

/** S3 · `approval_audit_log`. Checked against the closed union at compile time. */
const AUTO_POST_REVOKED_SOURCE = 'auto_post_revoked' satisfies RefusalSource;

/** S4 · `account_audit_log`. Checked against the closed union at compile time. */
const AUTONOMY_SUSPENDED_SOURCE = 'autonomy_suspended' satisfies RefusalSource;

/** S5 · `solicitation_asks`. Checked against the closed union at compile time. */
const ASK_WITHHELD_SOURCE = 'ask_withheld' satisfies RefusalSource;

/** S6 · `solicitation_outreach`. Checked against the closed union at compile time. */
const OUTREACH_WITHHELD_SOURCE = 'outreach_withheld' satisfies RefusalSource;

/** S7 · `solicitation_batches`. Checked against the closed union at compile time. */
const BATCH_HALTED_SOURCE = 'batch_halted' satisfies RefusalSource;

/**
 * S4's `account_audit_log.event_type`. Spelled here because the value has no
 * TypeScript owner — `suspension.ts:311` writes the literal and
 * `worker/jobs/autonomy-suspended-notice/context.ts:127` reads it the same way.
 * A wrong spelling shows up as an empty arm, which the S4 presence case catches.
 */
const AUTONOMY_SUSPENDED_EVENT_TYPE = 'autonomy_suspended';

/**
 * The reason→action table `DOWNGRADE_MARKERS`
 * (`worker/jobs/publisher/auto-policy-downgrade.ts`) applies when it writes an
 * `approval_audit_log` row, re-stated from the IMPORTED action constants rather
 * than the literals — never re-spell a stored value. It is re-stated rather
 * than imported because `DOWNGRADE_MARKERS` is module-private and lives in
 * `worker/`, whose runtime graph pulls `postgres` and the outbox helpers;
 * `__tests__/read.test.ts` PARSES the marker table out of its owner and asserts
 * this copy equals it (deviations D8e, D11, D12a).
 *
 * It lives in the READ rather than in the vocabulary because reaching those
 * constants means importing `@/lib/approval/audit` for real, and that module
 * imports `node:crypto` — see this file's header, and `./vocabulary.ts`'s.
 */
export const AUTO_POST_REVOKED_ACTION_FOR_REASON = {
  auto_approval_disabled: AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  notice_undelivered: AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  judge_disabled: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  judge_unhealthy: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  autopilot_entitlement_lost: AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT,
  policy_suspended: AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
} as const satisfies Record<AutoPolicyDowngradeReason, AutoPolicyAuditAction>;

/**
 * Two downgrade reasons that share ONE audit action must agree on the category,
 * or the derived map would have to pick one and misfile every refusal written
 * under the other. Thrown for the same reason `UnknownRefusalCodeError` is: a
 * silent pick produces a heading the owner cannot tell from a real one.
 */
export class ConflictingRefusalActionError extends Error {
  constructor(
    readonly action: string,
    readonly reasons: readonly [string, string],
    readonly categories: readonly [RefusalCategory | null, RefusalCategory | null],
  ) {
    super(
      `Audit action '${action}' collapses reasons '${reasons[0]}' and '${reasons[1]}', `
        + `which carry different refusal categories `
        + `(${JSON.stringify(categories[0])} vs ${JSON.stringify(categories[1])})`,
    );
    this.name = 'ConflictingRefusalActionError';
  }
}

/**
 * Re-keys a reason-keyed category map onto the actions those reasons are stored
 * as. DERIVED, never a second hand-written table: the reason map keeps its
 * `satisfies Record<AutoPolicyDowngradeReason, …>` exhaustiveness guard in
 * `./vocabulary.ts`, so a seventh downgrade reason still fails the build there
 * rather than silently arriving here uncategorised, and the two cannot drift.
 */
export function deriveActionCategories<Action extends string>(
  categoriesByReason: Readonly<Record<string, RefusalCategory | null>>,
  actionByReason: Readonly<Record<string, Action>>,
): Readonly<Record<Action, RefusalCategory | null>> {
  const decided = new Map<Action, { category: RefusalCategory | null; reason: string }>();
  for (const [reason, action] of Object.entries(actionByReason)) {
    const category = categoriesByReason[reason];
    if (category === undefined) {
      throw new Error(
        `deriveActionCategories: downgrade reason '${reason}' has no refusal category`,
      );
    }
    const seen = decided.get(action);
    if (seen !== undefined && seen.category !== category) {
      throw new ConflictingRefusalActionError(
        action,
        [seen.reason, reason],
        [seen.category, category],
      );
    }
    decided.set(action, { category, reason });
  }
  return Object.fromEntries(
    [...decided].map(([action, entry]) => [action, entry.category]),
  ) as Record<Action, RefusalCategory | null>;
}

/**
 * S3 as the database actually stores it — five actions, not six reasons. Both
 * judge reasons carry `watchdog_unavailable` today, so the collapse is
 * consistent; the day it is not, the derivation throws at module load rather
 * than misfiling a refusal.
 */
export const AUTO_POST_REVOKED_ACTION_CATEGORIES: Readonly<
  Record<string, RefusalCategory | null>
> = deriveActionCategories(
  AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
  AUTO_POST_REVOKED_ACTION_FOR_REASON,
);

/**
 * Every code in a lane's map that the vocabulary rules a REFUSAL. Each arm
 * binds its own list so the SQL never has to name a code, and a `null` mapping
 * — the recorded decision "known, not a refusal" — keeps the row out of the
 * statement rather than out of the grouping.
 */
function refusalCodesOf(
  map: Readonly<Record<string, RefusalCategory | null>>,
): readonly string[] {
  return Object.entries(map)
    .filter(([, category]) => category !== null)
    .map(([code]) => code);
}

/**
 * The five `approval_audit_log.action` values that ARE a revoked auto-post,
 * derived from the action-keyed map above rather than re-spelled.
 *
 * FIVE, not six: `DOWNGRADE_MARKERS` collapses `judge_disabled` and
 * `judge_unhealthy` onto one action, so the reason-keyed map cannot be used to
 * filter this arm.
 */
const AUTO_POST_REVOKED_ACTIONS = refusalCodesOf(AUTO_POST_REVOKED_ACTION_CATEGORIES);

/**
 * S4's four `AutonomySuspensionTrigger` values. All four map to
 * `autonomy_paused` today; the list is still derived, so a trigger added with
 * an explicit `null` mapping would leave the arm rather than reach the grouping.
 */
const AUTONOMY_SUSPENDED_TRIGGERS = refusalCodesOf(AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES);

/**
 * Every S5 code the vocabulary rules a refusal. `velocity_banked` maps to
 * `null` there — volume shaping, not a hold (`BatchReport.tsx:27`) — so it is
 * absent from this list and the arm never has to name it. A seventh
 * `WithholdReason` arrives here automatically, or fails to compile in
 * `vocabulary.ts` first.
 */
const ASK_WITHHELD_CODES = refusalCodesOf(ASK_WITHHELD_REFUSAL_CATEGORIES);

/**
 * S6's eight withheld `disposition_reason` values — the WITHHELD arm of
 * migration 111's CHECK and nothing else. The cancelled arm is out of scope
 * entirely (see the arm's comment), so its codes are not in this map and cannot
 * reach this list.
 */
const OUTREACH_WITHHELD_CODES = refusalCodesOf(OUTREACH_WITHHELD_REFUSAL_CATEGORIES);

/**
 * The three withheld codes the RENDER lane writes, and therefore the exact set
 * whose refusal time is `rendered_at`. Bound from the vocabulary's exported
 * constant: a call site re-spelling the three literals forks the partition the
 * S6 anchor turns on.
 */
const RENDER_WITHHOLD_CODES: readonly string[] = RENDER_WITHHOLD_REASONS;

/**
 * S7's two halt reasons that are OURS. The four owner/expiry reasons map to
 * `null` in the vocabulary — an owner's own veto reported back as our restraint
 * would be a lie about who decided, and a deadline is an outcome rather than a
 * judgement — so they never reach this list.
 */
const BATCH_HALTED_CODES = refusalCodesOf(BATCH_HALTED_REFUSAL_CATEGORIES);

/**
 * The location half of the tenant predicate, in ONE place. Every arm aliases
 * its root table `r`, so this composes into any of them unchanged.
 *
 * The ACCOUNT half is deliberately NOT extracted here. `ci:tenant-scope`
 * (`scripts/ci/tenant-scope-audit.ts`) reads raw, UN-EVALUATED template text,
 * so a tenant predicate hidden behind a helper reads to it as a bare
 * `FROM solicitation_asks` with no scope at all — the same rule
 * `src/lib/kpi/fragments.ts` states for the Review-time anchor. Each arm
 * therefore spells `r.account_id = ` in its own template and drops this
 * fragment in beside it.
 *
 * An account-wide arm (S4, `account_audit_log`) omits this fragment on
 * purpose: a suspension applies to every location, so filtering it by one would
 * hide it from the location scope where the owner is standing.
 *
 * It composes as a WHOLE conjunct — `AND ${inLocation}`, resolving to `TRUE` in
 * aggregate scope — rather than as a trailing `AND …`. The audit substitutes
 * one placeholder per `${}` in the raw text, so a fragment dropped in DIRECTLY
 * after `r.account_id = ${…}` reads there as `r.account_id = $1 $2` and stops
 * proving anything. Keeping it a conjunct of its own leaves the account
 * predicate intact in both scope modes.
 */
function locationFilter(
  sql: Sql,
  scope: DashboardReadScope,
): PendingQuery<Row[]> {
  return scope.kind === 'location'
    ? sql`r.business_id = ${scope.businessId}`
    : sql`TRUE`;
}

/**
 * (lane, STORED code) → category, which is one translation wider than the
 * vocabulary's `refusalCategoryFor`.
 *
 * Every lane but S3 stores the code the vocabulary is keyed by, and delegates
 * unchanged. S3 stores an AUDIT ACTION where the vocabulary's key is the
 * DOWNGRADE REASON, and the two do not correspond one-to-one — `DOWNGRADE_MARKERS`
 * collapses both judge reasons onto one action — so the action key space is
 * resolved here, from the map derived above. Same rule either way: an
 * unrecognised code is a FAULT, not a category. A default would file an
 * unmapped refusal under a plausible-looking heading the owner cannot tell from
 * a real one.
 */
export function resolveRefusalCategory(
  source: RefusalSource,
  code: string | null,
): RefusalCategory | null {
  if (source !== AUTO_POST_REVOKED_SOURCE) return refusalCategoryFor(source, code);
  const category = code === null ? undefined : AUTO_POST_REVOKED_ACTION_CATEGORIES[code];
  if (category === undefined) throw new UnknownRefusalCodeError(source, code);
  return category;
}

/**
 * Buckets the already-sorted rows by category and counts them, so `total` is
 * the sum of the group counts by construction.
 *
 * A `null` category is the vocabulary's explicit "known code, not a refusal".
 * Every arm already excludes those in SQL, so a row that still arrives means a
 * widened query rather than a fault — it is dropped, not thrown on. An
 * UNRECOGNISED code is the opposite: {@link resolveRefusalCategory} throws,
 * because a default would file the refusal under a plausible-looking heading
 * the owner cannot tell from a real one.
 */
function groupEntries(rows: readonly RefusalRow[]): RefusalLog {
  const byCategory = new Map<RefusalCategory, RefusalEntry[]>();
  for (const row of rows) {
    const category = resolveRefusalCategory(row.source, row.code);
    if (category === null) continue;
    const entries = byCategory.get(category) ?? [];
    entries.push({
      id: row.entry_id,
      source: row.source,
      category,
      occurredAt: new Date(row.occurred_at).toISOString(),
      reviewId: row.review_id,
    });
    byCategory.set(category, entries);
  }

  const categories: RefusalCategoryGroup[] = REFUSAL_CATEGORIES.flatMap(
    (category) => {
      const entries = byCategory.get(category);
      return entries === undefined
        ? []
        : [{ category, count: entries.length, entries }];
    },
  );

  return {
    total: categories.reduce((sum, group) => sum + group.count, 0),
    categories,
  };
}

/**
 * Every refusal for one scope and one window, newest first.
 *
 * The window is `[now - windowDays, now]` and the START boundary is `>=`,
 * matching `getAgentTeamSummary`: an entry stamped exactly at the boundary is
 * inside the window. Both bounds are bound as parameters off ONE `now`, so
 * every arm shares the same instant.
 */
export async function getRefusalLog(
  sql: Sql,
  scope: DashboardReadScope,
  window: DashboardWindow,
): Promise<RefusalLog> {
  const { windowDays } = dashboardWindowParams(window);
  const windowEnd = new Date();
  const windowStart = new Date(
    windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000,
  );
  const inLocation = locationFilter(sql, scope);

  const rows = await sql<RefusalRow[]>`
    SELECT entry_id, source, code, occurred_at, review_id
    FROM (
      -- S1 · Held draft: flagged_responses (deny-all RLS, invariant #4), keyed
      -- account_id + business_id, anchored on created_at — the moment
      -- moderation ruled and the send_notification enqueue was skipped.
      --
      -- NO code axis and NO moderation prose: the lane itself is the whole
      -- fact, its category is the fixed HELD_DRAFT_REFUSAL_CATEGORY, and the
      -- moderation text may never leave the server (intake invariant 4). This
      -- table is read through the RLS-bypassing postgres role, so the two
      -- predicates below plus the both-sides join ARE the access control.
      SELECT
        r.id::text AS entry_id,
        ${HELD_DRAFT_SOURCE}::text AS source,
        NULL::text AS code,
        r.created_at AS occurred_at,
        rev.id AS review_id
      FROM flagged_responses r
      INNER JOIN businesses loc
              ON loc.id = r.business_id
             AND loc.account_id = ${scope.accountId}
      INNER JOIN reviews rev
              ON rev.id = r.review_id
             AND rev.business_id = loc.id
      WHERE r.account_id = ${scope.accountId}
        AND ${inLocation}
        -- Plan §3: S1 feeds unsafe_content at HIGH severity. A lower-severity
        -- admin flag is a note about a draft, not a draft we refused to send.
        AND r.severity = 'high'
        AND r.created_at >= ${windowStart}
        AND r.created_at <= ${windowEnd}

      UNION ALL

      -- S3 · Auto-post revoked: approval_audit_log, keyed account_id +
      -- business_id, anchored on created_at — the audit row IS the revocation.
      --
      -- The code axis is the stored AUDIT ACTION, not the downgrade reason, and
      -- there are five of them because DOWNGRADE_MARKERS collapses the two
      -- judge reasons onto one. One response downgraded twice yields two audit
      -- rows and therefore two entries: each is a separate act of restraint.
      SELECT
        r.id::text AS entry_id,
        ${AUTO_POST_REVOKED_SOURCE}::text AS source,
        r.action::text AS code,
        r.created_at AS occurred_at,
        resp.review_id AS review_id
      FROM approval_audit_log r
      INNER JOIN businesses loc
              ON loc.id = r.business_id
             AND loc.account_id = ${scope.accountId}
      INNER JOIN responses resp
              ON resp.id = r.response_id
             AND resp.business_id = loc.id
      WHERE r.account_id = ${scope.accountId}
        AND ${inLocation}
        AND r.action = ANY(${AUTO_POST_REVOKED_ACTIONS}::text[])
        AND r.created_at >= ${windowStart}
        AND r.created_at <= ${windowEnd}

      UNION ALL

      -- S4 · Autonomy suspended: account_audit_log, event_type
      -- 'autonomy_suspended', anchored on created_at. The code is the
      -- AutonomySuspensionTrigger inside payload (suspension.ts:309-313).
      --
      -- SOURCED HERE ON PURPOSE. unsuspendAccountAutonomy sets
      -- auto_approval_policies.suspended_at and .suspended_reason to NULL
      -- (suspension.ts:352-354), so the policy row holds no history at all; the
      -- audit row is the durable trace and a lifted suspension still appears.
      --
      -- ACCOUNT-WIDE, SO NO businesses JOIN AND NO location conjunct.
      -- account_audit_log carries a nullable location_id the suspension writer
      -- leaves NULL, and a suspended account default applies to every location
      -- — so this arm belongs in every location scope. Joining it through
      -- businesses to reach that effect would MULTIPLY one audit row by the
      -- account's location count in aggregate scope; the eval pins exactly-once
      -- in both scopes so a later "optimisation" cannot quietly add the join.
      SELECT
        r.id::text AS entry_id,
        ${AUTONOMY_SUSPENDED_SOURCE}::text AS source,
        r.payload->>'trigger' AS code,
        r.created_at AS occurred_at,
        NULL::uuid AS review_id
      FROM account_audit_log r
      WHERE r.account_id = ${scope.accountId}
        AND r.event_type = ${AUTONOMY_SUSPENDED_EVENT_TYPE}
        AND r.payload->>'trigger' = ANY(${AUTONOMY_SUSPENDED_TRIGGERS}::text[])
        AND r.created_at >= ${windowStart}
        AND r.created_at <= ${windowEnd}

      UNION ALL

      -- S5 · Ask withheld at build: solicitation_asks, the withhold arm, keyed
      -- account_id + business_id, anchored on decided_at — the moment the
      -- Restraint policy ruled, written once by the batch builder.
      SELECT
        r.id::text AS entry_id,
        ${ASK_WITHHELD_SOURCE}::text AS source,
        r.withheld_reason::text AS code,
        r.decided_at AS occurred_at,
        NULL::uuid AS review_id
      FROM solicitation_asks r
      WHERE r.account_id = ${scope.accountId}
        AND ${inLocation}
        AND r.status = 'withhold'
        AND r.withheld_reason = ANY(${ASK_WITHHELD_CODES}::text[])
        AND r.decided_at >= ${windowStart}
        AND r.decided_at <= ${windowEnd}

      UNION ALL

      -- S6 · Outreach withheld at send: solicitation_outreach, keyed account_id
      -- + business_id. THE WITHHELD ARM ONLY.
      --
      -- The cancelled arm is out of scope entirely, and that is a double-count
      -- guard rather than a simplification: latchHalt writes a batch's halt
      -- reason through to EVERY cancelled outreach row, so counting its
      -- admin_halt/platform_halt copies would report one halt again per
      -- recipient — S7 below already counts it once, at the batch.
      --
      -- THE ANCHOR IS REASON-DEPENDENT, because the withheld arm has TWO
      -- writers and neither half's anchor is correct alone (plan §2 as
      -- corrected by review round 3). ask-generation.ts INSERTs a row ALREADY
      -- withheld at render time for the three RENDER_WITHHOLD_REASONS, where
      -- rendered_at IS the refusal time (NOT NULL, never updated) and
      -- agent_run_id points at the BATCH PARENT — whose started_at is the
      -- batch's start, not this row's decision. dispatch.ts commitWithhold
      -- (1371-1379) writes the other five and sets agent_run_id to a lazy CHILD
      -- run in the same statement, and agent_runs.started_at (071:25) is
      -- DEFAULT NOW() with no updater, so that stamp is durable. updated_at is
      -- a general mutation timestamp a later write can move and survives ONLY
      -- as the fallback for a dispatch-time withhold whose best-effort child
      -- attach left agent_run_id NULL — an accepted residual drift (plan §2).
      --
      -- The anchor is computed ONCE in the LATERAL below and referenced by both
      -- the projection and the window bounds, so the value the owner sees and
      -- the value the window filters on cannot diverge.
      SELECT
        r.id::text AS entry_id,
        ${OUTREACH_WITHHELD_SOURCE}::text AS source,
        r.disposition_reason::text AS code,
        anchor.occurred_at AS occurred_at,
        NULL::uuid AS review_id
      FROM solicitation_outreach r
      INNER JOIN businesses loc
              ON loc.id = r.business_id
             AND loc.account_id = ${scope.accountId}
      -- LEFT, not INNER: agent_run_id is nullable and its absence is the
      -- updated_at fallback, not a reason to drop the refusal. Scoped on BOTH
      -- tenant keys like every other join here — migration 091's composite FK
      -- already prevents a cross-tenant match, but the every-join rule is not
      -- conditioned on a constraint happening to exist.
      LEFT JOIN agent_runs run
             ON run.id = r.agent_run_id
            AND run.account_id = ${scope.accountId}
            AND run.business_id = loc.id
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN r.disposition_reason = ANY(${RENDER_WITHHOLD_CODES}::text[])
                 THEN r.rendered_at
                 ELSE COALESCE(run.started_at, r.updated_at)
               END AS occurred_at
      ) AS anchor
      WHERE r.account_id = ${scope.accountId}
        AND ${inLocation}
        AND r.delivery_status = 'withheld'
        AND r.disposition_reason = ANY(${OUTREACH_WITHHELD_CODES}::text[])
        AND anchor.occurred_at >= ${windowStart}
        AND anchor.occurred_at <= ${windowEnd}

      UNION ALL

      -- S7 · Batch halted by us: solicitation_batches, keyed account_id +
      -- business_id, anchored on halted_at — 091's halt-consistency CHECK makes
      -- halted_at and halt_reason a two-way pairing, so the stamp is present
      -- exactly when the reason is.
      --
      -- TWO OF SIX REASONS. admin_halt and platform_halt are acts of OUR
      -- restraint; owner_veto and owner_halt are the owner's own act, and
      -- batch_expired and send_window_elapsed are clocks running out. All four
      -- map to null in the vocabulary and never reach BATCH_HALTED_CODES.
      --
      -- No businesses bridge: solicitation_batches carries a COMPOSITE FK to
      -- businesses (id, account_id) (088:129-131), so its business_id belongs
      -- to its account_id by construction, and the arm names no child table.
      SELECT
        r.id::text AS entry_id,
        ${BATCH_HALTED_SOURCE}::text AS source,
        r.halt_reason::text AS code,
        r.halted_at AS occurred_at,
        NULL::uuid AS review_id
      FROM solicitation_batches r
      WHERE r.account_id = ${scope.accountId}
        AND ${inLocation}
        AND r.halt_reason = ANY(${BATCH_HALTED_CODES}::text[])
        AND r.halted_at >= ${windowStart}
        AND r.halted_at <= ${windowEnd}
    ) AS refusal_entries
    ORDER BY occurred_at DESC, entry_id DESC
  `;

  return groupEntries(rows);
}
