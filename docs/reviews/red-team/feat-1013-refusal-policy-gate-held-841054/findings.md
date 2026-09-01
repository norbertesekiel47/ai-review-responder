# Red team — feat/1013 refusal policy_gate_held

**Mode:** feature (dispatched inside the step-7 review wave)
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1013-refusal-policy-gate-held`
**HEAD (pinned):** `9aa527812ebefe0c602643a92ee08c048b5a0632`
**Merge base:** `origin/main`
**Intake:** `.feature/intake.json` (risk `high`, `db_touching: true`, surface `backend`)

**Tree restored:** YES. `git status --porcelain` is empty except the pre-existing
untracked `docs/reviews/feat-1013-refusal-policy-gate-held/` (staged by the other
review-wave axes, not by me) and this report. `git rev-parse HEAD` is unchanged.
No mutation was left in place; every one was restored with a NAMED-path
`git checkout --` and the post-restore full suite is green
(120/120 unit + 24/24 integration).

---

## 0. Preconditions

| Precondition | Result |
|---|---|
| Worktree clean at a committed SHA | PASS (only the untracked review dir) |
| No process serving/watching this worktree | `mutation-runner.mjs watchers` **aborted**, reporting 4 processes. I overrode after verifying with `lsof -a -p <pid> -d cwd`: three have cwd `…/RepWorth` (the parent checkout) and one has cwd `…/RepWorth-worktrees/refactor-globals-css-extraction`. **Zero** serve this worktree. The runner's check is a `ps` command-line pattern match with no worktree scoping — a false positive. Recorded rather than silently ignored. |
| Journal closed, round open | PASS — `round-start: round 1 open, 30 mutation runs available` |
| Isolation | Explicit env exports `TEST_DATABASE_POOL_URL=postgresql://…@localhost:5499/test_1013`, `DATABASE_POOL_URL` shadowed to the same. **This matters:** `.env.local:8` holds a REAL Supabase pooler URL and `.env.local:301`'s `TEST_DATABASE_POOL_URL` points at `test_ws4`, not `test_1013`. `dotenv.config` does not override process env, so the shell exports win. Schema of `test_1013` verified at migration 116 (`refusal_events` present with all five CHECKs and `refusal_events_subject_uniq`). |
| Budget | 19 mutation runs of 30 used. No `skipped-budget` rows. |

**Baseline at HEAD (re-derived, not trusted):**

- `vocabulary.test.ts` + `policy-gate-precedence.property.test.ts` + `persist.test.ts` + `auto-approval.test.ts` → **120 passed (120)**, matching the claimed 25 + 51 + 44.
- `refusal-write.integration.test.ts` (`--project integration`) → **24 passed (24)**, each 3–14 ms against live Postgres, confirmed with `--reporter=verbose` that none was skipped.
- 36 promised titles: 10 in `vocabulary.test.ts`, 2 in the property suite, 24 in the integration suite. All present and active. Claim **confirmed**.

---

## 1. Mutation journal

Restore protocol: the tree is clean at HEAD before each mutation; the mutation is
applied by a `python3` exact-string replace with an `assert count == 1` guard;
restoration is `git checkout -- <named path>`. Every restore was verified in the
same shell invocation. Scoreboard: **22 planted, 16 killed, 6 survived**. All six
survivors were arbiter-confirmed **EQUIVALENT** on inspection and are therefore
reclassified `inconclusive (oracle)` — **zero confirmed P0**.

| # | File | Mutation | Narrow test run | Outcome |
|---|---|---|---|---|
| M1 | `persist.ts:728` | delete `if (held) return;` from `recordPolicyGateRefusal` | int. "a high-severity moderation flag writes no policy_gate_held row" | **SURVIVED** |
| M1b | `vocabulary.ts:449` | `moderation_held: null` → `'watchdog_unavailable'` | same | **SURVIVED** |
| M1c | both of the above at once | | same | **KILLED** (`expected 0, got 1`) |
| M2 | `persist.ts:217` | wrap the `recordPolicyGateRefusal` call in `if (activeRun) { … }` — the #997 resolution-1 defect | int. "a review with no spine run still writes its policy_gate_held row" | **KILLED** |
| M3 | `vocabulary.ts:577` | delete `if (categories[code] === null) return null;` — veto loses to precedence | voc. "resolvePolicyGateRefusal returns null when any veto member is present, whatever its position" | **KILLED** |
| M3b | `vocabulary.ts:577` | veto only when the null member is FIRST (`&& code === blockReasons[0]`) — veto as a rank | prop. "invariants: any block reason set containing a veto member resolves to no Refusal" | **KILLED** (fast-check counterexample) |
| M4a | `vocabulary.ts:497-498` | swap `provider_moderation_error` ↔ `provider_moderation_disabled` (WITHIN tier 2) | voc. + prop. (25) AND the full integration suite (24) | **SURVIVED** |
| M4b | `vocabulary.ts:493-509` | move `rating_below_threshold` from tier 6 to position 0 (ACROSS tiers) | voc. "AUTO_APPROVAL_BLOCK_PRECEDENCE groups its members into the six locked category tiers in order" | **KILLED** |
| M5 | `persist.ts:827` | held_draft `occurredAt: 'transaction_time'` → `new Date()` | int. "a held draft's refusal_events occurred_at equals its flagged_responses created_at" | **KILLED** |
| M5b | `persist.ts:747` | policy_gate_held `occurredAt: 'transaction_time'` → `new Date()` | int. "a policy_gate_held refusal occurred_at equals the persisted response created_at to the microsecond" | **KILLED** |
| M6 | `vocabulary.ts:604` | `allRefusalCodes: [first, ...rest].sort()` | int. "…and preserves blockReasons order verbatim" | **SURVIVED** |
| M6 (2nd oracle) | same | same | prop. "invariants: a resolved winner is always a member of its own co-occurring set" | **KILLED** |
| M7 | `vocabulary.ts:238` | `HELD_DRAFT_REFUSAL_CATEGORY` `'unsafe_content'` → `'below_our_bar'` (another VALID category) | voc. "HELD_DRAFT_REFUSAL_CATEGORY is the frozen unsafe_content literal" AND int. "a held_draft row persists unsafe_content…" | **KILLED** (both) |
| M8 | `persist.ts:729` | delete `if (autoDecision.approved) return;` | int. "an auto-approved draft writes no policy_gate_held row" | **SURVIVED** |
| M9 | `persist.ts:687` | drop `originLane === LIVE_INGEST_NEW` from `isGenuineAutoCandidate` | full integration (24) + `persist.test.ts` (51) | **SURVIVED** |
| M10 | `persist.ts:688` | drop `runtimeState.effectivePolicy.threshold !== null` from `isGenuineAutoCandidate` | int. "a structurally eligible draft with no configured policy threshold writes no policy_gate_held row", then full integration (24) + `persist.test.ts` (51) | **SURVIVED** |
| M11 | `persist.ts:730` | allow a NULL `runtimeState` through the candidacy guard | int. "a structural non-candidate draft writes no policy_gate_held row" | **KILLED** |
| M12 | `persist.ts:138` | delete the content-freshness gate's early `return` | int. "a stale-content skip writes no refusal_events row on either lane" | **KILLED** (failed on the `laneCount('held_draft')` assertion, i.e. the ledger-specific half) |
| M13 | `write.ts:369` | short-circuit the `REFUSAL_LEDGER_ENABLED` guard to never fire | int. "REFUSAL_LEDGER_ENABLED=false preserves a policy-held response…" | **KILLED** |
| M14 | `persist.ts:740` | `allRefusalCodes: refusal.allRefusalCodes` → `[refusal.refusalCode]` | int. "a policy_gate_held row carries the full co-occurring block reason set in all_refusal_codes" | **KILLED** |
| M15 | `write.ts:420-421` | delete `ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL DO NOTHING` | int. "replaying held_draft and replaying policy_gate_held…" | **KILLED** |
| M16 | `vocabulary.ts:453` | `auto_approval_disabled: 'autonomy_paused'` → `'watchdog_unavailable'` | int. "a draft whose flag flips off mid-persist writes auto_approval_disabled as autonomy_paused" | **KILLED** |
| M17 | `persist.ts:771` | `flaggedHigh = moderation.flagged && severity === 'high'` → `moderation.flagged` | int. "a non-high moderation flag writes no held_draft row…" | **KILLED** |

### Arbiter confirmation for every survivor

Per the protocol, a survivor is a P0-candidate only until inspection shows it is
semantically meaningful. All six are equivalent, and here is the reasoning
recorded verbatim.

**M1 + M1b — mutually masking, and the code comment about it is false.**
`evaluateAutoApprovalCandidate` (`auto-approval.ts:360`) emits
`when(input.held, 'moderation_held')` unconditionally, and `moderation_held` is
mapped `null` (`vocabulary.ts:449`), so the veto rule suppresses the row without
the guard. Conversely the guard suppresses it without the map. The only other
path with `held === true` is a structural non-candidate, where `runtimeState` is
null and guard 3 rejects. So each mutation alone is behaviourally inert; M1c
proves the pair is not. Not a P0 — but see finding **RT-1**, because the
docblock asserts the opposite mechanism.

**M4a — equivalent BY DESIGN.** `vocabulary.ts:489-491` states "ORDER WITHIN A
TIER changes the stored `refusal_code` only, never the `refusal_category` — so it
is a support-detail choice and carries no `vocabulary_version` obligation
(#1003)". The category is unchanged, and no test claims the within-tier order.
Survival is the CORRECT sensitivity, and M4b confirms the cross-tier order is
pinned. This is the right shape: pinned where it is a contract, free where it is
not.

**M8 — provably equivalent.** `auto-approval.ts:376` sets
`approved: blockReasons.length === 0`, and `structurallyBlockedDecision` never
approves (`:327`). `resolvePolicyGateRefusal` returns `null` for an empty list
(`vocabulary.ts:567`). So `approved ⇒ resolver returns null ⇒ no row` with or
without the guard.

**M9 — provably equivalent.** `STRUCTURAL_GATES[1]`
(`auto-approval.ts:273-276`) makes a non-`live_ingest_new` lane raise
`bad_origin_lane`, so `isAutoApprovalCandidate` is false, so
`resolveAutoApprovalDecision` short-circuits to `runtimeState: null`
(`persist.ts:296-301`), which guard 3's `runtimeState !== null` already rejects.

**M10 — provably equivalent, and this one is a finding.** With
`effectivePolicy.threshold === null`, `starMeetsThreshold` returns false
(`src/lib/auto-approval/policy.ts:117`), so `thresholdBlockReason` returns
`'policy_not_enabled'` (`auto-approval.ts:389-393`), which is mapped `null`
(`vocabulary.ts:438`) and vetoes the row. The condition can therefore never
decide anything. See **RT-2**.

---

## 2. Findings

### RT-1 (P1) — a FALSE mechanism claim, repeated in three places, behind a test that cannot fail for it

`worker/jobs/response-generation/persist.ts:699-703` ·
`src/lib/refusals/vocabulary.ts:424-428` ·
`worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts:393-396`

All three say, in near-identical words:

> Mapping `moderation_held` to `null` is not sufficient on its own:
> `moderation_flagged` fires at EVERY severity including `high`, so a held draft
> would still write an `unsafe_content` row.

That is untrue. The intake's own locked invariant is "A null-mapped member
present anywhere in `blockReasons` suppresses the whole row, whatever its
position. `null` is a veto, not a rank (#1003)", and `resolvePolicyGateRefusal`
implements exactly that (`vocabulary.ts:573-579`: one full pass returning `null`
on the first `null` value, BEFORE any ranking). Co-occurring `moderation_flagged`
is irrelevant — it never gets to compete. The map entry IS sufficient on its own,
which M1 demonstrates.

Consequence, and why this is P1 rather than P2: the `held` guard is redundant
defence-in-depth (fine to keep), but the test whose comment cites this rule as
its justification — "a high-severity moderation flag writes no policy_gate_held
row" — cannot fail when the guard is deleted, and cannot fail when the map entry
is changed. It only fails when both go. A future maintainer reading the comment
would believe the map entry is safe to widen because "the guard is what stops
it", or that the guard is safe to delete because "the map is what stops it" —
each conclusion is separately true and jointly wrong. Correct the prose to say
the two mechanisms are redundant and that the test pins their conjunction.

### RT-2 (P1) — a test that passes vacuously, and states the wrong reason in its own comment

`worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts:587-600` (the comment at `:590-593`)

The test "a structurally eligible draft with no configured policy threshold
writes no policy_gate_held row" carries the comment:

> DISTINCT from structural non-candidacy: … the narrowing fails only on
> `effectivePolicy.threshold === null`. **An incorrectly narrowed helper writes
> `policy_not_enabled` here.**

An incorrectly narrowed helper writes NOTHING here. `policy_not_enabled` is one
of the seven veto members (`vocabulary.ts:438`), so a row is impossible on this
fixture whatever `isGenuineAutoCandidate` does. M10 deletes the entire
`threshold !== null` half of the narrowing (`persist.ts:688`) and all 24
integration cases plus all 51 `persist.test.ts` cases stay green.

This is the intake invariant "The `policy_gate_held` write inherits
`logAutoApprovalFallbackIfNeeded`'s candidacy narrowing verbatim" arriving with
no covering oracle. Behavioural replacement: either assert on
`isGenuineAutoCandidate` / the fallback log directly (the narrowing IS observable
through the log, which has no veto to hide behind), or record that the narrowing
is unobservable on the ledger and keep it only as a cheap pre-filter.

### RT-3 (P1) — `docs/directory.md:892` is FALSE at HEAD, in a section this branch edited

> **Connection:** `suspendAccountAutonomy` … is the first and, at #1009, only
> caller … **Ten sites remain across #1010–#1013.**

This branch lands the last two of the eleven. Its own edit to
`docs/directory.md:889` now says "**all seven lane vocabularies**", and its edit
to `CONTEXT.md:161` says "**ALL SEVEN LANES NOW HAVE WRITE SITES** — #1013 landed
the last two". The sentence three lines below contradicts both. Verified by grep:
eight `writeRefusalEvent`/`writeRefusalEvents` call statements across seven
production modules, including `persist.ts:735` and `:818`. `ci:directory-map`
does not catch this — it validates file ROWS, not prose. CLAUDE.md's working rule
("grep the filename to clean every cross-reference in the same change") applies.

### RT-4 (P1) — REJECTED. My finding was wrong; the coordinator disproved it.

**Original claim:** `…-handoff.md:156` cites a
`findActiveReviewRun.mockResolvedValue(null)` precedent in `persist.test.ts` that
does not exist.

**Verdict: REJECTED — the claim is false, and the error was mine.**
`vi.mocked(findActiveReviewRun).mockResolvedValue(null)` exists at
`worker/jobs/response-generation/__tests__/persist.test.ts:799` at HEAD, inside
the test `'skips spine writes when no running review_handler run exists (legacy
rows)'`, and at **exactly line 768** at the merge base — precisely the line the
handoff cites. The citation was CORRECT when written.

**Root cause of my error.** My enumerating grep was
`grep -n "findActiveReviewRun" … | head -10`. There are twelve matches; `head -10`
truncated the list at line 771 and hid line 799. I then read `sed -n '755,775p'`,
saw only `ACTIVE_RUN` mocks inside that window, and asserted non-existence from a
search I had myself truncated. A negative existence claim drawn from a truncated
search is not evidence, and I published it as one. The lesson generalises: every
other negative claim in this report (the sibling searches in §3, the
unreachability proofs in RT-9/RT-10) was re-run untruncated before this revision,
and all of them hold.

What survives is much smaller and is tracked separately as **RT-14**: the
handoff's line number is stale at HEAD (`:768` → `:799`), the same
merge-base-frame class as RT-5.

### RT-14 (P2) — `handoff.md:156`'s `persist.test.ts:768` is stale at HEAD

Correct at the merge base, `:799` at HEAD (`persist.test.ts` grew 31 lines on
this branch from the three `txQueue.push` entries plus their comment). Same class
as RT-5 and as the plan/deviations merge-base-frame citations. Recorded as P2
rather than P1 because, unlike RT-6, the citation was accurate when written.

### RT-5 (P1) — three `file:line` citations SHIPPED in the branch's own test file are stale at HEAD

All three resolve exactly at the merge base and at nothing meaningful at HEAD.
`persist.ts` gained ~21 lines and `auto-approval.ts` lost ~14, so every citation
written against the pre-change tree drifted.

| Citation | Says | HEAD line | Correct HEAD line |
|---|---|---|---|
| `refusal-write.integration.test.ts:564` | "persist.ts:198's `activeRun && !held` guard" | `});` | `persist.ts:203` |
| `refusal-write.integration.test.ts:606` | "isAutoApprovalCandidate reads the flag … (auto-approval.ts:310)" | a docblock line | `auto-approval.ts:296` |
| `refusal-write.integration.test.ts:606` | "…reads it again INSIDE (`:360`)" | `when(input.held, 'moderation_held'),` | `auto-approval.ts:346` |
| `refusal-write.integration.test.ts:717` | "a held draft returns before the notification enqueue (persist.ts:228)" | `if (!runtimeState) {` | `persist.ts:249` |

Comments in `vocabulary.ts`, `worker-types.ts`, `auto-approval.ts` and
`persist.ts` itself carry NO line citations — a good discipline that the test
file breaks in three places.

### RT-6 (P1) — `handoff.md:152` cites `persist.ts:196` for the spine guard; wrong at BOTH refs

Merge base has the guard at `:198`; HEAD has it at `:203`. `:196` is a comment
line in both. (The plan's own body gets this right at `plan.md:35` and `:405`,
citing `:198`.)

### Doc-citation sweep, full result

`~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` IS present but I
hand-resolved every citation instead, because the branch's docs mix merge-base
and HEAD frames and the distinction is the finding. 41 distinct `path:line`
claims across the plan, deviations and handoff. Spot-checked 21.

- **Correct at HEAD** (7): `worker-types.ts:121`, `live-db-lock.ts:61`,
  `live-db-tenant.ts:52`, `migration-116-refusal-events.integration.test.ts:988`,
  `116_refusal_events.sql:162-171` (exact C5), `auto-policy-downgrade.ts:16-23`,
  `write.integration.test.ts:68` (off by 2 — the declaration is at `:70`).
- **Correct at the MERGE BASE, wrong at HEAD** (11): `persist.ts:105`, `:111`,
  `:198`, `:228`, `:275-279`, `:432-453`, `:563-565`;
  `auto-approval.ts:37`, `:285-291`, `:286`, `:309-311`, `:310`, `:360`;
  `worker-types.ts:135-137`/`:137-139`. Every one is exact at `origin/main`. For
  a plan this is defensible — it was written against the tree it planned to
  change — but `deviations.md:42` and `:113` say "**Verified at HEAD**" while
  citing merge-base lines, and at HEAD `auto-approval.ts:37` is a blank line
  because the union it names moved out of that file on this very branch. That
  self-contradiction is what makes it worth recording.
- **Correct at the merge base, stale at HEAD** (1): `handoff.md:156`'s
  `persist.test.ts:768` → `:799`. I first reported this as a FALSE citation; that
  was my own truncated-grep error — see RT-4 (rejected) and RT-14.

### RT-7 (P2) — the "verbatim order" assertion tests de-duplication, not order

`worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts:502`

```
// VERBATIM order — the evaluation order is itself evidence for support, and
// a writer that sorted or de-duplicated would discard it.
expect(row!.all_refusal_codes).toEqual([...new Set(row!.all_refusal_codes!)]);
```

`[...new Set(arr)]` preserves insertion order, so this compares the array to
itself with duplicates dropped. It passes for ANY ordering and it also passes if
the writer de-duplicated. M6 (sorting `allRefusalCodes` in the resolver) survives
it, while the test's own TITLE promises "…and preserves blockReasons order
verbatim". The clause is carried entirely by the property suite's
`allRefusalCodes.every((code, index) => code === codes[index])`
(`policy-gate-precedence.property.test.ts:123`). Behavioural replacement: capture
the expected `blockReasons` order and assert `toEqual` against it, or drop the
clause from the title.

(De-duplication specifically is an equivalent mutation and was not planted:
`compactBlockReasons` (`auto-approval.ts:428-433`) is itself
`[...new Set(...)]`, so the input can never carry a duplicate.)

### RT-8 (P2) — the vocabulary suite's order assertion uses an accidentally-sorted input

`src/lib/refusals/__tests__/vocabulary.test.ts:582-587`

`const input = [precedence[6], precedence[1], precedence[13]]` resolves to
`['auto_approval_disabled', 'provider_moderation_error', 'rating_below_threshold']`,
which is already in alphabetical order — so `expect(resolved!.allRefusalCodes)
.toEqual(input)` also survives M6. Two of the three order oracles on this branch
are therefore inert; only the property test discriminates. Pick indices whose
precedence order and alphabetical order disagree.

### RT-9 (P2) — one precedence member, and the whole `below_our_bar` tier, is unreachable through the write path

`src/lib/refusals/vocabulary.ts:444` (`review_content_changed_before_persist:
'below_our_bar'`) and `:507-508` (precedence tier 5).

`reviewContentHashBlockReason` (`auto-approval.ts:400-410`) returns
`review_content_changed_before_persist` exactly when
`loadedReviewContentHash !== null && currentReviewContentHash !== null &&
loaded !== current`. That predicate is bit-for-bit `hasStaleReviewContent`
(`persist.ts:84-91`), and the content-freshness gate at `persist.ts:130-139`
returns `{ kind: 'skipped_stale_content' }` with **zero writes** before the
responses INSERT. `evaluateAutoApprovalCandidate` has exactly ONE production
caller (`persist.ts:317`), downstream of that gate. Both hash reads
(`acquirePersistLocks`'s and `loadAutoApprovalRuntimeState`'s at
`auto-approval.ts:153` and `:241`) hit the same column of the same row under the same
`FOR UPDATE` in the same transaction, so they cannot disagree.

Therefore the sole member of precedence tier 5 can never be recorded on this
lane, and `below_our_bar` will never appear on the Restraint tab (#1014) from
`policy_gate_held`. Not a defect — the map entry is harmless and the pure
resolver tests exercise it — but the intake's framing implies the tier is live,
the tier-order test asserts all six tiers as peers, and #1014 may build UI for a
bucket that stays permanently empty. Worth a sentence in the doc.

### RT-10 (P2) — three more members are inert at the resolver

`bad_origin_lane`, `unsupported_version` and `suppressed_notification`
(`vocabulary.ts:440-442`) fire only as STRUCTURAL gates
(`auto-approval.ts:271-279`), and a structural block forces `runtimeState: null`
(`persist.ts:296-301`), which the ledger's guard 3 rejects before the resolver is
called. Their `null` mapping is therefore inert in production. Combined with
RT-9: of the 22 members, **4 can never reach `resolvePolicyGateRefusal` on a live
path**, and of the remaining 18, `auto_approval_disabled` reaches it only through
the mid-persist flag flip that D4 correctly identifies and title 26 pins
(M16 confirms that test discriminates). Recorded because the intake, the tests
and `worker-types.ts:186-191` all treat the 22 as uniformly live.

### RT-11 (P2) — "FOUR GUARDS, IN THIS ORDER, and each answers a different question" is two-thirds true

`worker/jobs/response-generation/persist.ts:694-712`

Guards 1 (`held`), 2 (`approved`) and the `originLane`/`threshold` halves of
guard 3 are each provably unable to change the outcome (M1, M8, M9, M10). Only
`runtimeState !== null` and guard 4 (the resolver's answer) decide anything —
M11 and M3/M3b kill those. Keeping redundant guards is defensible; asserting that
each answers a different question is not. Same class as RT-1.

### RT-12 (P2) — "six maps" is now seven, in a line this branch ADDED

`src/lib/refusals/vocabulary.ts:226` (added by this branch): "the same one the
six maps get from their `Record` constraint". `:208` (same header block): "a
compile error in all six maps either way". `docs/directory.md:889` (rewritten by
this branch): "four of the six omit it". There are now **seven**
`satisfies Record<…>` maps in the file (`:270, :292, :315, :329, :383, :412,
:460`), because `POLICY_GATE_HELD_REFUSAL_CATEGORIES` is the seventh. Four still
omit `| null`; three carry it. The "four" is right, the "six" is not.

### RT-13 (P2) — "the highest-volume lane", unqualified, beside "silent in production today"

`CONTEXT.md:161` · `src/lib/refusals/vocabulary.ts:98` and `:416` ·
`worker/jobs/response-generation/persist.ts:215` · `.feature/intake.json`
`risk_reasons[2]`.

The CONTEXT.md bullet says `policy_gate_held` "is the highest-volume of all" and,
two sentences later, that it "is silent whenever `AUTO_APPROVAL_ENABLED` is off,
which is production today". Both are true of different epochs; neither carries a
"once the flag is on" qualifier at the point of the volume claim. The second
sentence effectively repairs the first inside CONTEXT.md, but `vocabulary.ts:98` and `:416`
("the highest-volume lane") and `persist.ts:215` ("silently drop rows from the
highest-volume lane") repeat it with no qualifier at all. Cosmetic; recorded
because D4 is the branch's headline correction and this is the one place the
prose still reads the old way.

---

## 3. Duty 4 — missed sibling cases

Every search recorded, with its scope and exclusions. **Zero missed siblings
found**, and the searches were sound.

| Pattern | Scope | Exclusions | Result |
|---|---|---|---|
| `INSERT INTO flagged_responses` | `src/` + `worker/`, `*.ts` | `__tests__` | **Exactly one** production site, `persist.ts:794` — the one that got the `held_draft` write. No high-severity hold anywhere else can be missing a Refusal. |
| `writeRefusalEvent\b` / `writeRefusalEvents\b` | `src/` + `worker/`, `*.ts` | `__tests__`, `src/lib/refusals/write.ts` itself | 8 call statements across 7 modules: `ask-generation.ts:698`, `approval.ts:637`, `dispatch.ts:1474`, `batch-builder.ts:670`, `suspension.ts:331`, `auto-policy-downgrade.ts:208`, `persist.ts:735` and `:818`. All seven lanes now have a writer. |
| callers of `evaluateAutoApprovalCandidate` | `src/` + `worker/`, `*.ts` | `__tests__`, comment mentions | **Exactly one**: `persist.ts:317`. This single-caller fact is the basis of the RT-9 unreachability proof. |
| callers of `isGenuineAutoCandidate` | `persist.ts` | — | **Exactly two**: `:578` (the fallback log) and `:730` (the ledger). The intake's "ONE OWNER FOR THE NARROWING" holds literally, which is what makes the reconciliation query's `≤` relation structurally true. |
| `AutoApprovalBlockReason` importers | repo-wide | — | Two: `auto-approval.ts:25` (imports it back) and `auto-approval.test.ts:24`. No re-export, matching D2 and `working-rules.md`. |
| 22-member reachability through the write path | analytical, per member | — | 18 reachable, 4 not — see P2-3 / P2-4. |

---

## 4. Duty 5 — operational completeness

**Scope:** operator-actionable TERMINAL or SWALLOWED failure paths the diff adds.

The diff adds **no new** terminal or swallowed path. Both ledger writes are
deliberately uncaught (`persist.ts:711-712` and `:801-803` — no `try/catch` at either site), so a migration-116
CHECK violation aborts the persist transaction, the BullMQ job fails, and the
terminal attempt raises a real Sentry issue through the pre-existing
`attachJobFailureSink` (`worker/job-failure-sink.ts`) — the intake's
`observability[1]` says exactly this and it is true.

The one swallowed path in reach, `warnLedgerDisabled`
(`src/lib/refusals/write.ts:291-310`), landed with #1009 and already has its rule
row. Comparing all six facets:

| Facet | Runbook (`docs/runbooks/beta-launch-alerting.md:54-67`) | Emitted | Match |
|---|---|---|---|
| Signal identity | issues tagged `subsystem:refusal_ledger` | `tags: { subsystem: 'refusal_ledger', flag: REFUSAL_LEDGER_FLAG }` | ✅ |
| Filter | that tag | same | ✅ |
| Level | `warning` | `level: 'warning'` | ✅ |
| Grouping | per the shared `warnLedgerDisabled()` | one helper, one message | ✅ |
| Threshold / cadence | "once per disabled episode" | latch + `WARN_RETRY_COOLDOWN_MS` (300 s), latch clears on the next enabled observation | ✅ |
| Destination | routed to Discord | — | ✅ |

**The D4 question specifically — is anything in the branch's own docs or
observability inconsistent with "the `policy_gate_held` lane writes NOTHING while
`AUTO_APPROVAL_ENABLED` is off"?** No. Three independent places state it
correctly and none contradicts it:

- `CONTEXT.md:161` — "`policy_gate_held` is silent whenever `AUTO_APPROVAL_ENABLED`
  is off, which is production today … a count of zero on that lane means the
  flag, not an absence of decisions."
- `.feature/intake.json` `observability[2..5]` — the reconciliation query is
  declared meaningful ONLY with the flag on, both sides zero by construction
  otherwise, and "never cite a green reconciliation from a flag-off window as
  evidence".
- `rollback_plan` — "AUTO_APPROVAL_ENABLED is off in production, so the
  `policy_gate_held` lane writes nothing there until the go-live flip".

D4's rejection of a flag-off exclusion counter is sound: the flag being off is
the intended pre-launch state per design-doc §8.4's ordered go-live, so a counter
would alert continuously on the correct configuration, and the fact that the
LEDGER is dark is a different fact already covered by `REFUSAL_LEDGER_ENABLED`'s
own warning. I verified the mechanism D4 rests on rather than taking its word:
`STRUCTURAL_GATES[0]` at HEAD is `auto-approval.ts:272`,
`[(input) => !input.runtimeEnabled, 'auto_approval_disabled']` (the deviation
cites `:286`, which is the MERGE-BASE line — see RT-5's class); with the flag off
`isAutoApprovalCandidate` (`:309` at HEAD) collapses to false,
`resolveAutoApprovalDecision` returns `runtimeState: null`
(`persist.ts:296-301`), and guard 3 rejects. Confirmed, and title 24
(`M11`) is a real oracle for it.

The only residue is RT-13's unqualified "highest-volume lane" prose.

---

## 5. Inventory

Every candidate, executed or not. No `skipped-budget` rows.

**Direction A — changed test surface** (36 promised titles + the `persist.test.ts`
queue-accounting change + the `auto-approval.test.ts` import repoint): all 60
changed/added cases ran green at HEAD as the baseline. 19 of them additionally
served as a mutation oracle (table in §1). The `persist.test.ts` diff adds NO new
case — it adds three `txQueue.push` entries to keep the statement-order mock in
step with two extra tagged-template calls. That is correct (verified: `mockTx`
shifts on the `tx`NOW()`` fragment `occurredAtFragment` builds, which real
Postgres.js never executes) but it means **no unit-level oracle exists for either
write site** — the whole ledger surface is proved only by the live-DB suite.
Recorded, not a finding: the suite is in the `test` job's live-DB lane, which is
a required check.

**Direction B — changed production surface**, reverse-import search, every
behaviour-affecting hunk:

| Hunk | Covering test found | Outcome |
|---|---|---|
| `persist.ts` `recordPolicyGateRefusal` guards 1-4 | int. titles 14, 24, 25, 30, 33-36 | killed via M2, M11 / equivalent via M1, M8, M10 |
| `persist.ts` `isGenuineAutoCandidate` | int. titles 24, 25 | equivalent via M9, M10 — **RT-2** |
| `persist.ts` held_draft write site | int. titles 13, 15, 16, 17, 30, 32, 34 | killed via M5, M7, M12, M13, M17 |
| `persist.ts` policy_gate_held write site | int. titles 18-23, 26-29, 31, 33, 35, 36 | killed via M5b, M14, M16 |
| `vocabulary.ts` `resolvePolicyGateRefusal` | voc. titles 3-7, prop. 10-11 | killed via M3, M3b, M6 |
| `vocabulary.ts` `POLICY_GATE_HELD_REFUSAL_CATEGORIES` | voc. titles 1, 2, int. 17, 26 | killed via M4b, M16 / equivalent via M1b, M4a |
| `vocabulary.ts` `AUTO_APPROVAL_BLOCK_PRECEDENCE` | voc. titles 2, 4, 8 | killed via M4b / equivalent (by design) via M4a |
| `vocabulary.ts` `HELD_DRAFT_REFUSAL_CATEGORY` | voc. title 12, int. title 16 | killed via M7 |
| `worker-types.ts` `AutoApprovalBlockReason` declaration | voc. title 1 (parses the union as TEXT out of `worker-types.ts`) | covered — the parse asserts 22 members and the partition |
| `auto-approval.ts` (union removed, imported back) | `auto-approval.test.ts` (44) | type-level only; `pnpm typecheck` is the oracle |

No production hunk is uncovered. No test was deleted. `supabase/migrations/` is
untouched by this branch. No Playwright/E2E spec is in scope.

---

## 6. Status — computed the checker's way

`recomputeStatus` in `.agents/skills/feature/scripts/red-team-status.mjs:194-209`
derives status from the rows and dispositions alone, in this precedence:
`OPEN_P0` → `INCOMPLETE_INFRA` → `INCOMPLETE_ORACLE` → `INCOMPLETE_BUDGET` →
`OPEN_P1` → `CLEAR`.

| Count (recomputed, not asserted) | Value |
|---|---|
| `inventory_total` | 22 |
| `killed` | 16 |
| `survived_confirmed_p0` | **0** |
| `inconclusive` | 6 (all `inconclusive_class: "oracle"`) |
| `skipped_budget` | 0 |
| `excluded` | 0 |
| `findings_total` | 14 |
| `p0_open` | 0 |
| `p1_open` | 5 |
| `p2_open` | 8 |
| `accepted_risk` | 0 |
| `fixed` | 0 |
| `rejected` | 1 |

**status = `INCOMPLETE_ORACLE`.** `p0_open` is 0, no row is
`inconclusive_class: "infra"`, and the six equivalent-mutant rows are
`inconclusive` / `oracle` — which the third precedence step catches before
`OPEN_P1` is ever reached. So `INCOMPLETE_ORACLE` is the status even though five
P1s are open; the P1s would only surface as `OPEN_P1` once every inconclusive row
is resolved.

**This blocks the `reviewed` transition, and that is correct rather than a
formatting problem.** `red-team-status.mjs:630-632` fails on any non-`CLEAR`
status. The honest reading: six of my twenty-two mutations produced no verdict
because the mutant was semantically equivalent to the original, so those six
production conditions have no oracle at all. To reach `CLEAR` someone must either
add an oracle that makes each condition falsifiable (RT-2 is the one that
genuinely wants this) or record, per row, that the condition is deliberately
unfalsifiable defence-in-depth. I did not manufacture a `killed` row to make the
gate green.

**One schema note.** The dispatch listed thirteen top-level keys "exactly these
and no others". The checker's `TOP_LEVEL_KEYS`
(`red-team-status.mjs:56-73`) has **sixteen** — it also requires `schema` (must
equal `1`), `mode` (`feature`), and `run_id` (must equal the derived
`feature-<slug>`), and `validateShape` errors on a missing required field as well
as on an unknown one. The checker wins, so the sidecar carries all sixteen.

Nothing here disproves that the code is CORRECT. What it disproves is that the
test surface pins everything the branch's prose says it pins: two of the four
guards on the new helper and both halves of its narrowing are unfalsifiable
against the current suite, one order oracle is a no-op, three `file:line` claims
shipped in the branch's own test file do not resolve at HEAD, and one prose claim
in `docs/directory.md` is false at HEAD. And one of my own findings was false —
see RT-4.

## 7. Restoration attestation

```
$ git status --porcelain
?? docs/reviews/feat-1013-refusal-policy-gate-held/     # pre-existing, not mine

$ git rev-parse HEAD
9aa527812ebefe0c602643a92ee08c048b5a0632

$ node .agents/skills/red-team/scripts/mutation-runner.mjs finalize
reap: every journaled process group is empty (0 recorded)
finalize: restored 0 mutated file(s) and 0 dotenv file(s); journal closed
```

Post-restore re-run: 120/120 unit, 24/24 integration. No dotenv file was ever
swapped (explicit shell exports were used instead, and `dotenv.config` does not
override process env). No mutation is outstanding. Files touched during the run
and restored: `worker/jobs/response-generation/persist.ts`,
`src/lib/refusals/vocabulary.ts`, `src/lib/refusals/write.ts`.

---

## 8. Checker output, and what each line means

Run from the worktree root at the time of writing, verbatim:

```
$ node .agents/skills/feature/scripts/red-team-status.mjs
red-team-status: FAILED (7 issue(s))
  - red-team status is INCOMPLETE_ORACLE — every non-CLEAR status blocks the transition
  - finding RT-1: a high-risk run cannot ship an open P1 — fix it, or record user authorization and set disposition accepted-risk
  - finding RT-2: a high-risk run cannot ship an open P1 — fix it, or record user authorization and set disposition accepted-risk
  - finding RT-3: a high-risk run cannot ship an open P1 — fix it, or record user authorization and set disposition accepted-risk
  - finding RT-5: a high-risk run cannot ship an open P1 — fix it, or record user authorization and set disposition accepted-risk
  - finding RT-6: a high-risk run cannot ship an open P1 — fix it, or record user authorization and set disposition accepted-risk
```

The shape validation passed — `validateShape` returned no errors, `run_id` matches
the derived `feature-feat-1013-refusal-policy-gate-held-841054`, `merge_base_sha`
recomputes from `fork_sha`, `intake_sha256` matches `.feature/intake.json` as it
stands on disk, and every one of the thirteen `COUNT_KEYS` matches the checker's
own recomputation. All seven issues are substantive.

1. **`INCOMPLETE_ORACLE`** — the six `inconclusive` / `oracle` rows, as explained
   in §6. Expected and honest.
2-6. **Five open P1s on a high-risk run.** `validateHighRiskAdjudication` requires
   every open P1 on a `risk: high` intake to be fixed or to carry a recorded user
   authorization. Per the coordinator's triage these five are `open` because they
   are being fixed; none is an accepted-risk, so `authorizations` is `[]`.
7. **One tracked modification outside this run's report:**

```
  - the worktree carries 1 tracked modification(s) outside this run's report — a
    mutation may not have been restored: M docs/superpowers/plans/feat-1013-refusal-policy-gate-held-intake.json
```

**This is NOT an unrestored mutation, and I checked rather than assuming.**
`git diff` on that path shows a two-line change to `allowed_edit_surface`,
repointing the red-team artifact paths from
`docs/reviews/red-team/feat-1013-refusal-policy-gate-held/…` to the slugged
`…-841054/…`. That is the coordinator's own correction, made after my mutation
phase closed. My mutations only ever touched three files —
`worker/jobs/response-generation/persist.ts`, `src/lib/refusals/vocabulary.ts`
and `src/lib/refusals/write.ts` — and all three are clean
(`git diff --stat HEAD` lists only the intake). I did not revert the
coordinator's edit; it is theirs to keep.

The checker's warning is nonetheless correct to fire: it cannot distinguish a
deliberate concurrent edit from a stranded mutant, and fail-closed is the right
posture. It will clear once that edit is committed.

**HEAD is unmoved at `9aa527812ebefe0c602643a92ee08c048b5a0632`.**

---
---

# ROUND 2 — scoped verification of the round-1 fixes

**HEAD:** `ccaeb196c8919adf395a2cba32482ed630dbc8d3` (was `9aa52781`)
**Surface:** `git diff 9aa52781..HEAD` — 6 files, +240/−75. No new front opened
against unchanged code; anything outside that diff is in the appendix, untriaged.
**Baseline at the new HEAD:** 120/120 unit, 24/24 integration, re-derived.
**Budget:** 16 of 30 runs.

**Round-2 scoreboard: 12 planted, 8 killed, 3 survived, 1 excluded (diagnostic).**

## The headline: a round-1 fix introduced a new, untested P0-class risk

**RT-15 (P0) — `withLedgerAttribution`'s rethrow has no oracle, and a swallow is
a real data-loss path.**

`worker/jobs/response-generation/persist.ts:783-802`

The A3 fix wrapped both ledger writes in a `try/catch` that captures to Sentry
and rethrows. Its docblock makes the safety claim explicitly:

> IT CHANGES NO CONTROL FLOW. The error is re-thrown, so the transaction still
> aborts and no response commits without its required row.

**The claim is TRUE of the code as shipped — I verified it. What has no oracle is
the claim itself.** Replacing `throw error;` with `return undefined as T;`
survives **all 75 tests** (24 integration + 51 persist unit).

Why the existing atomicity tests cannot catch it: both forced-failure cases
inject a migration-116 `23514` CHECK violation. A failed statement puts the
Postgres transaction into aborted state, so *every* subsequent statement fails
regardless of whether the wrapper rethrows. The rollback those tests observe is
produced by Postgres, not by the `throw`. They pass for a reason that is real but
is not the property under test.

**That the mutation is NOT equivalent — the A/B that settles it.** I injected a
plain JS `throw new Error(...)` inside `writeRefusalEvent` (a failure that does
NOT poison the transaction) and ran the same test twice:

| Variant | Result | Meaning |
|---|---|---|
| **A** — swallow mutant + JS throw | Failed at `refusal-write.integration.test.ts:404`, `expected [] to have a length of 1`. `persistResponseAndNotify` RETURNED and `expect(responseId).toBeDefined()` PASSED. | **A response row COMMITTED with no `held_draft` Refusal.** |
| **B** — shipped code + same JS throw | Failed at `:399` with `probe_js_failure_not_a_postgres_error` propagating out of `persistResponseAndNotify`. | Transaction rolled back; no response row. |

Variant A is exactly the outcome the docblock says is unacceptable: "swallowing
here would commit a draft whose Refusal was never recorded".

**Arbiter reasoning (required for a confirmed survivor).** The mutation is not
equivalent — variant A vs B differ in committed database state on an executed
branch. The branch is executed on every held-draft and every policy-gate write,
not a rare path. It is not an unexecuted branch: the `catch` runs whenever the
write throws, which the two constraint tests already exercise. The reachable
trigger class is any non-Postgres failure inside `writeRefusalEvent` — a
`TypeError` in the helper, an encoding fault, a future validation throw — none
of which poisons the transaction.

**Why P0 and not P1, stated plainly so it can be argued with.** The shipped code
is CORRECT and needs no behaviour change. I am calling it P0 on the protocol's
own terms: the mutation is a confirmed non-equivalent survivor, and the sidecar
schema binds that outcome to a P0 finding. Substantively, round 1 had no
`try/catch` on this path at all, so a swallow was impossible by construction; the
fix introduced an editable catch block guarding an invariant that invariant #4
depends on, and left it unpinned. **The remedy is one test, not a code change:**
mock `@/lib/refusals/write` so `writeRefusalEvent` rejects with a plain `Error`,
then assert `persistResponseAndNotify` rejects AND `responses` has no row for
that review. If the coordinator judges the missing oracle a P1, that is a
reasonable call — it needs an explicit authorization, not a silent downgrade.

## Fix-by-fix verdicts

| # | Fix | Probe | Verdict |
|---|---|---|---|
| 1 | RT-1 prose corrected in three places | R2-6 (delete guard 1) SURVIVED · R2-7 (remap `moderation_held`) SURVIVED · R2-8 (both) KILLED | **TRUE.** The new text predicts exactly this: guards 1-3 are redundant defence in depth, guard 4 is load-bearing. The old text predicted the opposite and was false. |
| 2 | RT-2 fallback-log oracle | R2-3 re-planted M10 (drop the `threshold !== null` arm) | **KILLED** at `:681`, `the shared narrowing must exclude a draft whose account has no configured threshold`. Not theatre — independently confirmed. |
| 3 | S1 type widening removed | R2-9 mapped `moderation_flagged` to `null`, ran `tsc --noEmit` | **KILLED AT COMPILE TIME**: `vocabulary.ts(623,5) TS2322 … Type 'null' is not assignable`. Baseline tsc is clean. The deleted `veto_member_won_precedence` throw is genuinely replaced by the type system. R2-11 and R2-12 further confirm the rewrite preserved the veto semantics and the unmapped-code fault path. |
| 4 | S2 `withTemporary` guards | R2-10: inject a failure inside the `archived_at` body, with and without the `finally` | **KILLED.** With the guard: 1 failure, 23 pass — fixture restored. Without: **7 failures**, and every extra failure is a POSITIVE test (`occurred_at`, `no spine run`, `flag flips off`, `auto-approved`, `C5 rollback`, `both lanes`). The leaked `archived_at` veto suppresses every later row. The "writes no row" tests still passed while measuring nothing — precisely the vacuity the fix's docblock describes. |
| 5 | RT-7 literal order assertion | R2-4 (`.sort()`) and R2-5 (`.reverse()`) | **BOTH KILLED**, with the message naming the expected emission order. |
| 6 | A3 `withLedgerAttribution` | R2-1, R2-2 | **RT-15 — see above.** Code correct, property unpinned. |
| 7 | Citations → symbols | grep + resolution | **PARTIAL — see RT-5 below.** |
| 8 | Doc counts | grep | **PARTIAL — see RT-13 below.** |

## RT-5 stays OPEN — one citation was half-converted and is wrong

`worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts:689`

The fix converted the first half of the sentence to a symbol and left the second
half a bare line number:

```
// isAutoApprovalCandidate reads the flag BEFORE the transaction
// (`isAutoApprovalCandidate`); `evaluateAutoApprovalCandidate` reads it again
// INSIDE (:360). ...
```

At HEAD, `auto-approval.ts:360` is `when(input.held, 'moderation_held'),` — not a
flag read at all. The in-transaction read is `auto-approval.ts:346`. This is the
only surviving `path:line` citation in any shipped source file on the branch
(grep over `persist.ts`, `vocabulary.ts` and the test file returns just this one).
Replace `(:360)` with the symbol, as its own sentence-half already was.

The other two are genuinely fixed and their symbols resolve: `persistResponseAndNotify`
contains exactly one `if (activeRun && !held)`, and exactly one
`if (suppressNotification || held)`. `handoff.md:152` and `:156` both resolve —
and `:156`'s "the sole `findActiveReviewRun.mockResolvedValue(null)`" is
accurate: exactly one occurrence, inside
`describe('persistResponseAndNotify run-spine instrumentation')`.

## RT-13 stays OPEN — three of four places qualified

`vocabulary.ts:101`, `vocabulary.ts:422` and `CONTEXT.md:163` all now carry the
"by design capacity / silent while `AUTO_APPROVAL_ENABLED` is off" qualifier.
**`worker/jobs/response-generation/persist.ts:215` does not** — it still reads
"would silently drop rows from the highest-volume lane" with no caveat.

(`vocabulary.ts:312`'s "every one of the six" is a DIFFERENT six — the
`OUTREACH_WITHHELD_DISPATCH` members — and is correct. Not a residual.)

## Round-1 findings not addressed, still open

RT-8 (`vocabulary.test.ts:582`'s accidentally-alphabetical order input — the file
is untouched by this diff), RT-9 (`review_content_changed_before_persist`
unreachable), RT-10 (four inert members). All P2, all unchanged, all still true.

## Appendix — untriaged, outside the round-2 scope

**The intake did not change.** The dispatch said to recompute `intake_sha256`
because "the intake changed again — `estimated_prod_lines` and the sidecar
paths". On disk it is byte-identical to round 1:
`d486d8f5807dd04f88f0f73f7c5f20d641106937c2d49f4ea198a7fcda0f5f61` for BOTH
`.feature/intake.json` and the tracked
`docs/superpowers/plans/feat-1013-refusal-policy-gate-held-intake.json` (the two
are identical to each other), and `estimated_prod_lines` is still `520` at
line 144 of each. Only the two sidecar paths changed, and that edit landed during
round 1 — it is the still-uncommitted tracked modification the checker reports.
The sidecar carries the digest of the file as it actually is. If an
`estimated_prod_lines` edit was intended, it did not land.

## Round-2 mutation journal

| # | File | Mutation | Oracle run | Outcome |
|---|---|---|---|---|
| R2-1 | `persist.ts:800` | `throw error;` → `return undefined as T;` in `withLedgerAttribution` | held_draft + policy_gate constraint tests, then ALL 24 integration + 51 persist unit | **SURVIVED — confirmed, RT-15** |
| R2-2 | `write.ts` + `persist.ts` | plain-JS `throw` inside `writeRefusalEvent`, run with and without the swallow | `-t "a high-severity moderation flag writes one held_draft row with refusal_code null"` | **excluded** (A/B diagnostic establishing R2-1's non-equivalence, not a mutation verdict) |
| R2-3 | `persist.ts:688` | drop `runtimeState.effectivePolicy.threshold !== null` | `-t "a structurally eligible draft with no configured policy threshold…"` | **KILLED** |
| R2-4 | `vocabulary.ts:604` | `.sort()` on `allRefusalCodes` | `-t "…preserves blockReasons order verbatim"` | **KILLED** |
| R2-5 | `vocabulary.ts:604` | `.reverse()` on `allRefusalCodes` | same | **KILLED** |
| R2-6 | `persist.ts:742` | delete `if (held) return;` | `-t "a high-severity moderation flag writes no policy_gate_held row"` | **survived — equivalent, and now correctly documented** |
| R2-7 | `vocabulary.ts:449` | `moderation_held: null` → `'watchdog_unavailable'` | same | **survived — equivalent, and now correctly documented** |
| R2-8 | both | R2-6 + R2-7 together | same | **KILLED** — guard 4 is the load-bearing one, as the new docblock says |
| R2-9 | `vocabulary.ts:441` | `moderation_flagged: 'unsafe_content'` → `null` | `npx tsc --noEmit -p tsconfig.json` | **KILLED (compile error TS2322 at vocabulary.ts:623)** |
| R2-10 | test file | remove `try/finally` from `withTemporary`, inject a body failure | full integration suite, A/B | **KILLED** — 1 failure guarded vs 7 unguarded |
| R2-11 | `vocabulary.ts:594` | veto made position-dependent, post-S1-rewrite | `PROP -t "invariants: any block reason set containing a veto member…"` | **KILLED** |
| R2-12 | `vocabulary.ts:590-592` | delete the `Object.hasOwn` unmapped-code throw, post-S1-rewrite | `VOC -t "resolvePolicyGateRefusal throws on a code in neither…"` | **KILLED** |

## Round-2 restoration attestation

```
$ node .agents/skills/red-team/scripts/mutation-runner.mjs finalize
reap: every journaled process group is empty (0 recorded)
finalize: restored 0 mutated file(s) and 0 dotenv file(s); journal closed

$ git diff --stat HEAD
 docs/superpowers/plans/feat-1013-refusal-policy-gate-held-intake.json | 4 ++--

$ git rev-parse HEAD
ccaeb196c8919adf395a2cba32482ed630dbc8d3
```

The one tracked modification is the coordinator's own round-1 sidecar-path edit,
not a mutation of mine. My round-2 mutations touched `persist.ts`,
`vocabulary.ts`, `write.ts` and the integration test file; all four are clean.
Post-restore: 120/120 unit, 24/24 integration. HEAD unmoved.

## Round-2 checker output

```
$ node .agents/skills/feature/scripts/red-team-status.mjs
red-team-status: FAILED (3 issue(s))
  - red-team status is OPEN_P0 — every non-CLEAR status blocks the transition
  - finding RT-5: a high-risk run cannot ship an open P1 — fix it, or record user authorization and set disposition accepted-risk
  - the worktree carries 1 tracked modification(s) outside this run's report — a mutation may not have been restored: M docs/superpowers/plans/feat-1013-refusal-policy-gate-held-intake.json
```

Shape validation passes; all three issues are substantive.

| Count | Round 1 | Round 2 |
|---|---|---|
| `inventory_total` | 22 | **34** |
| `killed` | 16 | **24** |
| `survived_confirmed_p0` | 0 | **1** (RT-15) |
| `inconclusive` (all `oracle`) | 6 | **8** |
| `excluded` | 0 | **1** |
| `findings_total` | 14 | **15** |
| `p0_open` | 0 | **1** |
| `p1_open` | 5 | **1** |
| `p2_open` | 8 | **4** |
| `fixed` | 0 | **8** |
| `rejected` | 1 | **1** |

**status = `OPEN_P0`**, driven solely by RT-15. Eight of the fourteen round-1
findings are verified fixed by mutation, not by reading the diff. `OPEN_P0`
outranks the `INCOMPLETE_ORACLE` that round 1 reported; the eight
`inconclusive`/`oracle` rows are still there and would resurface as the status
once RT-15 is closed.

The third line is the coordinator's own uncommitted round-1 sidecar-path edit to
the intake, not a stranded mutant — the same one round 1 reported, still
uncommitted. It clears on commit.

---
---

# ROUND 2 — disposition re-verification (not a new round)

**HEAD:** `35f60e9c054666d9b4f8f3fa0a23462ac1400252` · tree clean, everything committed.
**Baseline re-derived:** 120/120 unit, **25/25 integration** (was 24 — the new
rethrow oracle). **Round stays 2.** Scope: re-plant only mutations already used.

**Re-plant scoreboard: 3 planted, 3 killed, 0 survived.**

## 1. RT-15 (the P0) — FIXED, verified independently

The new case `'a plain ledger error is rethrown rather than swallowed, so the
response row rolls back on both lanes'` is a genuine oracle, and I confirmed it
without relying on the coordinator's own run.

Re-planting the identical swallow (`throw error;` → `return undefined as T;` at
`persist.ts:800`):

```
AssertionError: promise resolved "{ kind: 'persisted', …(1) }" instead of rejecting
 Tests  1 failed | 24 passed (25)     ← integration
 Tests  51 passed (51)                ← persist unit
```

**The failure message is the proof, not just the failure.** `promise resolved
"{ kind: 'persisted' }"` is precisely the round-2 variant-A behaviour: under a
swallow the persist COMPLETES and returns a persisted outcome. In round 2 that
same mutation survived all 75 tests; it now dies against exactly one case, with
24 + 51 still green — no collateral, so the oracle is targeted rather than a
blunt instrument.

Two properties I checked beyond "it fails": the mock throws a plain `Error`
(`ledger_write_failed_plain_js`), NOT a `23514`, so the Postgres transaction
stays healthy and only the rethrow can roll it back — which is the distinction
the round-2 finding turned on. And it covers BOTH lanes in one body, asserting
`responseIdFor(reviewId)` is `undefined` per lane, so the data-loss claim itself
is asserted rather than merely the rejection.

## 2. RT-5 — FIXED

`(:360)` is now `` `evaluateAutoApprovalCandidate`'s own `autoApprovalRuntimeEnabled()`
read ``. Sweeping every `.ts` file the branch changed for
`path.ts:NNN`, `(:NNN)` or `` `:NNN ``:

```
$ git diff --name-only origin/main..HEAD -- 'src/**/*.ts' 'worker/**/*.ts' | xargs grep -nHE '…'
(no output)
```

No `path:line` citation remains in any shipped source file on this branch.

## 3. RT-8 — FIXED

Indices `[13, 6, 1]` are descending by precedence rank and unsorted
alphabetically. Re-planting M6 at `vocabulary.ts:604` now dies **at this case**,
not only in the property test:

| Mutation | Result at `vocabulary.test.ts` |
|---|---|
| `.sort()` | `expected [ 'auto_approval_disabled', …(2) ] to deeply equal [ 'rating_below_threshold', …(2) ]` — **KILLED** |
| `.reverse()` | `expected [ 'provider_moderation_error', …(2) ] to deeply equal [ 'rating_below_threshold', …(2) ]` — **KILLED** |

The added `expect(resolved!.refusalCode).toBe(precedence[1])` also pins that the
winner is the highest-RANKED member present rather than the first supplied.

## 4. RT-13 — FIXED, all four sites

| Site | Qualifier |
|---|---|
| `worker/jobs/response-generation/persist.ts:216` | "the lane with the highest design capacity — silent in production until `AUTO_APPROVAL_ENABLED` is on" |
| `src/lib/refusals/vocabulary.ts:101` | "BY DESIGN CAPACITY … zero while `AUTO_APPROVAL_ENABLED` is off" |
| `src/lib/refusals/vocabulary.ts:422-423` | "by design capacity, and SILENT in production until…" |
| `CONTEXT.md:163` | "BY DESIGN CAPACITY, though silent in production until…" |

## 5. RT-9 / RT-10 — FIXED, and the disclosure is more complete than my finding

`vocabulary.ts:509-529`. I checked each claim rather than accepting the summary:

- The three structural members — accurate; matches RT-10 exactly.
- `review_content_changed_before_persist` and the resulting unreachability of
  precedence tier 5 `below_our_bar` — accurate; matches RT-9 exactly, including
  that it is the tier's only member.
- `policy_not_enabled` — accurate, and it is an addition I had NOT listed as an
  unreachable member in round 1 (I had only used the fact inside RT-2's
  reasoning). `thresholdBlockReason` emits it only when `threshold === null`
  (`auto-approval.ts:389-393`), and that same condition fails
  `isGenuineAutoCandidate`, so it cannot reach the resolver.
- "None of the five is dead code to delete … the map must stay TOTAL or the
  `satisfies` guard stops protecting the others" — correct, and it is the right
  reason: deleting an entry would break the `Record` totality that makes every
  OTHER member's omission a compile error.
- The added note that a within-tier reorder is deliberately unpinned while a
  cross-tier move is pinned — accurate, and it is exactly the M4a/M4b result.

Both findings are closed. One precision gap remains, below.

## 6. RT-16 (NEW, P2) — the disclosure says FIVE; it is SIX

`src/lib/refusals/vocabulary.ts:511`

> FIVE OF THE 22 MEMBERS CANNOT REACH THIS RESOLVER TODAY

`moderation_held` also cannot, and it is not in the list. Verified rather than
reasoned-from-memory:

- `moderation_held` has exactly ONE production emitter,
  `when(input.held, 'moderation_held')` at `auto-approval.ts:360`, so it is in
  `blockReasons` **iff** `held` is true.
- `recordPolicyGateRefusal`'s guard 1 is `if (held) return;`, three statements
  before `resolvePolicyGateRefusal` is called.

So whenever the member exists, the resolver is not reached.

**Why it is worth a sentence rather than a silent omission.** `moderation_held`
is a genuinely different case from the other five, and the difference cuts
toward listing it: the other five are blocked by conditions this same docblock
calls structural or narrowing failures, whereas `moderation_held` is blocked
only by guard 1 — which `persist.ts:704-709` explicitly documents as *redundant
defence in depth*, and which round-2 mutation R2-6 confirmed can be deleted with
no behavioural change. Remove guard 1 and `moderation_held` immediately reaches
the resolver and vetoes there. Its map entry is therefore load-bearing under a
change the branch's own prose invites, which is precisely the RT-1 mechanism.

P2, open. Doc-only; no code change implied.

## 7. Dispositions carried forward unchanged

RT-1, RT-2, RT-3, RT-6, RT-7, RT-11, RT-12, RT-14 — verified fixed by mutation
in round 2, unchanged here. RT-4 stays **rejected** (my own false finding).

## Re-plant journal

| # | File | Mutation | Oracle | Outcome |
|---|---|---|---|---|
| R3-1 | `persist.ts:800` | `throw error;` → `return undefined as T;` | `-t "a plain ledger error is rethrown rather than swallowed…"`, then full 25 + 51 | **KILLED** (1 of 25 fails, 51 unit green) |
| R3-2 | `vocabulary.ts:604` | `.sort()` on `allRefusalCodes` | `vocabulary.test.ts -t "resolvePolicyGateRefusal returns the winner as a member of the co-occurring set it won"` | **KILLED** |
| R3-3 | `vocabulary.ts:604` | `.reverse()` on `allRefusalCodes` | same | **KILLED** |

## Status — still `INCOMPLETE_ORACLE`, and I am not laundering it

With RT-15 and RT-5 closed, `p0_open` and `p1_open` are both **0**. The status is
nonetheless `INCOMPLETE_ORACLE`, because eight inventory rows remain
`inconclusive` / `oracle` and that outranks `OPEN_P1` and `CLEAR` in
`recomputeStatus`.

**Those eight are truthfully inconclusive and must not be reclassified.** Six are
the equivalent mutants — M1, M1b, M4a, M8, M9 (round 1) and R2-6, R2-7
(round 2) — where deleting a guard or remapping an entry changes no observable
behaviour, so no oracle can kill them. Marking them `killed` would assert a test
caught something no test can catch. The branch's own docblock now says the same
thing in prose ("deleting guards 1, 2 or 3 individually changes no outcome and
kills no test"), so the code and the sidecar agree; it is the STATUS VOCABULARY
that cannot express "unfalsifiable by design, and deliberately so".

**One row is arguably resolvable and I still left it alone.** M10 survived in
round 1 and its re-plant R2-3 was KILLED in round 2 once the fallback-log oracle
landed. The skill's own wording says an inconclusive row is forced "unless a
later valid mutation resolves that row", so M10 could defensibly flip to
`killed`. I left it `inconclusive` because the row is the round-1 record, R2-3 is
its own row carrying the resolution, and flipping it would not change the status
anyway — five genuinely-equivalent rows remain. Recording that I considered it
and declined, so the choice is visible rather than silent.

**The tooling limitation, stated for the owner.** `recomputeStatus` treats any
`inconclusive` row as incompleteness. It has no way to distinguish "no verdict
because the run was cut short" from "no verdict because the mutant is provably
equivalent". The second is a completed, informative result. Until the schema can
express it — an `equivalent-confirmed` outcome, or an authorization that clears
oracle-class rows — a branch containing any redundant defence-in-depth cannot
reach `CLEAR` through this gate no matter how good its tests are.

## Re-verification checker output

```
$ node .agents/skills/feature/scripts/red-team-status.mjs
red-team-status: FAILED (2 issue(s))
  - red-team status is INCOMPLETE_ORACLE — every non-CLEAR status blocks the transition
  - the worktree carries 1 tracked modification(s) outside this run's report — a mutation may not have been restored: M docs/reviews/red-team/feat-1013-refusal-policy-gate-held-841054/findings.json
```

Shape validation passes. `intake_sha256` matches `.feature/intake.json`
(`d486d8f5…`, unchanged), `merge_base_sha` recomputes from `fork_sha`, `run_id`
matches the derived slug, and all thirteen `COUNT_KEYS` match the checker's own
recomputation.

| Count | R1 | R2 | Now |
|---|---|---|---|
| `inventory_total` | 22 | 34 | **37** |
| `killed` | 16 | 24 | **27** |
| `survived_confirmed_p0` | 0 | 1 | 1 (RT-15, now `fixed`) |
| `inconclusive` (all `oracle`) | 6 | 8 | 8 |
| `excluded` | 0 | 1 | 1 |
| `findings_total` | 14 | 15 | **16** |
| `p0_open` | 0 | 1 | **0** |
| `p1_open` | 5 | 1 | **0** |
| `p2_open` | 8 | 4 | **1** |
| `fixed` | 0 | 8 | **14** |
| `rejected` | 1 | 1 | 1 |

## Appendix — a checker bug, untriaged, not a branch finding

**The second line is spurious.** `findings.json` is one of this run's own two
artifacts and IS excluded by the checker's filter — but only from the second
porcelain line onward. `makeGit` (`red-team-status.mjs:441-450`) calls `.trim()`
on the WHOLE `git status --porcelain` output, which strips the leading space of
the FIRST line only. The filter then does `line.slice(3)`, which is correct for
`" M path"` but mis-slices the de-spaced first line to `"ocs/reviews/…"`, so it
never matches the exclusion. Demonstrated directly:

```
--- WITHOUT the whole-output trim (correct) ---
" M …/findings.json" -> slice(3): "docs/…/findings.json" | excluded: true
" M …/findings.md"   -> slice(3): "docs/…/findings.md"   | excluded: true
--- WITH .trim() as the checker does ---
"M …/findings.json"  -> slice(3): "ocs/…/findings.json"  | excluded: false   ← spurious
" M …/findings.md"   -> slice(3): "docs/…/findings.md"   | excluded: true
```

Git sorts `findings.json` before `findings.md`, so the JSON artifact always
takes the first slot and always misreports while both are uncommitted. It
clears the moment the artifacts are committed.

This also explains why the same line looked correct in rounds 1 and 2: the first
porcelain entry then was the intake, which WAS a genuine uncommitted
modification, so the warning was accidentally right for the wrong reason.

Fix if you want it: drop the `.trim()` in `makeGit` for this call, or split on
`\n` before trimming. Outside this branch's scope — recorded, not triaged.

**Nothing is unrestored.** `git status --porcelain` lists exactly the two report
artifacts and nothing else; every mutated source file was restored with a
named-path `git checkout --`, and the post-restore suites are green (120/120
unit, 25/25 integration). HEAD is unmoved at
`35f60e9c054666d9b4f8f3fa0a23462ac1400252`.

---
---

# FINAL STAMP — bookkeeping only

**HEAD:** `4fe4a7c820a4d3c2f7b5149f85d0310779f8dd8f` · **round stays 2** · no new
mutations, no new fronts. Two commits landed since the previous stamp
(`484bb598`, `4fe4a7c8`).

## I agree a doc-only change cannot move a mutation outcome — and I checked rather than assumed

The dispatch invited disagreement, so this was verified two independent ways
before I accepted it:

1. **Line-level.** Filtering the `35f60e9c..HEAD` delta for `src/lib/refusals/vocabulary.ts`
   down to lines that are NOT docblock continuations returns nothing — every
   added and removed line begins ` *` inside the block comment preceding
   `AUTO_APPROVAL_BLOCK_PRECEDENCE`. No declaration, no value, no type changed.
2. **Empirically.** The full baseline at the new HEAD is byte-identical in
   outcome to the previous stamp: **120/120** unit, **25/25** integration.

The one way a comment change *could* have mattered is that this repo has
source-parsing tests (`vocabulary.test.ts` asserts the
`REFUSAL_VOCABULARY_VERSION` DECLARATION as text and scans for dynamic imports,
and `unionMembers` parses `worker-types.ts`). That is exactly why I re-ran rather
than reasoning alone — those suites are inside the 120 and they are green. So:
**every existing inventory row stands unchanged, and no re-plant is warranted.**

## RT-16 — FIXED, wording confirmed claim by claim

`vocabulary.ts:513` now reads "SIX OF THE 22 MEMBERS CANNOT REACH THIS RESOLVER
TODAY" and adds `moderation_held` with the masking nuance. Each claim
re-checked against the code:

| Claim in the new wording | Verification |
|---|---|
| "its sole emitter is `when(input.held, 'moderation_held')`" | Confirmed — `auto-approval.ts:360` is the only production emitter. |
| "guard 1 returns before the resolver on exactly that condition" | Confirmed — `if (held) return;` sits three statements ahead of the resolver call. |
| "THE TWO MASK EACH OTHER … deleting EITHER alone is behaviour-preserving" | Confirmed by four independent runs: M1 and M1b (round 1), R2-6 and R2-7 (round 2) — all survivors. |
| "deleting BOTH writes a duplicate `unsafe_content` row for every held draft" | Confirmed. `held` is `flaggedHigh = moderation.flagged && severity === 'high'` (`persist.ts:830`), so `held` ALWAYS implies `moderation_flagged` (`auto-approval.ts:359`), which is `precedence[0]` in tier 1 `unsafe_content`. M1c and R2-8 both killed with `expected 0, received 1`. |

I also re-derived the full 22-member reachability table to confirm **six** is now
*exhaustive* rather than merely larger than five: the sixteen unlisted members
are each reachable on a live path. The list is complete.

## Final counts

| Count | Value |
|---|---|
| `inventory_total` | 37 |
| `killed` | 27 |
| `survived_confirmed_p0` | 1 (RT-15, disposition `fixed`) |
| `inconclusive` (all `oracle`) | 8 |
| `excluded` | 1 |
| `findings_total` | 16 |
| `p0_open` / `p1_open` / `p2_open` | **0 / 0 / 0** |
| `fixed` | 15 |
| `rejected` | 1 |

**status = `INCOMPLETE_ORACLE`**, with every severity class at zero open.

## The residual status, stated one last time for the owner

Nothing is open. Fifteen findings are fixed, one is rejected as my own error, and
no finding of any severity remains unaddressed. The status is `INCOMPLETE_ORACLE`
solely because eight inventory rows are `inconclusive`/`oracle`, and that
outranks `CLEAR` in `recomputeStatus`.

Those eight are truthfully inconclusive. Six are equivalent mutants — deleting a
guard or remapping an entry that changes no observable behaviour, so **no test
can kill them, and none should be written to try**. The branch's own docblocks
now say the same thing in prose, including the `moderation_held` masking pair
this stamp confirms. Two more (M10, M9) are of the same class from round 1.
Reclassifying any of them `killed` would assert that a test caught something no
test can catch, so I have not, across three requests to finalise.

The gap is in the status vocabulary, not the evidence: `recomputeStatus` cannot
distinguish "no verdict because the run was cut short" from "no verdict because
the mutant is provably equivalent" — the second being a completed, informative
result. Until an `equivalent-confirmed` outcome exists (or an authorization can
clear oracle-class rows), no branch containing deliberate redundant
defence-in-depth can reach `CLEAR` through this gate, however good its tests are.
That is the finding to take to the owner, and it is a tooling limitation rather
than a fact about this branch.

---
---

# POST-REBASE STAMP — pins only

A rebase onto `origin/main` (which gained dependabot commit `914a797a`) rewrote
every SHA. **Round stays 2. Every inventory row and every disposition is
unchanged.** New pins:

| Pin | Was | Now |
|---|---|---|
| `head_sha` | `4fe4a7c820a4d3c2f7b5149f85d0310779f8dd8f` | `a5d52b212a5d4f4b58aa0013790956c00c5f4566` |
| `fork_sha` / `merge_base_sha` | `566b8583a42ef7037d25a7eb8f0387d48ff948c0` | `914a797aaae7c59be1a18e056d035f530b45f3da` |
| `intake_sha256` | `d486d8f5…` | `d486d8f5…` (recomputed, unchanged) |

## The no-re-plant claim — checked, and it holds

```
$ git diff 4fe4a7c8..HEAD -- src worker
(no output)
```

Not one byte of `src/` or `worker/` differs across the rebase, so no mutation I
planted can have a different outcome. Re-baselined anyway: **120/120** unit,
**25/25** integration — identical to the pre-rebase stamp.

**One correction to the framing, minor.** "The only content change anywhere is
the two-row merge-ledger tail" is not quite right: the dependabot bump also
changed `.github/workflows/claude.yml` and `claude-code-review.yml`. That is the
whole point of the rebase so it is a wording slip rather than a
misrepresentation, but it is worth naming because those YAML files are NOT
inert — `src/__tests__/ci-audit-wiring.test.ts` pins them, per `CLAUDE.md`. That
test sits in the 29-row gate, not in my five suites, so it is the gate's green
that covers it, not mine. `.claude/reference/arch-review-log.md`'s two-row tail
is read by no test.

## On D11's framing — one correction, and two citations confirmed

**Confirmed accurate:**

- `SKILL.md:180` does mandate the label. Verbatim: *"A survivor you judge
  plausibly equivalent or unexecuted is reclassified `inconclusive` (class
  `oracle`)."* The citation resolves exactly.
- `OUTCOMES` genuinely has no member meaning "unfalsifiable by design" — the set
  is `killed`, `survived-confirmed-P0`, `inconclusive`, `skipped-budget`,
  `excluded`.
- `p0_open`, `p1_open` and `p2_open` are all `0`, and the status is driven only
  by the eight `inconclusive`/`oracle` rows.

**The correction.** D11 reportedly cites my refusal to relabel as *the reason the
override is safe to take*. That inverts the load-bearing part. My refusal is not
a safety argument — on its own it establishes only that the sidecar was not
laundered, i.e. that `p0_open = p1_open = p2_open = 0` means what it says. The
override is safe because of the POSITIVE evidence behind those zeros: 27 killed
mutants across 37 rows, every finding of every severity fixed or rejected, and
eight inconclusive rows that are each an arbiter-confirmed EQUIVALENT mutant
carrying a recorded proof — a completed result, not a missing one.

Stated as it should read: *the sidecar can be trusted because nothing was
relabelled; and a trusted sidecar shows the evidence is complete.* The version in
D11 risks reading as "we overrode because the reviewer was stubborn", which would
not survive scrutiny in a PR body.

**One precision worth keeping in D11.** Of the eight inconclusive rows, seven are
permanently unfalsifiable (deleting the guard or remapping the entry changes no
observable behaviour). The eighth, **M10**, was equivalent only against the
oracles that existed in round 1 — its re-plant `R2-3` was KILLED in round 2 once
the fallback-log assertion landed. I left M10 `inconclusive` because it is the
round-1 record and `R2-3` carries the resolution as its own row. So the honest
count for "cannot ever be killed" is seven, not eight.
