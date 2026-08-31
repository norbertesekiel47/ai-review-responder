# Plan — #1013: the `held_draft` and `policy_gate_held` Refusal lanes

**Branch:** `feat/1013-refusal-policy-gate-held`
**Intake:** `docs/superpowers/plans/feat-1013-refusal-policy-gate-held-intake.json`
**Deviations:** `docs/superpowers/plans/feat-1013-refusal-policy-gate-held-deviations.md`
**Ticket:** #1013 · **Map:** #994 · **Rulings:** #995, #997, #998, #1001, #1002, #1003
**Terms (LOCKED, `CONTEXT.md` §"Refusal ledger"):** **Refusal**, **Refusal source**,
**Refusal category**, **Restraint tab**.

Slice 6 of 7 on map #994, and the last write slice. Five slices of production
evidence already sit behind `writeRefusalEvent`; this one adds no helper and
edits `src/lib/refusals/write.ts` not at all.

---

## 1. What ships

Two write sites, both inside the single `sql.begin` at
`worker/jobs/response-generation/persist.ts:111`.

| Lane | Where | Guard | Row |
|---|---|---|---|
| `held_draft` | `recordModerationAndHold`, beside the `flagged_responses` INSERT | `flaggedHigh` | `refusal_code` NULL, `all_refusal_codes` NULL, category `unsafe_content` |
| `policy_gate_held` | a new private helper, beside the existing `policy_gate` step | `!held` + genuine candidacy + a resolved winner | winner in `refusal_code`, full set in `all_refusal_codes`, category by precedence |

Both write `subject_type = 'response'`, `subject_id = responseId`, and
`occurredAt: 'transaction_time'`.

---

## 2. The three rules, as code

### Rule 1 — the write must NOT inherit the `activeRun` guard

`persist.ts:198` today reads `if (activeRun && !held)`. That guard is correct for
the **spine step** and wrong for the **ledger**. A legacy pre-spine review makes
`recordDraftSpineCheckpoints` return `null` (`persist.ts:432-453`), and
inheriting `!activeRun` would silently drop rows from the highest-volume lane —
#997 resolution 1, in those words.

**Therefore the ledger write is a SEPARATE statement with its own guard**, not an
extra `await` inside the existing `if`. T5 places it outside that block, and
title 18 is the regression test that pins it.

### Rule 2 — `null` is a veto, not a rank

Any member whose map value is `null` suppresses the whole row, whatever its
position (#1003). The check runs over the **entire** `blockReasons` array before
any precedence walk begins.

The test is `Object.hasOwn`, never truthiness (`CONTEXT.md` → **Refusal
category**). A member absent from the map is a FAULT — the resolver throws
rather than defaulting, because a default files an unmapped refusal under a
plausible-looking heading and the owner cannot tell the difference.

### Rule 3 — one draft is one Refusal

One row per decision, never one per code. A single precedence-chosen
`refusal_code`, its frozen `refusal_category`, and the full co-occurring set in
`all_refusal_codes` as non-owner-facing evidence (ADR 0023). C5 requires the
winner to be a member of the set it won, and the database enforces that half.

---

## 3. Two design decisions this plan makes

### 3.1 There is no separate `AUTO_APPROVAL_BLOCK_VETO` constant

The intake's `test_seams` named one. This plan drops it, and the drop is a
NARROWING rather than a scope change.

`POLICY_GATE_HELD_REFUSAL_CATEGORIES` is the 22-member map. A `null` value in it
**is** the veto set, exactly as `CONTEXT.md` defines the term: "`null` is the
recorded decision 'not a refusal', **never an omission**". A second
hand-maintained array of the same seven members would be a second authority over
one fact, and the two could disagree — the precise defect this map's `satisfies`
clause exists to prevent.

`AUTO_APPROVAL_BLOCK_PRECEDENCE` therefore lists only the **15** non-`null`
members, and the exhaustiveness test (title 1) asserts the partition: every map
key with a non-`null` value appears exactly once in the precedence list, every
key with `null` appears zero times, and the list contains no member outside the
map. That is "exactly once across the veto set and the precedence list" with the
veto set derived instead of restated.

### 3.2 The candidacy narrowing gets ONE owner

`logAutoApprovalFallbackIfNeeded` already spells the narrowing at
`persist.ts:563-565`. The ledger write inherits it (#998, "unchanged"). That is
the **second** use, so the anti-slop rule's "no abstraction before the second
use" is now satisfied and a shared predicate is owed:

```ts
function isGenuineAutoCandidate(
  originLane: GenerateResponseOriginLane | null,
  runtimeState: AutoApprovalRuntimeState | null,
): runtimeState is AutoApprovalRuntimeState
```

A type predicate, so the ledger site gets its non-null `runtimeState` narrowing
for free. Both callers read the same three conditions, which is what makes the
intake's `policy_gate_held` reconciliation query valid: the ledger row count can
never exceed the fallback log line count, because one predicate gates both.

**This is also the answer to the flag-off question.** With
`AUTO_APPROVAL_ENABLED` off, every draft is a structural non-candidate,
`resolveAutoApprovalDecision` returns `runtimeState: null` (`persist.ts:275-279`),
and the predicate is false. No row is written. Owner decision, 2026-08-31.

> **CORRECTION — the ticket's "Volume" section and #1003's "Operational
> consequence for #1001" are both FALSE against this code, and this branch does
> not implement them.** Both say that with the kill switch off, every generated
> draft on a policy-configured account writes an `autonomy_paused` row. The code
> cannot know "policy-configured" on that path: the flag off makes
> `auto_approval_disabled` a STRUCTURAL gate (`auto-approval.ts:286`), so
> `isAutoApprovalCandidate` is false (`persist.ts:105`), so no policy row is ever
> read. Migration 074's own header states this short-circuit is deliberate: "a
> flag-off deploy never touches the new columns." Reading the policy row for a
> non-candidate would reverse that and add a SELECT to every generated draft.
>
> `auto_approval_disabled` remains REACHABLE, and stays in the precedence list
> for that reason rather than as dead weight: `isAutoApprovalCandidate` reads the
> flag before the transaction and `evaluateAutoApprovalCandidate` reads it again
> inside (`auto-approval.ts:310`, `:360`). A flip between the two yields
> `blockReasons` carrying `auto_approval_disabled` with a real `runtimeState`.
> Title 20 pins that path.
>
> **Consequence to carry into step 8:** `AUTO_APPROVAL_ENABLED` is off in
> production, so `policy_gate_held` writes zero rows there until the go-live
> flip. Only `held_draft` is live at merge. The staging ride must run the flag ON
> or it proves half this slice.

---

## 4. The vocabulary, verbatim

Harvested from #998's member map and #1003's locked precedence. Nothing here
re-decides a category; #995 froze them and #1002 ruled there is never a backfill.

**Veto — 7 members, all `null` in the map:**
`policy_not_enabled` · `bad_origin_lane` · `unsupported_version` ·
`suppressed_notification` · `moderation_held` · `archived_location` ·
`autopilot_tier_required`

**`AUTO_APPROVAL_BLOCK_PRECEDENCE` — 15 members, most durable veto first:**

| # | Category tier | Members, in order |
|---|---|---|
| 1 | `unsafe_content` | `moderation_flagged` |
| 2 | `watchdog_unavailable` | `provider_moderation_error`, `provider_moderation_disabled`, `triage_fallback` |
| 3 | `autonomy_paused` | `policy_suspended`, `publisher_subscription_denied`, `auto_approval_disabled` |
| 4 | `missing_information` | `active_zernio_connection_missing`, `current_rating_missing`, `review_content_hash_missing` |
| 5 | `below_our_bar` | `review_content_changed_before_persist` |
| 6 | `owner_review_required` | `triage_high_severity`, `rating_below_positive_quadrant`, `rating_below_threshold`, `daily_cap_exhausted` |

7 + 15 = 22. Title 1 is the guard.

**The ordering principle is "rank by which reason still holds when every other
reason is fixed."** The case that decides it: a suspended week where 45 drafts
each carry `policy_suspended` AND `rating_below_threshold` must report "Autonomy
paused — 45", not "Sent to you — 45". Title 8 pins it.

**Order WITHIN a tier changes the stored `refusal_code` only, never the
`refusal_category`** (#1003), so it is a support-detail choice and carries no
`vocabulary_version` obligation.

### Two tests that must NOT be written

1. **#998's consistency test** — that the non-`null` members' categories appear
   in the same relative order as `REFUSAL_CATEGORIES`. #1003 ruled it out: the
   locked order disagrees on `below_our_bar` (3rd there, 5th here) and
   `missing_information` (last there, 4th here), so it fails on day one, and
   making it pass re-couples the two arrays and breaks #995.
2. **A drift test** asserting that reordering `REFUSAL_CATEGORIES` cannot change
   a resolved category. #1003 declined it as a recorded owner call, with the cost
   written down. Not reopened here.

### `REFUSAL_VOCABULARY_VERSION` does not move

`refusal_vocab_2026-08-30.1` stands. The bump rule is "a code that used to map to
one category starts mapping to another". These two lanes have written no rows, so
no decision made under the old map becomes irreproducible.

---

## 5. Tracer bullets

Six slices. Each names its blocking edges, its precedent, its files, the test
titles it turns green, and its completion evidence.

**None are mutually independent.** T1 through T5 form a chain, and T3, T4 and T5
all touch `src/lib/refusals/vocabulary.ts` or
`worker/jobs/response-generation/persist.ts`. Every task runs serially; no
parallel fan-out is planned, and the step 4 first-task spot check still applies.

---

### T1 — the eval: 36 failing tests

**Blocking edges:** none. First task.

**Files:**
`src/lib/refusals/__tests__/vocabulary.test.ts` ·
`worker/jobs/response-generation/__tests__/persist.test.ts` ·
`worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts` (new) ·
`worker/jobs/response-generation/__tests__/policy-gate-precedence.property.test.ts` (new)

**Precedent:**
`worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts`
(#1012's live-DB suite shape) ·
`src/lib/reviews/__tests__/sentiment.test.ts` (the `fast-check` `invariants`
describe block) · `src/lib/refusals/__tests__/vocabulary.test.ts` (the existing
migration-116 parse).

**Contract.** Every one of the intake's 36 `tests_to_add` titles exists VERBATIM,
with a real body. Titles 1–12 and the two `invariants:` property tests are pure
and run without a database. Titles 13–36 are live-DB and go in the new
integration suite.

**Import paths are FINAL from the first line.** The eval imports
`AutoApprovalBlockReason` from `@/lib/shared/worker-types`, which does not resolve
until T2. That is the intended red: a collection failure, for the right reason.

**Two constraints on the new integration suite:**

* It is named `*.integration.test.ts`, which selects vitest's serialized
  `integration` project.
* It executes NO run-time DDL. `assertSchemaReady` is the pattern; run-time DDL
  deadlocks (40P01) across concurrent suites, and `ci:live-db-suites` enforces it.

**No `.todo` / `.skip` / `.fails` markers anywhere.** A marked-out case satisfies
the gate's `promised-tests` row while asserting nothing — the exact defect
`src/lib/refusals/__tests__/eval-completeness.test.ts` was written to catch.

**Evidence:** all 26 titles present; `pnpm vitest run` red on every one of them
and green on every pre-existing test in the two edited files.

---

### T2 — move `AutoApprovalBlockReason` to `src/lib/shared/worker-types.ts`

**Blocking edges:** T1 (the eval already imports from the destination).

**Files:** `src/lib/shared/worker-types.ts` ·
`worker/jobs/response-generation/auto-approval.ts` ·
`worker/jobs/response-generation/__tests__/auto-approval.test.ts`

**Precedent:** `src/lib/shared/worker-types.ts:121` (`AutonomySuspensionTrigger`)
and `:150` (`AutoPolicyDowngradeReason`), with the reason stated at `:128-140`;
the importing side at `worker/jobs/publisher/auto-policy-downgrade.ts:16-24`.

**Why (deviation D2).** `vocabulary.ts` must NAME the union to type its map, and
zero production modules under `src/lib/` import from `worker/` — verified at HEAD.

**Scope.** A pure declaration move. `auto-approval.ts` keeps every behaviour and
imports the type back on the relative path its sibling uses. **No re-export
shim** — `working-rules.md` bans one without a named external consumer, and the
single test consumer repoints instead.
`src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:988`
mentions the name in a COMMENT and imports nothing, so it is untouched.

**Also in this task (deviation D3):** correct the stale clause at
`worker-types.ts:137-139` claiming `auto-policy-downgrade.ts` "re-exports this
type". It does not, and `auto-policy-downgrade.ts:16-23` says so. T2 writes a new
docblock directly beneath that paragraph and must not cite a false sentence. The
correction is bounded to that clause.

**Evidence:** `pnpm typecheck` green; `auto-approval.test.ts` green and unchanged
in behaviour; `grep -rn "AutoApprovalBlockReason" src worker` shows the
declaration in exactly one place.

---

### T3 — the `held_draft` lane

**Blocking edges:** T2.

**Files:** `src/lib/refusals/vocabulary.ts` ·
`worker/jobs/response-generation/persist.ts`

**Precedent:** `worker/jobs/publisher/auto-policy-downgrade.ts` — #1012's call
site: `writeRefusalEvent` on the deciding transaction, after the guard that
proves a decision was made, with no `try/catch`.

**Vocabulary.** Add `HELD_DRAFT_REFUSAL_CATEGORY = 'unsafe_content'`, typed
`satisfies RefusalCategory`. A single frozen literal, not a map: the lane has no
code axis at all (C4). #1001 explicitly REJECTED a schema CHECK pinning it,
because that would make a future re-map migration-bearing — the vocabulary module
owns the mapping, the database owns the closed set, two owners and one fact each.

**Write site.** Inside `recordModerationAndHold`'s existing `if (flaggedHigh)`
block, immediately after the `flagged_responses` INSERT, on the same `tx`.
`accountId`, `businessId` and `responseId` are already in that function's `args`;
no new parameter and no new read.

**Input shape:** `refusalCode: null`, `allRefusalCodes: null`,
`refusalCategory: HELD_DRAFT_REFUSAL_CATEGORY`, `subjectType: 'response'`,
`subjectId: responseId`, `occurredAt: 'transaction_time'`. The
`WithoutCode` arm of `RefusalLaneShapes` type-checks all of it.

**Why `'transaction_time'` and not `flagged_responses.created_at`.** That column
is `DEFAULT NOW()` and the row is inserted in this same transaction, so both
resolve to `transaction_timestamp()` — identical to the microsecond. Reading it
back would truncate microseconds on decode (#520) and lose the equality title 15
asserts.

**`persist.test.ts`'s fake transaction is STATEMENT-ORDER-SENSITIVE, and this
task must fix the helper, not merely add cases.** `queuePersistRows` (~line 110)
pushes fake result rows onto `txQueue` in the exact order `persist.ts` issues
statements — `input.flaggedHigh` already pushes one `[]` for the
`flagged_responses` INSERT. The new `INSERT INTO refusal_events` needs a matching
push in that same branch, or EVERY existing test using the helper consumes the
wrong row and fails.

**Turns green:** 12, 13, 15, 16, 30, 32, 34.

Titles 14 and 17 are DELIBERATELY NOT claimed here, and the distinction is the
kind a "turns green" list exists to make honest. Title 14 ("a high-severity flag
writes no `policy_gate_held` row") passes VACUOUSLY at T3 — nothing writes that
lane yet — so it proves the `!held` suppression only once T5 exists. Title 17
asserts a fact about BOTH lanes in one run. Both belong to T5.

**Evidence:** those titles green; `persist.test.ts` unchanged elsewhere.

---

### T4 — the policy-gate vocabulary and resolver

**Blocking edges:** T2.

**Files:** `src/lib/refusals/vocabulary.ts`

**Precedent:** the six existing lane maps in the same file, each
`as const satisfies Record<Enum, RefusalCategory | null>` with `| null` present
only where a `null` member exists · `STRUCTURAL_GATES`
(`auto-approval.ts:285-291`) for the readonly-tuple table idiom ·
`WITHHOLD_REASONS` (`src/lib/solicitation/restraint-policy.ts`), which
`vocabulary.ts` names as its model.

**Three exports:**

1. `POLICY_GATE_HELD_REFUSAL_CATEGORIES` — the 22-member map,
   `as const satisfies Record<AutoApprovalBlockReason, RefusalCategory | null>`.
   `| null` is present because seven `null` members genuinely exist.
2. `AUTO_APPROVAL_BLOCK_PRECEDENCE` — the ordered 15, `as const`.
3. `resolvePolicyGateRefusal(blockReasons)` → `PolicyGateRefusal | null`.

**Resolver behaviour, in order:**

1. Empty input → `null`. No decision to record.
2. Scan EVERY member once: `Object.hasOwn` miss → **throw**
   `unmapped_auto_approval_block_reason:<code>`; map value `null` → return `null`
   (the veto, whatever its position).
3. Walk `AUTO_APPROVAL_BLOCK_PRECEDENCE` in order; the first member present in
   the input wins.
4. No winner despite a non-empty, veto-free input → **throw**. Unreachable while
   the map is total and the partition holds, and asserted rather than defaulted:
   `working-rules.md` says defensive handling of a state the invariants exclude
   hides real bugs.

**The non-empty tuple.** `allRefusalCodes` is
`readonly [AutoApprovalBlockReason, ...AutoApprovalBlockReason[]]` because C5
rejects an empty array outright. Destructure `const [first, ...rest] =
blockReasons` and return `[first, ...rest]`, so the tuple type falls out of the
same check that handles the empty case. The set is `blockReasons` VERBATIM, in
its own order — the evaluation order is itself evidence for support.

**The file stays a pure, client-safe leaf.** Every import remains `import type`;
the resolver reads only module-local literals, so nothing here can reach a
runtime graph the **Restraint tab** would bundle.

**Docblock correction owed in this task.** The file currently says it holds no
`refusalCategoryFor` resolver. Scope that sentence to OWNER LABELS, which remain
#1014's, and say plainly that write-time precedence lands here. It already
promises both #1013 maps.

**Turns green:** 1–11. Title 12 is `HELD_DRAFT_REFUSAL_CATEGORY`'s literal and
belongs to T3, which adds that constant.

**Evidence:** those titles green, including both `fast-check` property tests;
`pnpm lint` and `pnpm typecheck` green.

---

### T5 — the `policy_gate_held` write site

**Blocking edges:** T3, T4.

**Files:** `worker/jobs/response-generation/persist.ts`

**Two changes.**

**(a) One owner for the candidacy narrowing.** Extract
`isGenuineAutoCandidate(originLane, runtimeState): runtimeState is
AutoApprovalRuntimeState` from `logAutoApprovalFallbackIfNeeded:561-563`. Both
that function and the new ledger helper call it. This is the second use, so the
extraction is owed rather than speculative, and it is what makes the intake's
reconciliation query true by construction.

**(b) A new private helper `recordPolicyGateRefusal(tx, args)`**, called from the
`sql.begin` body immediately after the existing `policy_gate` step block and
OUTSIDE it. Guards, in order:

1. `held` → return. Recorded on `held_draft`, never here (#998's suppression
   rule). **This is the only condition inherited from `persist.ts:198`.**
2. `autoDecision.approved` → return. Nothing was refused.
3. `!isGenuineAutoCandidate(...)` → return.
4. `resolvePolicyGateRefusal(autoDecision.blockReasons)` returns `null` → return.
   Either empty or vetoed.

Then one `writeRefusalEvent` on `tx`, no `try/catch`, per the #1012 precedent and
`write.ts`'s own contract: the ledger raises on a writer bug, and
`REFUSAL_LEDGER_ENABLED` is the lever.

**`persist.ts` is 699 lines and the `sql.begin` body is already long.** The write
goes in the private helper, never inline — `.claude/CLAUDE.md` invariant #12,
"entry points orchestrate; modules own failure behaviour".

**The same `queuePersistRows` surgery T3 does applies here**, in the
non-structural branch: one more `txQueue.push([])` for the `policy_gate_held`
INSERT, positioned exactly where the helper issues it, and only on the paths that
actually write.

**Turns green:** 14, 17, 18–29, 31, 33, 35, 36.

Together with T3's seven and T4's eleven this accounts for all 36 titles exactly
once, with no title claimed by two tracers and none unclaimed.

**Evidence:** the full integration suite green; `pnpm test` green.

---

### T6 — documentation and the corrections

**Blocking edges:** T5.

**Files:** `CONTEXT.md` · `docs/directory.md` ·
`.claude/reference/arch-review-log.md`

* **`CONTEXT.md`** — under **Refusal source**, record that all seven lanes now
  have write sites. Under **Refusal category**, record that
  `policy_gate_held`'s map and precedence live in `src/lib/refusals/vocabulary.ts`
  and that `null` is a veto rather than a rank. Correct nothing already locked.
* **`docs/directory.md`** — no new file ships, so no new row. Update the
  `src/lib/refusals/vocabulary.ts` and `worker/jobs/response-generation/persist.ts`
  rows if their descriptions no longer match. `ci:directory-map` is the guard.
* **`.claude/reference/arch-review-log.md`** — one merge-ledger row. The
  `merge-ledger` audit fails a production-file change without it, and it must be
  COMMITTED, not merely written: the audit diffs against `origin/main`.

**Deferred to step 8, not done here:** posting the correction from §3.2 as a
comment on #1013 and #1003. Both are closed issues and a comment is an external
action; it needs approval and belongs with the PR.

**Evidence:** `pnpm ci:directory-map` and `pnpm ci:merge-ledger` green in the
full gate.

---

## 6. What this slice must not do

* Edit `src/lib/refusals/write.ts`. Eleven call sites were designed for; this is
  the eleventh, and the `WithCodeSet` arm already exists for exactly this lane.
* Add a migration. Migration 116 admits both lanes today.
* Write #998's consistency test, or the declined drift test. See §4.
* Read `auto_approval_policies` for a structural non-candidate. See §3.2.
* Bump `REFUSAL_VOCABULARY_VERSION`.
* Change which drafts are held, which auto-approve, or any gate. This slice
  records the decision and alters none of it.
* Catch either ledger write at its call site.

---

## 7. Review appendix

### Round 1 — codex plan skeptic, read-only, 2026-08-31

**Session id `01a059b8-2b34-7131-b1cc-d44ba9f3847f`.** A verification round MUST
resume it (`codex exec resume -o <file> <id> "<delta>"`). Note that
`codex exec resume` accepts neither `-s` nor `-C`; it inherits the original
session's read-only sandbox and cwd.

Dispatched with a 2107-line self-contained brief (`.feature/plan-brief-1013.md`)
carrying the intake, this plan, the deviations, ten repository excerpts and the
three closed rulings verbatim. It cost 9 tool calls against feat/1008's 13–17,
and 1.25 M of its 1.62 M input tokens were cache hits.

**VERDICT: REVISE.** Ten findings, zero in the low-confidence appendix. Every one
was re-verified against source before triage; **all ten citations codex disputed
were correct and mine were wrong.**

| # | Sev | Finding | Verdict |
|---|---|---|---|
| F1 | HIGH | Flag-off lane writes nothing AND emits no signal; reconciliation is vacuous at `0 <= 0`; contradicts closed #1003 with no recorded ruling | **PARTIAL** |
| F2 | HIGH | Title 24 is impossible on one persist path — `held=true` returns before the notification, `policy_gate_held` requires `held=false` so no `flagged_responses` row exists | **ACCEPT** |
| F3 | HIGH | No live-DB veto test; pure resolver tests pass while the write site ignores a `null` result | **ACCEPT** |
| F4 | HIGH | No live-DB assertion that the STORED row carries the resolver's winner, its mapped category and verbatim array order | **ACCEPT** |
| F5 | HIGH | No severity-boundary test; `HELD_DRAFT_REFUSAL_CATEGORY` could be correct yet unused | **ACCEPT** |
| F6 | MED | Title 25 combines a moderation hold and a notification enqueue, which cannot coexist | **ACCEPT** |
| F7 | MED | Title 23 is unreachable through the public seam — a fresh response id plus unique `(review_id, version)` fails the responses INSERT before the refusal index | **ACCEPT** |
| F8 | MED | `occurred_at` pinned only for `held_draft`; the policy writer could pass a JS `Date` and all titles still pass | **ACCEPT** |
| F9 | MED | No test for the threshold-null narrowing arm, distinct from the structural non-candidate case | **ACCEPT** |
| F10 | LOW | Six citations do not resolve as claimed | **ACCEPT** |

**F1 — PARTIAL.** The narrowing decision is the owner's, taken in session, and
stands. What codex correctly identified is that it lacked a recorded authority
ruling and that the reconciliation was vacuous as written. Both are fixed:
deviation **D4** records the ruling, the rejected alternatives and the
reachability of `auto_approval_disabled` through a mid-persist flag flip; the
intake's observability now states the query is meaningful only with
`AUTO_APPROVAL_ENABLED` ON. The requested durable counter for flag-off exclusions
is **REJECTED** — `AUTO_APPROVAL_ENABLED=false` is the deliberate documented
pre-launch state, so a counter would alert continuously on the intended
configuration, and auto-approval instrumentation is not this slice's to own. Full
reasoning in D4.

**F2 is the round's best finding.** Verified at `persist.ts:228`:
`if (suppressNotification || held) return`. A held draft never reaches
`enqueueSendNotification`, so title 24's three artifacts cannot coexist. Replaced
by four path-valid titles (30–33), two of them using the existing non-DDL
`abortingExecutor` (`src/lib/shared/__tests__/helpers/abort-injection.ts`).

**F10 — my citations were wrong, codex's were right**, confirmed line by line:
`:196`→`:198` (the guard; `:196` is a comment), `:261-266`→`:275-279`,
`:561-563`→`:563-565`, `auto-approval.ts:40`→`:286` (`:40` is
`'unsupported_version'`, a union member), `:333`→`:310`,
`worker-types.ts:135-137`→`:137-139` (my range stopped before the false clause).
All corrected in §2, §3.2, T2 and T5.

> **`prevalidate-plan.py` PASSED on all fourteen of these citations, and that is
> a limitation worth recording rather than a bug.** It resolves whether a
> `path:line` EXISTS, never whether the line says what the prose claims. A
> citation audit still needs a reader.

**Net effect on the contract:** `tests_to_add` 26 → 36 (three titles removed,
thirteen added), `estimated_test_lines` 800 → 1150. Retitles are deviations-file
entries, not surface amendments, so the amendment count stays at 1.

**A verification round is owed** — the fixes moved `tests_to_add` and this plan's
heading structure, so `contract-changed` reports CHANGED by construction.
