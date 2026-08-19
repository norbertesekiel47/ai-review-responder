# Pathfinder 2026-08-18 — handoff prompts

**Filed as issues 2026-08-18** — H1 → #890 · H2 → #891 · H3 → #892 · H4 → #893 ·
H5 → #894 · H6 → #895 · H7 → #896. Plus #889 (the unowned flaky
`autopilot-entitlement-concurrency` suite), found by the same pass.

Seven independent handoffs. Each is sized to one `/feature` run. Paste a block into
`/make-plan` (or `/feature`) verbatim.

**Ordering constraints** — only two exist. H5's three steps are strictly ordered internally.
H2 should land before or with the `ApprovalPanel` extraction in issue #886, because #886's
subject contains the false comment H2 corrects. Everything else is independent.

---

## H1 — One owner for the cancellable set

```
Give the "cancellable delivery status" set a single named owner, and make the coupling
between its six spellings mechanical instead of prose.

WHY NOW: CONTEXT.md:75 (LOCKED, Ask withdrawal) states "a THIRD caller is the signal to
extract rather than a second (recorded at the #872 branch review)." Three SQL callers exist
today. The precondition the codebase set for itself has fired.

TARGET: a new dependency-free leaf, src/lib/solicitation/delivery-status.ts
  export const CANCELLABLE_DELIVERY_STATUSES = ['rendered', 'queued'] as const
  export function isCancellableDeliveryStatus(s: string): boolean
  export const WITHDRAWABLE_BATCH_STATES = ['veto_window', 'approved', 'sending'] as const

REWRITE THESE THREE TYPESCRIPT CALL SITES:
  - src/lib/solicitation/approval.ts:1010-1011  (classifyWithdrawal)
  - src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:973  (useArmedWithdrawal)
  - src/app/(authenticated)/dashboard/requests/AskList.tsx:306  (withdraw control gate)

AND these two spellings of the withdrawable-state set:
  - src/lib/solicitation/approval.ts:939-941  (isWithdrawableState — derive from the const)
  - ApprovalPanel.tsx:144-146  (HaltableState — becomes
    Extract<SendLaneView['batchState'], typeof WITHDRAWABLE_BATCH_STATES[number]>)

LEAVE THESE THREE SQL SITES BYTE-FOR-BYTE UNCHANGED:
  - src/lib/solicitation/approval.ts:494   (latchHalt cancel)
  - src/lib/solicitation/approval.ts:1126  (withdrawAsk CAS guard)
  - src/lib/solicitation/batch-view.ts:948 (cancellableCount)
  approval.ts:1119-1120 says why: "The status literals are PARAMETERS so the query-shape pin
  can assert them by value; the IN list stays literal." Two tests depend on that spelling —
  approval.test.ts:302 and :570. Parameterizing them loses both for nothing.

ADD ONE TEST (~15 lines) that asserts each of those three query texts contains the IN-list
rendered from CANCELLABLE_DELIVERY_STATUSES. This is the whole point of the ticket: today the
coupling is prose on three sides and mechanical on none, so a ONE-SIDED widening passes both
suites — widen the latch only and SolicitationBatchPanel.tsx:403 ("It cancels the
{cancellableCount} rendered and queued message(s) only") silently understates the consequence
of the button beside it.

ANTI-PATTERN GUARDS:
  - DO NOT put the constant in outreach.ts (it runtime-imports @/lib/agents/run-spine, and
    ApprovalPanel/AskList import from @/lib/solicitation/* TYPE-ONLY today — invariant #1).
  - DO NOT put it in approval.ts, same reason.
  - DO NOT derive the cancellable set as the complement of TERMINAL_DELIVERY_STATUSES
    (outreach.ts:136-147). approval.ts:1146 (+ 'sending') is the actual complement and answers
    a DIFFERENT question. One constant must not answer three.
  - DO NOT make TERMINAL_DELIVERY_STATUSES public to do it — it is module-private on purpose
    (outreach.ts:113-116).
  - New file ⇒ a docs/directory.md row in the same PR (ci:directory-map).

EVIDENCE: docs/reviews/PATHFINDER-2026-08-18/01-flowcharts/F1-send-batch-approval-lane.md
(Q1) and 02-duplication-report.md (W1, W3, X1).
```

## H2 — One predicate for "the close settled the batch", and the comment it already falsified

```
Give "did closeBatchIfSettled actually close the batch?" a single predicate, and fix the
comment the current two-form split already made false.

TARGET: export function batchDidClose(close: CloseBatchIfSettledResult): boolean
in src/lib/solicitation/outreach.ts, beside the union it discriminates (declared :201, :359).

REWRITE THESE THREE CALL SITES to batchDidClose(result.close):
  - src/app/api/dashboard/solicitation/batch/halt/route.ts:45
  - src/app/api/dashboard/solicitation/batch/withdraw/route.ts:43
  - src/app/api/admin/solicitation/batch/halt/route.ts:91

FIX THE FALSE COMMENT in the same PR:
  src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:562-563 currently says
  remainingLive/closed are "read from the body when present and null otherwise — approve,
  halt and regenerate do not send them." `closed` IS sent by two of them:
  approve/route.ts:60 (closed: result.close !== null) and halt/route.ts:45. Only
  `remainingLive` is withdraw-exclusive. The comment is inert today because only
  withdrawnAnnounce (ApprovalPanel.tsx:700) reads done.closed — but issue #886 asks for an
  extraction of exactly this section, and an extraction that trusts this sentence will drop a
  field two routes populate.

OPTIONAL SECOND STEP — decide explicitly, do not drift into it:
  src/lib/solicitation/approval.ts:404 pre-narrows to null
  (close: close.status === 'not_settled' ? null : close), which is why approve/route.ts:60
  reads `!== null` while the other three read `!== 'not_settled'`. Dropping that ternary makes
  ApproveBatchResult.close non-nullable like the other three and all four sites read
  identically. This CHANGES A PUBLIC DOMAIN UNION. Either do it deliberately with its test
  updates, or leave approve/route.ts:60 alone and say so in the PR.

ANTI-PATTERN GUARDS:
  - Do not add a parameter to batchDidClose. It answers one question.
  - Do not fold it into closeBatchIfSettled's return type as a boolean field — the
    discriminated union is what makes the four result arms exhaustive at the call sites.

EVIDENCE: 02-duplication-report.md (W2) and
01-flowcharts/F2-requests-owner-surface.md (the write section).
```

## H3 — One owner for the purge tombstone sentinels, plus two truth fixes in the same file

```
Make the purge writer and the purge verifier agree BY CONSTRUCTION instead of because two
humans typed the same string seven times.

TARGET: PURGE_TOMBSTONE_SENTINELS, a new leaf under src/lib/account-offboarding/
(the verifier's own root; the worker already imports from src/lib/).

THE SEVEN DUPLICATED LITERALS (writer → verifier):
  'Deleted location'                              purge-stages.ts:657 → purge-verification.ts:113
  'professional and friendly'                     :661 → :120
  'Deleted owner'                                 :667 → :121
  'deleted-' || id::text || '@repworth.invalid'   :668, :649 → :122, :162
  '[]'::jsonb                                     :672 → :144
  'Deleted account'                               :696 → :97
  'Deleted user'                                  :648 → :161

TWO TRUTH FIXES IN THE SAME PR (same file, same class):
1. purge-verification.ts:144 uses `b.tracked_keywords <> '[]'::jsonb` where the same column
   class at :120 uses IS DISTINCT FROM. tracked_keywords is nullable
   (014_retention_expansion.sql:74) and is RESTORED to a default, exactly like tone.
   NULL <> '[]' evaluates to NULL and contributes nothing to an OR-chain. Exposure is low
   today because :150 (archived_at IS NULL) catches the row — but the codebase deliberately
   chose NOT to rely on that argument for tone, and the asymmetry is the defect.
2. The comment at :115-116 claims tone is "the ONE column the tombstone RESTORES to its schema
   default." It has two members. And the chain is 28 predicates, not 27 —
   docs/directory.md:1176 says 27, and the count is stated in prose in two places and
   enforced nowhere.

ANTI-PATTERN GUARDS:
  - DO NOT point the tone sentinel at src/lib/responses/prompt-builder.ts:31 DEFAULT_TONE.
    That constant is a PROMPT FALLBACK. The authority here is the schema default at
    001_initial_schema.sql:71. Same value, different fact — conflating them is the next drift.
  - DO NOT collapse the two 28-item column lists into one. They are a SET clause and an
    OR-chain over three different predicate kinds. A declarative column→expectation table is a
    separate design decision (F9 seed 10, now justified) and must not ride along here.
  - New file ⇒ docs/directory.md row (ci:directory-map).

EVIDENCE: 01-flowcharts/F9-account-purge-verifier.md (the 28-column classification) and
02-duplication-report.md (W7).
```

## H4 — Bound the admin read fan-out, and replace the enumerated pins with a rule

```
Fix a 2-wide DB fan-out that contradicts the codebase's own admission-control doctrine, then
fix the reason four guards missed it.

PART 1 — the bug.
src/lib/admin/suppressions-service.ts:72 runs
  const [rows, corrections] = await Promise.all([sql`…`, sql`…`])
on the singleton sql, reached from src/app/api/admin/suppressions/lookup/route.ts:24
(Vercel, DB_POOL_MAX=3).

src/lib/db/admission.ts:26-31 names this exact shape: "Bounding per-request fan-out is NOT
sufficient and this module is not a substitute for it … so /api/admin/flagged wedged with a
fan-out of TWO against a pool of THREE." The sibling route carries the opposite instruction in
code: src/app/api/admin/costs/route.ts:20-26 — "SEQUENTIAL — do NOT re-introduce a
Promise.all here (#505)."

Sequence the two reads. Severity today is bounded by admission (cap == pool ⇒ queue, not
pipeline), so this is latency and contention, not the old permanent wedge — say so honestly in
the PR rather than overstating it.

PART 2 — why it survived, and this is the actual deliverable.
The guard is four hand-written pins with ENUMERATED import lists, and lookupSuppressions is in
none of them:
  - src/lib/admin/__tests__/pool-fanout-sequential.test.ts:33-38   (3 subjects)
  - src/lib/admin/__tests__/admin-read-single-inflight.test.ts:30-34 (5 subjects)
  - src/lib/dashboard/__tests__/pool-fanout-sequential.test.ts:38-39
  - src/lib/locations/__tests__/pool-fanout-sequential.test.ts:30
No ci:* script checks fan-out at all.

Replace the enumeration with a rule that cannot miss a subject: an AST audit over
src/lib/{admin,dashboard,locations}/** that fails any Promise.all whose elements are two or
more tagged-template calls on a Sql parameter. Keep a named, reasoned allowlist for the
legitimate case (src/app/api/admin/jobs/route.ts:27 is one DB call plus one Redis call).

ANTI-PATTERN GUARDS:
  - Part 1 without Part 2 repeats the pattern that let this one through.
  - Do not widen the four existing pins by adding lookupSuppressions to their import lists.
    That is the enumeration, not a fix for it.
  - A new ci:* script must be wired into ci.yml's lint job AND lefthook.yml, or
    src/__tests__/ci-audit-wiring.test.ts fails — which is correct and is the point.

EVIDENCE: 02-duplication-report.md (X9, X10).
```

## H5 — Make "outside the audit's scope" a stated fact at the call site — THREE ORDERED STEPS

```
Close the ci:tenant-scope blind spot in the order that does not create 63 red lines.

READ THIS FIRST: the naive fix is wrong and was MEASURED to be wrong. F8's agent copied the
audit, added all four missing tables to TENANT_TABLES, patched the analyzer to emit scoped
bindings, and ran --no-allowlist. Result: 77 production bindings — 14 provably scoped, 63
would emit a finding, and ZERO are live tenant leaks. Adding the tables today buys nothing and
costs 63 red lines. See 01-flowcharts/F8-ci-enforcement-surface.md.

STEP 1 (cheapest, no engine work, do this first).
The convention that closes this already exists — written once, by one author, in exactly one
place in all of src + worker:
  src/lib/solicitation/batch-view.ts:389-400 — "job_outbox is absent from
  scripts/ci/tenant-tables.ts, so a statement referencing only that table is not audited …
  Do NOT 'fix' this by joining solicitation_batches to make it look scoped."
Make that a convention: every query touching a relation outside TENANT_TABLES carries one line
saying so and why. Start with the sites this pass found:
  - src/lib/dashboard/pending-count.ts:29-30  ← DO THIS ONE FIRST. Its comment currently
    claims "The explicit JOIN businesses … account_id scope is what the tenant-scope audit
    requires for an account-wide read." That is FALSE — the audit forms no opinion on
    flagged_responses. The scoping is correct; the stated reason is not.
  - src/lib/admin/suppressions-service.ts:110  (LEFT JOIN users)
  - src/app/api/lead-intake/route.ts:256-286   (owner_leads)
  - the 15 flagged_responses sites — src/lib/moderation/held-draft.ts:18-30 inventories 16
    consumers with four distinct semantics; use it as the map, verify each against the code.

STEP 2 (engine work). Teach scripts/ci/tenant-scope-audit.ts:942 localScopedBindings the two
missing bridge shapes. It knows three today (x.account_id = accounts.id,
x.business_id = businesses.id, the account_offboarding_tokens link). `users` reaches its tenant
by a FOURTH (accounts.owner_user_id = users.id — an inbound FK on the PARENT) and a FIFTH
(users.account_id = businesses.account_id, sibling-through-account, seen at
worker/jobs/summary-report-helpers.ts:241-242).

STEP 3 (only after 2). Invert the completeness query in
scripts/ci/__tests__/tenant-tables.integration.test.ts:52-58. It asks "do the listed tables
have these columns"; it must also ask "does any public table carry account_id or business_id
and appear on neither TENANT_TABLES nor a named REVIEWED_NOT_TENANT_SCOPED list with a reason
string". Four tables fail it today: analytics_events, flagged_responses,
impersonation_sessions, users. Note users.business_id was DROPPED at
034_multi_location_schema.sql:404, so users carries account_id only.

ANTI-PATTERN GUARDS:
  - DOING STEP 3 BEFORE STEP 2 CONVERTS SILENCE INTO 40 SUPPRESSIONS. The order is the ticket.
  - Do not "fix" an unscoped-looking query by adding a join that makes it look scoped —
    batch-view.ts:389-400 names that anti-pattern explicitly.
  - Step 1 alone is a legitimate stopping point and is worth shipping on its own.

EVIDENCE: 01-flowcharts/F8-ci-enforcement-surface.md (the blast-radius table),
02-duplication-report.md (X8, X10), 05-process-findings.md (P4 + the orchestrator correction).
```

## H6 — The truth-and-tripwire bundle

```
Six small independent fixes. Each is one to a few lines plus a test. Bundled because each is
too small to justify a branch and they share one shape: something true is written down
wrongly, or something load-bearing has no tripwire.

(b) IS THE ONLY ONE THAT IS NOT COSMETIC. If the bundle has to shrink, keep (b).

(a) GUARD THE BARE COPY LOOKUP.
    src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx:369 does
    HALT_REASON_LABELS[summary.haltReason] unguarded, rendering `undefined` into the sentence
    for a reason outside the union. ApprovalPanel.tsx:294-297 guards the equivalent lookup with
    Object.hasOwn and explains why at :288-290. The same file already uses the idiom twice
    (:130, :138) and its NOT_HALTABLE_FALLBACK:110-112 reasons about "a server deployed ahead
    of the browser" — the exact scenario it does not cover here.

(b) PIN latchHalt's CAS.
    src/lib/solicitation/approval.ts:479 — deleting `AND halted_at IS NULL` leaves the full
    974-file / 12,705-test suite GREEN. Three tests credit the CAS in their own comments
    (approval.integration.test.ts:1240 with :1264, :2473; approval.test.ts:230 claim 2 at :238)
    and none of them reach it: both halt arms refuse at `state === 'halted'` first (:597, :684)
    against a row already read FOR UPDATE, so latchHalt's {latched:false} branch at :482 is
    unreachable through either public arm. Monotonicity is delivered today by the CALLER'S
    STATE GUARD, not by the CAS the tests credit.
    Why it matters: LatchHaltReason:411 already reserves send_window_elapsed and batch_expired
    for writers #630 has not built, and the arch log says a third halt writer "has one obvious
    place to land." One that lands without routing through lockBatchForAction finds the CAS
    silently absent, and the damage is a second account_audit_log receipt and a second
    batch_halted spine step — an audit trail that lies about who halted and when.
    Add: a concurrency case (two halts in overlapping transactions), or a direct latchHalt test
    over a row already carrying halted_at.

(c) CORRECT THE STALE PURGE CONTRACT.
    worker/jobs/account-offboarding/purge-stages.ts:781-795 ends "Unreachable today
    (recordSuppression has zero production callers, G6); #644/#645/#627 own honouring it when
    they land the first ones." Those tickets landed. Two writers now exist
    (src/lib/solicitation/unsubscribe.ts:402, worker/ingress/resend/solicitation-lane.ts:243)
    and neither references the contract.
    ADJACENT GAP worth a line in the same PR: because the attribution row is cascade-deleted
    (:296-310), a suppression-bearing Resend event for a purged account takes throwUnmatched
    (solicitation-lane.ts:143-149) → 503 → Resend retries forever, and the recipient's GLOBAL
    opt-out — the one thing the purge deliberately preserves (:325-328) — is never written.

(d) ONE SENTENCE ON THE PURGE'S LOCK ORDER.
    The batch→run order that src/lib/solicitation/approval.ts:35-41 depends on
    ("Taking the run lock first is an ABBA deadlock against the offboarding purge", echoed in
    outreach.ts:169-181 and batch-builder.ts) is documented on ONE side. purge-stages.ts:396-402
    carries only an FK-ordering rationale. A reviewer moving agent_runs earlier would satisfy
    every comment in that file and invert an order three other files depend on.

(e) ADD business_id TO recordFailure'S LOG.
    worker/ingress/resend/solicitation-lane.ts:390-396 logs outreach_id + account_id +
    has_reason. The four sibling blocks (:298, :328, :356, :368) all log business_id.

(f) BRING auth-island.css INSIDE A GUARD.
    src/components/auth/auth-island/auth-island.css:5-15 redeclares 8 Island colours and 2
    brand fonts under .rw-auth, in a directory that design-scope-purity.test.ts and
    design-token-single-source.test.ts do not watch. THE TWO FONT FAMILIES HAVE ALREADY
    DIVERGED — :14-15 drops the 'Plus Jakarta Sans'/'DM Sans' named fallbacks and the
    -apple-system/Segoe UI/Roboto chain that globals.css:121-122 carries. Either bring the
    directory into the guard's scope or make the guard walk dynamically as it already does for
    Landing (cssFilesUnder).

ANTI-PATTERN GUARD: do not turn (a) and the five existing Object.hasOwn sites into a shared
helper. Three lines each; the tables they guard are the real content. The finding is the sixth
site that omits it, not the five that have it.

EVIDENCE: 06-guard-integrity.md (N1 → item b), 02-duplication-report.md (X2, X4, X5, W8),
01-flowcharts/F6-F7-design-system-and-marketing.md (item f).
```

## H7 — Count the governance surface; stop the Stop hook from eating a measurement

```
Two process fixes. The first is the pass's headline process finding; the second was found by
this pass ON this pass.

PART 1 — ci:merge-ledger.
The arch counter reads 8. Its own stated rule ("it has production lines",
.claude/reference/arch-review-log.md:73-76) yields 11 for this window. #857, #866 and #875 got
no post-merge sweep at all. Nine FURTHER merges rewrote the enforcement surface with zero trace
in 628 lines of log — including #849, which deleted .github/workflows/fallow.yml and rewrote
src/__tests__/ci-audit-wiring.test.ts, the test that exists to stop exactly that drift.
The 2026-08-15 pass framed PR #803 (which deleted /feature's entire step 8, 667 → 207 lines) as
an anomaly. It is the norm.

Build ONE audit with TWO triggers, and run it on the MERGING PR — not the post-merge sweep,
because "the sweep did not run" is the failure mode:
  (i)  the diff has non-test production lines, OR
  (ii) the diff touches the GOVERNANCE PATH SET —
       .agents/skills/**, .claude/skills/**, .claude/hooks/**, .codex/hooks/**,
       scripts/verify-gate.sh, scripts/feature-*.sh, scripts/arm-check.sh, lefthook.yml,
       .github/workflows/**, scripts/ci/**, package.json
  ⇒ the PR must add a line to .claude/reference/arch-review-log.md.
The path list catches #803's class with NO line-counting judgement at all, which is why it is
the cheapest rule that works.

PART 2 — the mutation/lint-hook conflict.
While this pass's guard-integrity census held invariant #3's auto-policy conjunct deleted at
worker/jobs/publisher/auto-policy-publish.ts:489, the Stop hook (typecheck-on-stop.sh) reported
the orphaned APPROVAL_METHOD import as an eslint error and demanded a fix before the turn could
end. THE MECHANICALLY OBVIOUS FIX — delete the unused import — PERMANENTLY REMOVES A POSTING
PRECONDITION. A lint-on-stop hook cannot distinguish a measurement from a mistake, and its
literal remedy opens a hole in invariant #3.
Cheapest fix: a mutation sentinel file (e.g. .feature/mutation-in-progress) that the hook skips
on, created and removed by any mutation-running agent. Alternative: the hook reports rather than
blocks when the only findings are unused-symbol errors in a file with an uncommitted
single-hunk diff.

NOT IN THIS TICKET, both real, both deserve their own:
  - ci:agent-config has no self-test anywhere in the repo, and its skill-size check is a
    CEILING, not a floor — #803's 667 → 207 line deletion passes it (P3).
  - Issue #877's filed diagnosis is wrong. verify-gate.sh:120-130 provisions SERIALLY before
    the first parallel launch at :167; there is no in-gate race. The real cause is already
    recorded at .claude/reference/lab-notes.md:19 — ONE test-DB container shared by every
    sibling worktree, and scripts/test-db-setup.sh:45 takes no lock. The repo currently carries
    both diagnoses (P5).

EVIDENCE: 05-process-findings.md (P1, P2, P5, P6 + the carry-forward table).
```
