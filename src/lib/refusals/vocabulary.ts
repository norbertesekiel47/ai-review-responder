/**
 * The Refusal Log vocabulary — the closed set of things RepWorth chose NOT to
 * do, and the ONE place a verbatim source code is translated into one of them.
 *
 * Design of record: `docs/superpowers/plans/feat-refusal-log-plan.md` §3
 * (the two axes, the feeder table, the exhaustiveness rule, the explicit-`null`
 * list). Intake: `docs/superpowers/plans/feat-refusal-log-intake.json`.
 *
 * PURE MODULE. No DB handle, no clock read, no flag read — every input is a
 * literal already recorded elsewhere, so identical inputs give identical
 * answers and the whole file is table-testable. The one cross-tree import
 * (`worker/jobs/publisher/auto-policy-downgrade`) is `import type` and erases
 * at build time; nothing worker-side is loaded. The ONE runtime import is
 * `@/lib/approval/audit`, for the audit-action literals S3 reads — see the
 * derivation below, and deviations D12 for the bundling consequence.
 *
 * THE MODEL IS `WITHHOLD_REASONS` (`src/lib/solicitation/restraint-policy.ts:45`):
 * a closed `as const` array in precedence order with the union derived from it,
 * plus `REASON_META`'s `Record<ClosedEnum, Meta>` label shape
 * (`src/app/(authenticated)/dashboard/requests/BatchReport.tsx:29`), so a
 * drifted enum is a COMPILE error rather than a missing label at render time.
 *
 * WHAT THIS FILE CANNOT SAY. `AutoApprovalBlockReason` — 22 members at
 * `worker/jobs/response-generation/auto-approval.ts:37` — is the per-review
 * answer to "we drafted a reply and did not auto-post it, why". It reaches only
 * a `logger.log` call at `persist.ts:570-576`, and the `policy_gate` run-spine
 * step records `decision: 'held_for_owner'` with no reason. So the Refusal Log
 * reports THAT a draft was held for the owner, never WHY. Closing that needs a
 * capture change, which the intake excludes. See CONTEXT.md → **Refusal**.
 *
 * A JUDGE VERDICT IS NOT A REFUSAL. The Judge runs on already-posted replies
 * (`judge-store.ts:115` — `WHERE r.status = 'posted'`), so a verdict is a
 * post-publication observation. Counting one would be false AND would
 * double-count the autonomy suspension a flag triggers.
 */

import {
  AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT,
  type AutoPolicyAuditAction,
} from '@/lib/approval/audit';
import type { RenderWithholdReason } from '@/lib/solicitation/outreach';
import type { WithholdReason } from '@/lib/solicitation/restraint-policy';
// Cross-tree and TYPE-ONLY on purpose: the downgrade reason's single owner is
// the worker module that writes it, and re-spelling its six members here would
// fork the enum. `import type` erases, so this file stays free of worker runtime.
import type { AutoPolicyDowngradeReason } from '../../../worker/jobs/publisher/auto-policy-downgrade';
import type { AutonomySuspensionTrigger } from '@/lib/shared/worker-types';

// ---------------------------------------------------------------------------
// Axis A — the category. Closed, seven members, precedence order.
// ---------------------------------------------------------------------------

/**
 * The seven things RepWorth declines to do, in precedence order — most
 * safety-bearing first, so a surface that must pick ONE category for a mixed
 * group picks the one that matters most. Order is part of the contract: the
 * Restraint tab renders in it, and `vocabulary.test.ts` pins it.
 */
export const REFUSAL_CATEGORIES = [
  'unsafe_content', // We would not say that.
  'watchdog_unavailable', // We could not check it, so we did not post.
  'below_our_bar', // The reply was not good enough.
  'no_permission', // They did not agree to be contacted.
  'wrong_moment', // It was not the right time to ask.
  'autonomy_paused', // We are not acting on your behalf right now.
  'missing_information', // We did not have what we needed.
] as const;
export type RefusalCategory = (typeof REFUSAL_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Axis B — the source. The lane a refusal came from, and the verbatim code it
// carries within that lane.
// ---------------------------------------------------------------------------

/**
 * The six lanes the log reads, named for the act rather than the table.
 *
 * There is no `S2`: rev 1's second source was `judge_verdicts`, dropped for the
 * reason in this file's header. The plan's S-numbers are kept in the comments
 * below so the inventory table in §2 stays greppable from here.
 */
export const REFUSAL_SOURCES = [
  'held_draft', // S1 · flagged_responses  — deny-all RLS, read server-side only
  'auto_post_revoked', // S3 · approval_audit_log
  'autonomy_suspended', // S4 · account_audit_log, event_type='autonomy_suspended'
  'ask_withheld', // S5 · solicitation_asks
  'outreach_withheld', // S6 · solicitation_outreach, WITHHELD arm only
  'batch_halted', // S7 · solicitation_batches
] as const;
export type RefusalSource = (typeof REFUSAL_SOURCES)[number];

// ---------------------------------------------------------------------------
// Vocabularies with no exported TypeScript owner.
//
// The batch halt reasons and the full outreach disposition vocabulary are
// authoritative ONLY in the migration 111 CHECK constraints
// (`supabase/migrations/111_platform_halt_reason.sql`) — they are fragmented
// across partial TS unions (`RenderWithholdReason` covers three of eight
// withheld codes) and no module owns the whole list. So they are declared here
// as the closed constants they are, and `vocabulary.test.ts` PARSES 111 to
// prove they stay in step. That parse is the guard; there is deliberately no
// `satisfies` against an upstream enum, because no such enum exists and a
// self-referential one would prove nothing.
// ---------------------------------------------------------------------------

/** 111(a) `solicitation_batches_halt_consistency`, reason list, verbatim order. */
export const BATCH_HALT_REASONS = [
  'owner_veto',
  'owner_halt',
  'admin_halt',
  'send_window_elapsed',
  'batch_expired',
  'platform_halt',
] as const;
export type BatchHaltReason = (typeof BATCH_HALT_REASONS)[number];

/** 111(b) `solicitation_outreach_status_reason_consistency`, WITHHELD arm. */
export const OUTREACH_WITHHELD_REASONS = [
  'moderation_high',
  'render_failed',
  'lint_failed',
  'no_consent',
  'suppressed',
  'unsubscribed',
  'no_postal_address',
  'postal_address_mismatch',
] as const;
export type OutreachWithheldReason = (typeof OUTREACH_WITHHELD_REASONS)[number];

/**
 * The three withheld codes written by the RENDER lane (`ask-generation.ts`
 * INSERTs the row already withheld), as opposed to the five `dispatch.ts`
 * `commitWithhold` writes. Exported because the read's timestamp anchor
 * partitions on exactly this set (plan §2): `rendered_at` IS the refusal time
 * for these, and `COALESCE(run.started_at, updated_at)` for the rest. A call
 * site re-spelling the three literals forks the partition.
 */
export const RENDER_WITHHOLD_REASONS = [
  'moderation_high',
  'render_failed',
  'lint_failed',
] as const satisfies readonly RenderWithholdReason[];

// ---------------------------------------------------------------------------
// The maps. One per source vocabulary, each `satisfies Record<Enum, …>` so an
// unmapped member is a COMPILE error.
//
// `null` is the explicit decision "this is not a refusal", never an omission.
// Every `null` carries a one-line reason; a member with no line is a member
// nobody decided about.
// ---------------------------------------------------------------------------

/** S1 has no code axis. `flagged_responses.reason` is moderation prose that may
 *  never leave the server (intake invariant 4) and the row exists at all only
 *  for a `high`-severity flag (`.claude/CLAUDE.md` invariant #4), so the lane
 *  itself is the whole fact and its category is fixed rather than looked up. */
export const HELD_DRAFT_REFUSAL_CATEGORY: RefusalCategory = 'unsafe_content';

/** S3 — `AutoPolicyDowngradeReason`: an auto-post we revoked before it posted. */
export const AUTO_POST_REVOKED_REFUSAL_CATEGORIES = {
  auto_approval_disabled: 'autonomy_paused',
  notice_undelivered: 'watchdog_unavailable',
  judge_disabled: 'watchdog_unavailable',
  judge_unhealthy: 'watchdog_unavailable',
  autopilot_entitlement_lost: 'autonomy_paused',
  policy_suspended: 'autonomy_paused',
} as const satisfies Record<AutoPolicyDowngradeReason, RefusalCategory | null>;

/**
 * S3's map above is keyed by the DOWNGRADE REASON, and the database stores
 * something else: `approval_audit_log.action` holds an AUDIT ACTION, and there
 * are only FIVE of those because `DOWNGRADE_MARKERS`
 * (`worker/jobs/publisher/auto-policy-downgrade.ts`) collapses `judge_disabled`
 * and `judge_unhealthy` onto one action. The read therefore cannot look up what
 * the row actually carries without this second key space.
 *
 * The reason→action table is re-stated here from the IMPORTED action constants
 * rather than the literals (never re-spell a stored value), because
 * `DOWNGRADE_MARKERS` is module-private and a runtime import of that module
 * would pull the worker's `postgres` + outbox graph into this leaf file.
 * `vocabulary.test.ts` PARSES the marker table out of its owner and asserts this
 * copy equals it — the same guard the migration-111 and bare-union cases use
 * (deviations D8e, D12).
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
 * `satisfies Record<AutoPolicyDowngradeReason, …>` exhaustiveness guard, so a
 * seventh downgrade reason still fails the build there rather than silently
 * arriving here uncategorised, and the two cannot drift apart.
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
export const AUTO_POST_REVOKED_ACTION_CATEGORIES = deriveActionCategories(
  AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
  AUTO_POST_REVOKED_ACTION_FOR_REASON,
);

/** S4 — every `AutonomySuspensionTrigger` is the same owner-facing fact: we
 *  stopped acting on your behalf. The trigger distinguishes WHO stopped us
 *  (Judge or Governor), which is admin detail, not an owner-visible category. */
export const AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES = {
  judge_flag: 'autonomy_paused',
  governor_edit_rate: 'autonomy_paused',
  governor_veto_rate: 'autonomy_paused',
  governor_judge_signal_rate: 'autonomy_paused',
} as const satisfies Record<AutonomySuspensionTrigger, RefusalCategory | null>;

/** S5 — `WithholdReason`, the Restraint policy's closed six. */
export const ASK_WITHHELD_REFUSAL_CATEGORIES = {
  no_consent: 'no_permission',
  suppressed: 'no_permission',
  already_reviewed: 'wrong_moment',
  stale_visit: 'wrong_moment',
  over_contacted: 'wrong_moment',
  // NOT a refusal: volume shaping. `BatchReport.tsx:27` already rules it a bank,
  // not a hold — the candidate is expected back in the next batch.
  velocity_banked: null,
} as const satisfies Record<WithholdReason, RefusalCategory | null>;

/**
 * S6 — the outreach WITHHELD arm. The render half is keyed off the real
 * exported `RenderWithholdReason`, so a change there is a compile error here;
 * the dispatch half is guarded by `OUTREACH_WITHHELD_REASONS` plus the
 * migration-111 parse in `vocabulary.test.ts`.
 */
const RENDER_LANE_REFUSAL_CATEGORIES = {
  moderation_high: 'unsafe_content',
  render_failed: 'below_our_bar',
  lint_failed: 'below_our_bar',
} as const satisfies Record<RenderWithholdReason, RefusalCategory | null>;

export const OUTREACH_WITHHELD_REFUSAL_CATEGORIES = {
  ...RENDER_LANE_REFUSAL_CATEGORIES,
  no_consent: 'no_permission',
  suppressed: 'no_permission',
  unsubscribed: 'no_permission',
  no_postal_address: 'missing_information',
  postal_address_mismatch: 'missing_information',
} as const satisfies Record<OutreachWithheldReason, RefusalCategory | null>;

/** S7 — a batch WE halted. Two of six reasons are ours; the rest are not. */
export const BATCH_HALTED_REFUSAL_CATEGORIES = {
  admin_halt: 'autonomy_paused',
  platform_halt: 'autonomy_paused',
  // NOT a refusal: the owner acted. Reporting an owner's own veto back to them
  // as something RepWorth declined to do is a lie about who decided.
  owner_veto: null,
  owner_halt: null,
  // NOT a refusal: a clock ran out. Nothing was weighed and nothing was declined
  // — a deadline is an outcome, not a judgement.
  send_window_elapsed: null,
  batch_expired: null,
} as const satisfies Record<BatchHaltReason, RefusalCategory | null>;

// ---------------------------------------------------------------------------
// The outreach dispositions that are NOT refusals. Declared as a map rather
// than dropped, because the read must be able to say WHY a code it can see is
// absent from the log — and because the cancelled-arm halt copies below are the
// single easiest double-count in the feature.
// ---------------------------------------------------------------------------

/** 111(b), the CANCELLED / FAILED / UNKNOWN arms — every one maps to `null`. */
export const OUTREACH_NON_REFUSAL_REASONS = [
  // cancelled
  'owner_veto',
  'owner_halt',
  'admin_halt',
  'owner_excluded',
  'owner_withdrawn',
  'batch_expired',
  'send_window_elapsed',
  'superseded',
  'platform_halt',
  // failed
  'send_failed',
  'send_exhausted',
  // unknown
  'send_indeterminate',
] as const;
export type OutreachNonRefusalReason = (typeof OUTREACH_NON_REFUSAL_REASONS)[number];

export const OUTREACH_NON_REFUSAL_CATEGORIES = {
  // NOT a refusal: the owner acted, on the batch or on the individual ask.
  owner_veto: null,
  owner_halt: null,
  owner_excluded: null,
  owner_withdrawn: null,
  // NOT a refusal HERE, and this is the trap the eval pins. `latchHalt` writes
  // the batch's halt reason through to EVERY cancelled outreach row, so these
  // are copies of one S7 fact. S7 counts that halt once, at the batch; counting
  // the copies would report the same refusal again per recipient.
  admin_halt: null,
  platform_halt: null,
  // NOT a refusal: a clock ran out (see BATCH_HALTED_REFUSAL_CATEGORIES).
  batch_expired: null,
  send_window_elapsed: null,
  // NOT a refusal: a newer attempt replaced this row. Nothing was declined.
  superseded: null,
  // NOT a refusal: we tried and delivery failed. A refusal is a decision not to
  // act; these are acts that did not land.
  send_failed: null,
  send_exhausted: null,
  // NOT a refusal: the provider never told us what happened. Unknown is not no.
  send_indeterminate: null,
} as const satisfies Record<OutreachNonRefusalReason, RefusalCategory | null>;

// ---------------------------------------------------------------------------
// The lookup. Assert, do not default.
// ---------------------------------------------------------------------------

/**
 * A source code that is in no map is a FAULT, not a category. Thrown rather
 * than defaulted because a default silently files an unmapped refusal under a
 * plausible-looking heading, and the owner cannot tell the difference — the one
 * failure mode a closed vocabulary exists to make impossible. Carries the lane
 * and the code so the log line names what drifted.
 */
export class UnknownRefusalCodeError extends Error {
  constructor(
    readonly source: RefusalSource,
    readonly code: string | null,
  ) {
    super(`Unrecognised refusal code ${JSON.stringify(code)} for source '${source}'`);
    this.name = 'UnknownRefusalCodeError';
  }
}

type RefusalCodeMap = Readonly<Record<string, RefusalCategory | null>>;

/**
 * Every code a lane can carry, in one place. The outreach lane deliberately
 * carries BOTH arms: the read filters the non-refusals out in SQL, and a row
 * that slips through must resolve to `null` ("known, not a refusal") rather
 * than throw, so a widened query is a missing entry rather than a 500.
 */
const CODE_MAPS = {
  // BOTH key spaces for S3. The plan's feeder table (§3) names the six
  // DOWNGRADE REASONS, and `vocabulary.test.ts` reads the lookup back through
  // them; the read passes the five AUDIT ACTIONS the row actually carries. One
  // lane, one lookup, two spellings of the same six decisions — and the action
  // half is derived from the reason half, so they cannot disagree.
  auto_post_revoked: {
    ...AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
    ...AUTO_POST_REVOKED_ACTION_CATEGORIES,
  },
  autonomy_suspended: AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES,
  ask_withheld: ASK_WITHHELD_REFUSAL_CATEGORIES,
  outreach_withheld: {
    ...OUTREACH_WITHHELD_REFUSAL_CATEGORIES,
    ...OUTREACH_NON_REFUSAL_CATEGORIES,
  },
  batch_halted: BATCH_HALTED_REFUSAL_CATEGORIES,
} as const satisfies Record<Exclude<RefusalSource, 'held_draft'>, RefusalCodeMap>;

/**
 * The one translation from (lane, verbatim code) to a category.
 *
 * Returns `null` for a code the vocabulary has ruled "not a refusal" — a known
 * answer, not a missing one. Throws `UnknownRefusalCodeError` for anything else.
 * `held_draft` takes `null` as its code: S1 has no code axis, by design.
 */
export function refusalCategoryFor(
  source: RefusalSource,
  code: string | null,
): RefusalCategory | null {
  if (source === 'held_draft') {
    if (code !== null) throw new UnknownRefusalCodeError(source, code);
    return HELD_DRAFT_REFUSAL_CATEGORY;
  }
  const map: RefusalCodeMap = CODE_MAPS[source];
  if (code === null || !Object.hasOwn(map, code)) {
    throw new UnknownRefusalCodeError(source, code);
  }
  return map[code] ?? null;
}

// ---------------------------------------------------------------------------
// Owner labels and link targets.
// ---------------------------------------------------------------------------

/**
 * At most ONE destination per category, and the two kinds are not
 * interchangeable: `href` is the same page for every entry, `review` is
 * resolved per entry from the review that entry names. A `review` link is
 * therefore CONDITIONAL — an `unsafe_content` entry fed by S6
 * (`moderation_high`, an outreach withhold) names no review and renders no
 * link, which is why the kind is a marker here rather than a URL.
 */
export type RefusalLink = { kind: 'review' } | { kind: 'href'; href: string };

export interface RefusalCategoryMeta {
  /** Short owner-facing heading. Never the code. */
  label: string;
  /** One plain sentence in the owner's voice — plan §3, verbatim. */
  sentence: string;
  /** The single destination, or `null` for "this category carries no link". */
  link: RefusalLink | null;
}

/**
 * Keyed `Record<RefusalCategory, …>` on the `REASON_META` model, so adding a
 * category without a label is a compile error rather than an unlabelled row.
 * The link set is a LOCKED owner decision: links only, no writes anywhere on
 * the tab (intake non-goal).
 */
export const REFUSAL_CATEGORY_META = {
  unsafe_content: {
    label: 'Unsafe to send',
    sentence: 'We would not say that.',
    // The held draft belongs to a review; the review page is where the owner
    // decides what to do about it. Never the draft text — that stays server-side.
    link: { kind: 'review' },
  },
  watchdog_unavailable: {
    label: 'Could not be checked',
    sentence: 'We could not check it, so we did not post.',
    // No link: nothing the owner can do about a watchdog being down, and a link
    // to a settings page would imply otherwise.
    link: null,
  },
  below_our_bar: {
    label: 'Below our bar',
    sentence: 'The reply was not good enough.',
    link: null,
  },
  no_permission: {
    label: 'No permission to contact',
    sentence: 'They did not agree to be contacted.',
    link: { kind: 'href', href: '/dashboard/requests/contacts' },
  },
  wrong_moment: {
    label: 'Wrong moment',
    sentence: 'It was not the right time to ask.',
    link: null,
  },
  autonomy_paused: {
    label: 'Autonomy paused',
    sentence: 'We are not acting on your behalf right now.',
    link: { kind: 'href', href: '/settings/auto-approval' },
  },
  missing_information: {
    label: 'Missing information',
    sentence: 'We did not have what we needed.',
    link: null,
  },
} as const satisfies Record<RefusalCategory, RefusalCategoryMeta>;
