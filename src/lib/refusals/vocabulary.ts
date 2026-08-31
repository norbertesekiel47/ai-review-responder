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
 * WHAT THIS FILE DELIBERATELY DOES NOT HOLD. There is no `refusalCategoryFor`
 * resolver and no owner label table — the **Restraint tab** (#1014) owns
 * presentation — and no map for the two lanes #1013 writes: `policy_gate_held`
 * carries #1003's 22-member precedence order and veto set, and `held_draft`
 * carries the fixed category #1001 declined to pin in the schema. Both arrive
 * with that slice.
 *
 * WHY THE OTHER FIVE MAPS ARRIVE TOGETHER, AHEAD OF THEIR WRITE SITES. #1009
 * said each map would land with the slice that writes its lane, and that was
 * right for one slice at a time. Slices #1010, #1011 and #1012 are INDEPENDENT
 * (#1004) and run concurrently, so under that rule all three would edit this
 * one file at once — the merge-order cost the parallel run exists to avoid.
 * Landing the five maps first makes those three surfaces disjoint. The cost was
 * stated rather than hidden: for as long as this file was ahead of them, five
 * exported constants had no production caller.
 *
 * THAT COST IS NOW PAID. #1010, #1011 and #1012 all merged 2026-08-31, so SIX of
 * the seven maps have exactly one production caller each:
 * `AUTONOMY_SUSPENDED` (#1009), `ASK_WITHHELD` / `BATCH_HALTED` /
 * `OUTREACH_WITHHELD_DISPATCH` (#1010), `OUTREACH_WITHHELD_RENDER` (#1011) and
 * `AUTO_POST_REVOKED` (#1012).
 *
 * `POLICY_GATE_HELD_REFUSAL_CATEGORIES` is the ONE that still has none — its
 * slice has not landed. Correct that sentence when it does, rather than deleting
 * this paragraph: a count is the kind of claim that goes stale silently.
 */

import type {
  AutoPolicyDowngradeReason,
  AutonomySuspensionTrigger,
} from '@/lib/shared/worker-types';
import type { OwnerHaltReason, SystemHaltReason } from '@/lib/solicitation/approval';
import type { OutreachWithheldReason } from '@/lib/solicitation/dispatch';
import type { RenderWithholdReason } from '@/lib/solicitation/outreach';
import type { WithholdReason } from '@/lib/solicitation/restraint-policy';

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
// The lane maps. One per lane vocabulary, each `satisfies Record<Enum, …>` so a
// member added upstream without a category decision is a COMPILE error.
//
// THE VALUES ARE HARVESTED VERBATIM from the parked `feat/refusal-log` branch's
// own `vocabulary.ts`. Nothing here re-decides a category; #995 froze them and
// #1002 ruled there is never a backfill, so a value changed here would silently
// disagree with every row a later map writes.
//
// `| null` APPEARS ONLY WHERE A NULL MEMBER ACTUALLY EXISTS, and BE PRECISE
// ABOUT WHAT THAT BUYS, because an earlier wording of this paragraph — and of
// `AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES` below — claimed it stops an OMISSION
// from type-checking, which is false. `satisfies Record<Enum, V>` demands every
// key whatever `V` is, so a missing key is a compile error in all six maps
// either way. What the narrower value type controls is whether `null` is
// SPELLABLE: in a lane where every code is a Refusal, `Record<Enum,
// RefusalCategory>` makes "not a Refusal" unwritable, so nobody can silence a
// lane one entry at a time. Where `null` IS admitted it means "this code is not
// a **Refusal**", never a missing entry and never a default; each one carries
// its own reason.
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
 * lane, so `null` must not be spellable here.
 *
 * (This sentence used to say that widening the type "would invite an omission to
 * type-check as a decision". That was wrong and is corrected rather than left to
 * propagate: `satisfies Record<Enum, V>` demands every key whatever `V` is, so an
 * omission is a compile error either way. The narrow value type buys the other
 * thing — it stops a future author writing `null` into a lane that has no
 * not-a-Refusal arm.)
 */
export const AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES = {
  judge_flag: 'autonomy_paused',
  governor_edit_rate: 'autonomy_paused',
  governor_veto_rate: 'autonomy_paused',
  governor_judge_signal_rate: 'autonomy_paused',
} as const satisfies Record<AutonomySuspensionTrigger, RefusalCategory>;

/**
 * `ask_withheld` — why a candidate the batch builder evaluated did not become
 * an Ask. Written by `commitAskDecisions` (#1010).
 *
 * `WithholdReason` is derived from `WITHHOLD_REASONS`, a runtime `as const`
 * array, so this lane's eval enumerates the members directly instead of parsing
 * a bare union out of its module.
 *
 * `velocity_banked` IS THE ONLY `null`, and it is the reason this map is typed
 * `| null` at all. A banked candidate is DEFERRED, not refused: the send caps
 * held it back for this build and it stays in the pool for the next one, so
 * telling the owner we declined to contact them would be false.
 */
export const ASK_WITHHELD_REFUSAL_CATEGORIES = {
  no_consent: 'no_permission',
  suppressed: 'no_permission',
  already_reviewed: 'wrong_moment',
  stale_visit: 'wrong_moment',
  over_contacted: 'wrong_moment',
  velocity_banked: null,
} as const satisfies Record<WithholdReason, RefusalCategory | null>;

/**
 * `outreach_withheld`, DISPATCH half — why the send gate refused an Outreach it
 * had already rendered. Written by `commitWithhold` (#1010).
 *
 * SEPARATE FROM THE RENDER MAP BELOW, and the two must never be merged. They
 * write the same `refusal_source`, but they are different WRITERS over
 * different closed enums (#997 counted them separately, which is where the
 * "eleven sites, not seven" figure comes from), and merging them would let a
 * dispatch-only reason type-check at a render site. The overlap is real and
 * harmless: `lint_failed` and `moderation_high` appear in both because the
 * dispatch gate re-lints and re-moderates the stored copy at send time.
 *
 * No `| null`: every one of the six is RepWorth declining to send.
 */
export const OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES = {
  suppressed: 'no_permission',
  no_consent: 'no_permission',
  no_postal_address: 'missing_information',
  postal_address_mismatch: 'missing_information',
  lint_failed: 'below_our_bar',
  moderation_high: 'unsafe_content',
} as const satisfies Record<OutreachWithheldReason, RefusalCategory>;

/**
 * `outreach_withheld`, RENDER half — why generation produced no sendable Ask.
 * Written by all four writers in `ask-generation.ts` (#1011).
 *
 * `render_failed` and `lint_failed` are both `below_our_bar`: the owner-facing
 * fact is the same — the copy was not good enough to send — and the two codes
 * stay distinct in `refusal_code` for whoever debugs the generator.
 */
export const OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES = {
  moderation_high: 'unsafe_content',
  render_failed: 'below_our_bar',
  lint_failed: 'below_our_bar',
} as const satisfies Record<RenderWithholdReason, RefusalCategory>;

/**
 * Every reason the Halt latch can write, RE-COMPOSED here rather than imported.
 *
 * `approval.ts`'s own `LatchHaltReason` is PRIVATE BY DESIGN and must stay that
 * way: it is the union that spans actor classes, so an exported signature
 * accepting it would let a request field name `admin_halt` or `owner_veto` and
 * forge an actor. `approval.test.ts` asserts the non-export in source text, and
 * an earlier draft of this file exported it and turned that test red — the
 * design held, the shortcut did not.
 *
 * So the two ACTOR-CLASS unions are imported (both are already public, and both
 * are pinned exact by that same test) and only the admin literal is re-spelled.
 * A type alias grants no one the ability to write a reason: every write still
 * goes through `approval.ts`'s own signatures, which are unchanged. The
 * eval's matching case reads `LatchHaltReason` out of `approval.ts` as text, so
 * a member added there and not here still fails.
 *
 * BE EXACT ABOUT WHICH GUARD CATCHES WHAT, because the two are not the same
 * strength. A reason added to `OwnerHaltReason` or `SystemHaltReason` — the
 * normal way a halt reason arrives — widens this alias and is a COMPILE error
 * in the map below. A reason added as a BARE LITERAL to `approval.ts`'s private
 * union widens neither import, so it compiles here and fails in the eval
 * instead. That asymmetry is the price of not exporting the wide union, and it
 * is a test failure rather than a silent pass.
 */
type BatchHaltedRefusalCode = OwnerHaltReason | 'admin_halt' | SystemHaltReason;

/**
 * `batch_halted` — why a Send batch stopped. Written by `latchHalt` (#1010).
 *
 * FOUR OF THE SIX ARE `null`, which is what makes this lane's vocabulary
 * comment true: a **Refusal** here is a batch WE halted, never one the owner
 * halted and never one that simply ran out of time.
 *
 *   * `owner_veto` and `owner_halt` — the owner stopped it. RepWorth refused
 *     nothing, and claiming otherwise on the **Restraint tab** would credit us
 *     with the owner's own decision.
 *   * `send_window_elapsed` and `batch_expired` — a deadline passed. No actor
 *     decided anything at the moment the latch fired.
 *
 * `admin_halt` and `platform_halt` are both `autonomy_paused`. Their audit
 * behaviour differs — the platform arm writes no `account_audit_log` row, so
 * the log never claims an operator acted — and that asymmetry is invisible here
 * because the ledger write is its own statement at every site (#1001).
 */
export const BATCH_HALTED_REFUSAL_CATEGORIES = {
  owner_veto: null,
  owner_halt: null,
  admin_halt: 'autonomy_paused',
  send_window_elapsed: null,
  batch_expired: null,
  platform_halt: 'autonomy_paused',
} as const satisfies Record<BatchHaltedRefusalCode, RefusalCategory | null>;

/**
 * `auto_post_revoked` — why the publisher took back an auto-approved reply
 * before it posted. Written by `downgradeAutoApprovedResponseForManualReviewInTx`
 * (#1012).
 *
 * Two categories, six codes. `notice_undelivered`, `judge_disabled` and
 * `judge_unhealthy` are `watchdog_unavailable` — we could not check the reply,
 * or could not tell the owner it was coming, so we did not post it. The other
 * three are `autonomy_paused` — we were no longer acting on the owner's behalf.
 *
 * `judge_disabled` and `judge_unhealthy` share a category AND an audit marker
 * and still stay two codes, because `refusal_code` is stored verbatim: the
 * ledger records which one held the post, even where the owner sees one
 * sentence.
 *
 * This lane and `autonomy_suspended` and `policy_gate_held` are three distinct
 * acts, not a double count (#998): this one records a post already scheduled,
 * `autonomy_suspended` records the account once, `policy_gate_held` records a
 * draft never scheduled.
 */
export const AUTO_POST_REVOKED_REFUSAL_CATEGORIES = {
  auto_approval_disabled: 'autonomy_paused',
  notice_undelivered: 'watchdog_unavailable',
  judge_disabled: 'watchdog_unavailable',
  judge_unhealthy: 'watchdog_unavailable',
  autopilot_entitlement_lost: 'autonomy_paused',
  policy_suspended: 'autonomy_paused',
} as const satisfies Record<AutoPolicyDowngradeReason, RefusalCategory>;
