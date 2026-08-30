/**
 * The Refusal ledger's vocabulary — the two closed axes every `refusal_events`
 * row is written against, plus the version literal that freezes them.
 *
 * Design of record: map #994, schema locked in #1001, table shipped by #1008 as
 * `supabase/migrations/116_refusal_events.sql`. Plan:
 * `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md` §1.
 * Terms: `CONTEXT.md` → **Refusal**, **Refusal source**, **Refusal category**,
 * **Restraint tab** (all four LOCKED).
 *
 * DELIBERATELY SHALLOW. A vocabulary is read by humans as often as it is
 * called, so an interface smaller than its content would hide the very thing
 * callers need to see. Depth is the wrong goal here. The model is
 * `WITHHOLD_REASONS` (`src/lib/solicitation/restraint-policy.ts`): a closed
 * `as const` array with the union derived from it, so a drifted member is a
 * COMPILE error rather than a surprise at run time.
 *
 * PURE MODULE, AND A CLIENT-SAFE LEAF. No DB handle, no clock read, no flag
 * read — every value below is a literal, so identical inputs give identical
 * answers and the whole file is table-testable.
 *
 * EVERY IMPORT IN THIS FILE IS `import type`, and that is a REQUIREMENT rather
 * than a coincidence. The Restraint tab (#1014) is a `'use client'` surface that
 * will need this module, and Next polyfills no `node:`-prefixed builtin — so one
 * value import whose graph reaches `node:crypto` drags it into the browser
 * bundle, silently and with no ESLint rule to catch it: invariant #1's runtime
 * ban covers `src/app/**` and `src/components/**`, not this file. `import type`
 * erases at compile time, so nothing here can reach a runtime graph at all.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT HOLD. There is no code→category map for
 * six of the seven lanes, no `refusalCategoryFor` resolver and no owner label
 * table. Each arrives with the slice that writes its lane (#1010–#1014); this
 * slice writes `autonomy_suspended` and only that, and a map with no caller is
 * dead code this repo gates on.
 */

import type { AutonomySuspensionTrigger } from '@/lib/shared/worker-types';

// ---------------------------------------------------------------------------
// Axis A — the lane. `refusal_events.refusal_source`.
// ---------------------------------------------------------------------------

/**
 * The seven lanes, named for the ACT rather than the table they were read from
 * before the ledger existed.
 *
 * MIRRORS MIGRATION 116's `refusal_source` CHECK, IN ITS ORDER, and the
 * migration is the authority — this array is the TypeScript view of it, never a
 * second one. `vocabulary.test.ts` parses 116 and compares, which is what keeps
 * the two from drifting; that parse is the guard, and it is why no member is
 * restated as a literal in a test.
 *
 * ADDING a member is MIGRATION-BEARING: the column CHECK must admit it first,
 * and C1 (the source→subject pairing) must gain an arm in the same change, or
 * the new lane is rejected at INSERT. REORDERING is presentation only (#995) —
 * nothing keys off the index. RENAMING is forbidden outright: rows already
 * carry the old spelling and there is never a backfill (#1002).
 *
 * `policy_gate_held` sits LAST because it joined the parent effort's six in
 * #1003, not because it matters least — it is in fact the highest-volume lane.
 */
export const REFUSAL_SOURCES = [
  'held_draft', // A high-severity moderation flag. No code axis at all (C4).
  'auto_post_revoked', // An auto-post we took back before it posted.
  'autonomy_suspended', // Account-wide, so no location key (C3).
  'ask_withheld', // A solicitation Ask withheld at build.
  'outreach_withheld', // An Outreach withheld at send.
  'batch_halted', // A batch WE halted — never one the owner halted.
  'policy_gate_held', // A draft an auto-approval gate held for the owner.
] as const;
export type RefusalSource = (typeof REFUSAL_SOURCES)[number];

// ---------------------------------------------------------------------------
// Axis B — the owner-facing category. `refusal_events.refusal_category`,
// FROZEN at write alongside the `vocabulary_version` that froze it.
// ---------------------------------------------------------------------------

/**
 * The eight things RepWorth declines to do, in the owner's terms.
 *
 * MIRRORS MIGRATION 116's `refusal_category` CHECK, IN ITS ORDER, on the same
 * terms as `REFUSAL_SOURCES` above: adding a member is migration-bearing,
 * reordering is presentation only (#995), renaming is forbidden. Retiring a
 * member SOFTLY — ceasing to write it while old rows keep it — needs no
 * migration at all, which is the asymmetry the CHECK is shaped around.
 *
 * The order is safety-bearing first, so a surface that must pick ONE category
 * for a mixed group picks the one that matters most. That is a rendering
 * convenience, not a contract: the Restraint tab renders in this order because
 * it reads this array, not because any stored row depends on it.
 *
 * `owner_review_required` is eighth because #998 coined it after the parked
 * branch closed on seven.
 */
export const REFUSAL_CATEGORIES = [
  'unsafe_content', // We would not say that.
  'watchdog_unavailable', // We could not check it, so we did not post.
  'below_our_bar', // The reply was not good enough.
  'no_permission', // They did not agree to be contacted.
  'wrong_moment', // It was not the right time to ask.
  'autonomy_paused', // We are not acting on your behalf right now.
  'missing_information', // We did not have what we needed.
  'owner_review_required', // We wanted you to look at it first.
] as const;
export type RefusalCategory = (typeof REFUSAL_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// The subject. `refusal_events.subject_type` — what the row points at, or
// NULL for the one lane that points at nothing.
// ---------------------------------------------------------------------------

/**
 * The four kinds of thing a Refusal can name.
 *
 * MIRRORS MIGRATION 116's `subject_type` CHECK, on the same terms as the two
 * axes above. This list is NOT the whole rule: C1 makes the LANE determine the
 * subject type totally, and C2 makes a subject whole or absent. Both live in the
 * database on purpose (#1001) — a TypeScript copy of them would be a second
 * authority over the same five facts.
 *
 * `autonomy_suspended` appears nowhere here because it takes NULL: it is an
 * account-wide fact that points at no single row, and NULL is that statement
 * rather than a missing value.
 */
export const REFUSAL_SUBJECT_TYPES = [
  'response',
  'solicitation_ask',
  'solicitation_outreach',
  'solicitation_batch',
] as const;
export type RefusalSubjectType = (typeof REFUSAL_SUBJECT_TYPES)[number];

// ---------------------------------------------------------------------------
// The version that freezes a row's category.
// ---------------------------------------------------------------------------

/**
 * Which map froze a row's **Refusal category**, written to
 * `refusal_events.vocabulary_version` on every insert.
 *
 * `<name>_<date>.<rev>`, the `RESTRAINT_POLICY_VERSION` shape
 * (`src/lib/solicitation/restraint-policy.ts`), dated the day map #994 closed.
 *
 * A FROZEN LITERAL AND NEVER DERIVED. Not a template, not a clock read, not a
 * value assembled from parts — `vocabulary.test.ts` asserts the DECLARATION as
 * text, not merely the value, because a `${today}` template would pass a value
 * assertion exactly once and then rot silently.
 *
 * Bump the serial when a code that used to map to one category starts mapping
 * to another, i.e. when a decision made under the old map is not reproducible
 * under the new one. Its ONLY purpose is that attribution: #1002 ruled there is
 * never a backfill, so this string identifies no derived row and must never move
 * on its own.
 */
export const REFUSAL_VOCABULARY_VERSION = 'refusal_vocab_2026-08-30.1';

// ---------------------------------------------------------------------------
// The one lane map this slice ships.
// ---------------------------------------------------------------------------

/**
 * `autonomy_suspended` — every `AutonomySuspensionTrigger` is the same
 * owner-facing fact: we stopped acting on your behalf.
 *
 * The trigger distinguishes WHO stopped us — the Judge or one of the Governor's
 * three rate signals — which is admin detail, not an owner-visible category. So
 * four keys, one value, deliberately.
 *
 * `satisfies Record<AutonomySuspensionTrigger, RefusalCategory>` is the guard: a
 * fifth trigger added to the union without an entry here is a COMPILE error.
 * Nothing at run time can enumerate a bare TypeScript union, so the eval's
 * matching case parses the union out of its owning module — the two halves of
 * one guard, and neither is redundant.
 *
 * No `| null` in the constraint, unlike the parked branch's version of this map.
 * Every trigger IS a refusal; there is no "known, not a refusal" arm in this
 * lane, and widening the type to admit one would invite an omission to type-check
 * as a decision.
 */
export const AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES = {
  judge_flag: 'autonomy_paused',
  governor_edit_rate: 'autonomy_paused',
  governor_veto_rate: 'autonomy_paused',
  governor_judge_signal_rate: 'autonomy_paused',
} as const satisfies Record<AutonomySuspensionTrigger, RefusalCategory>;
