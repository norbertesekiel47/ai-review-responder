# Branch review round 2 — adversarial verification (#629 owner approval lane)

**Scope:** verification of the four findings Codex raised in the round-1 adversarial pass, and
whether the fix commits introduced anything new. **Not** a fresh adversarial review — round 1
owns unchanged code and that job is closed. Observations outside the four findings are in the
untriaged appendix and are not findings.

**Fix commits under review**

| Commit | Subject | Finding it answers |
|---|---|---|
| `b7299e2f` | writer — case-safe parent lookup, parentless batch, refusal ordering | (other round-1 axes) |
| `55e9744d` | read model — decorrelate send-lane counts, extract `readSendLane`, type `haltReason` | 3 |
| `564129d1` | panel — render approved copy, honest failure states, haltable gating | 1, 2 |
| `bf3d76d0` | docs — strike the copied-and-false FK lock premise at all three sites | (other round-1 axes) |
| `351b8fb4` | requests — read-scoped load-failure copy; record D11–D14 | 2 (second half) |

**Reviewer stance:** review only. No production file was edited in this pass.

## Gates re-run in this worktree (not inherited)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` (full, live-DB lane awake against `test_629`) | pass — 963 files, 12,376 tests, 1 file / 11 tests skipped |
| `pnpm ci:tenant-scope` | pass — 392 entries, baseline 392 (no new allowlist entry) |
| `pnpm ci:static-policy` | pass — 1,151 files |
| `pnpm ci:db-imports` | pass (strict) |
| `pnpm ci:live-db-suites` | pass |
| `pnpm ci:directory-map` | pass — 550 files, no missing or stale rows |

Working tree clean at `351b8fb4`.

---

## Findings table (≥80% confidence, `file:line`, concrete failure scenario)

*(empty — no defect introduced by the five fix commits clears the bar)*

---

## Per-finding verdicts

### Finding 1 — owners approve message bytes the UI never displays — **FIXED**

Both halves verified, and I checked the required half before the forbidden one, because a
verification that only proves absence is what let this ship.

**Half one — safe content is visible.**
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-629-owner-approval-lane/src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:72-85`
— `toRows` now carries `subject` and `body` for the unredacted arm.
`AskList.tsx:129-140` renders them (`AskMessage`), with an explicit "No message was written for
this contact." arm so a bodyless row and a hidden row do not read alike. The copy is rendered in
`approvable` (`SelectableAskList`, sendable rows) and in `haltable` / `halted` /
`nothing_to_send` (`AskList`, all unredacted rows) — `ApprovalPanel.tsx:537-548`.

**Half two — flagged content stays absent.**
`toRows` drops `attempt.redacted` before any component sees it, and `AskRowView`
(`AskList.tsx:56-62`) has no redacted arm at all, so the projection is a `tsc`-enforced choke
point rather than a habit. `moderation_high` still surfaces only as
`sendLane.moderationWithheld` beside the verbatim reason chip (`ApprovalPanel.tsx:554-560`).

**Test quality — the part that actually matters here.**
`__tests__/approval-panel.test.tsx:183-222` asserts *both* halves in one case, and the redacted
fixture is `leakyRedactedAttempt` (`:122-128`) — a shape the type forbids and the read model
cannot produce, cast in deliberately. That is the right construction: it proves the projection
drops the bytes rather than proving the type made the fixture unwritable. Absence is checked
against `document.body.innerHTML`, so attributes and React keys are covered, plus the contact
name and the outreach id. `:224-240` repeats both halves on a settled (`veto_window`) batch, and
`:467-493` on a `halted` one.

Read-model side re-confirmed unchanged: the SQL `CASE` redaction and `toAttempts`' second layer
are both still in place (`src/lib/solicitation/batch-view.ts:391-419`, `:278-318`), and
migration 108 keeps `moderation_high` pinned to `withheld`
(`supabase/migrations/108_outreach_owner_excluded_disposition.sql:35-38`), so the panel's
`deliveryStatus === 'rendered'` sendable filter cannot pick one up.

### Finding 2 — lost approval responses falsely tell owners nothing changed — **FIXED**

**The write path.** `ApprovalPanel.tsx:338-363` — only `response.ok || 400 || 409` is read for a
discriminant; every other non-2xx, and every throw (transport failure, an unreadable body, a
204, an HTML login page returned as 200), returns `{ kind: 'unconfirmed' }`. `:453-456` hands
that up as `onChanged(UNCONFIRMED_OUTCOME, 'unconfirmed')`, which claims nothing and triggers the
parent's `retry()`; no error box is set, so the "Nothing changed" sentence is unreachable from
this path. Note this is strictly better than the old code in both directions: a 200 whose body
failed to parse used to fall into the catch and claim "Nothing changed" too.

**"Nothing changed" is now sound where it survives.** I enumerated the 400/409 producers:
`approve/route.ts:69-72` (409 `not_ready`/`not_approvable`, 400 `unknown_exclusion`),
`halt/route.ts:55-56` (409 `not_haltable`), and the pre-handler gates in
`_shared/scoped-batch-route.ts:100-113`. Every one of them is reached before any mutation —
`approveBatch` validates the exclusion list at `approval.ts:279-292` and only then runs the
`UPDATE` at `:294-305`. A 400/409 with an unrecognised body degrades to `GENERIC_REFUSAL`, which
is still honest for the same reason. 404 (`not_found`) falls into `unconfirmed`, which is
conservative rather than wrong.

**Type totality.** `LaneStatus` is derived from `ApproveBatchResult['status'] |
HaltBatchResult['status']` (`:281`) and `LANE_REFUSAL_COPY` is a total `Record` over it, so a new
refusal discriminant is a `tsc` error in the panel instead of silent generic copy. Confirmed by
`pnpm typecheck`.

**Retry stays available.** `refusalCopy` leaves the button enabled
(`__tests__/approval-panel.test.tsx:534-592`), and both verbs are genuinely idempotent — approval
is CAS'd on `approved_at IS NULL` (`approval.ts:311-336`) and the halt latch is monotone
(`:432-443`).

**Tests.** `approval-panel.test.tsx:555-592` covers transport failure and a 500 for both verbs,
asserting no "Nothing changed", the `unconfirmed` outcome, and an enabled retry.
`requests-client.test.tsx:534-564` covers the integrated behaviour: the sentence renders as a
`role="alert"`, is *not* duplicated into the polite live region, and a fresh authoritative read
is issued.

**The related hole — read-scoped load-failure copy: FIXED.**
`RequestsClient.tsx:167-182` now reads "We could not read the latest state of this batch. That
does not tell you whether anything changed — try again." The write-scoped promise is gone; a
repo-wide grep finds no remaining "Nothing was sent, and nothing changed" outside a comment.
One durability gap, recorded rather than tabled: **no test pins this copy.** The existing case
(`requests-client.test.tsx:208-223`) only matches `/could not load/i`, which the old
write-scoped body also satisfied, so re-adding the promise would fail nothing.

### Finding 3 — the send-lane aggregate can multiply a large batch into ~25M rows — **FIXED**

**The query.** `batch-view.ts:373-514` — `readSendLane` now issues four statements: Q4 attempts
(unchanged), Q5 the lifecycle row and nothing else (`:436-447`), Q6 pending renders on
`solicitation_asks` with a single anti-join (`:464-478`), Q7 moderation-withheld on
`solicitation_outreach` alone (`:484-491`). The `mo` relation that correlated only to `b.id` is
gone, and no `COUNT(DISTINCT)` remains in the send lane. Semantics are preserved exactly: with
`o.id IS NULL` each ask survives once so `COUNT(*)` equals the old `COUNT(DISTINCT a.id)`, and
`mo.id` is a PK so `COUNT(*)` equals the old `COUNT(DISTINCT mo.id)`. The old `mo` join carried
no `delivery_status` filter either, so Q7's deliberate omission is not a behaviour change —
and 108's status↔reason CHECK makes it unobservable regardless.

**Does the guard pin the property? Mostly yes — and the fixing agent's caveat is honest but
slightly narrower than stated.**

The guard is `batch-view.test.ts:468-527`. It is stronger than "a statement-shape assertion"
sounds:

- Q5 must contain `FROM solicitation_batches b` and must *not* contain `solicitation_asks`,
  `solicitation_outreach`, `COUNT(`, or `GROUP BY` — which is precisely the shape the regression
  needs, so reintroducing it fails four assertions.
- Q6 and Q7 pin their base relation, and — the load-bearing part — pin their **exact bind
  parameter arrays** (`:513-515`, `:522-524`). Any added tenant-scoped relation adds parameters
  (invariant #8 requires the keys) and fails.
- `tx.mock.calls` length 8 (`:526`) blocks merging the statements back together.

The residual hole: `pendingQuery` does not forbid a *second* join, so a cross-join added inside
Q6 that reuses only existing bind parameters would evade it. Narrow and contrived, but real.

The caveat as written — "no data-driven test can fail against the old query" — is true of
*value*-driven tests and I confirmed it: the new
`batch-view.integration.test.ts:453-492` seeds 3×2 by construction and asserts 3 and 2, which the
old `COUNT(DISTINCT)` query would also have returned. But a **cost**-driven test was available
and would have pinned the property behaviourally: the suite already runs
`EXPLAIN (ANALYZE, BUFFERS)` with a wall-clock budget for Q3
(`batch-view.integration.test.ts:561-685`), and the same machinery pointed at the lane with a
seeded N×M (e.g. 5,000 asks × 500 held rows) would have blown the budget on the old shape. The
perf case as written seeds asks only and no outreach rows, so it does not exercise the lane
counts at all. Recommendation, not a finding: extend the perf case with held outreach rows and
assert the same budget, which converts the guard from shape to cost.

### Finding 4 — discarding an unapproved batch is recorded as a veto — **RESOLVED BY DECISION**

Verified as an owner contract amendment, not a code change, exactly as described.

- `edge_cases[7]` now reads `owner_veto` with the reasoning and the D11 reference inline, in
  **both** intake copies —
  `docs/superpowers/plans/feat-629-owner-approval-lane-intake.json` and the gitignored working
  copy `.feature/intake.json`. `diff` reports the two files **byte-identical in full**, not just
  in that field.
- `tests_to_add[18]` is unchanged (`property: the owner halt reason is owner_veto exactly when
  sending has not started`), so the intake no longer contradicts itself.
- `ownerHaltReason` is unchanged (`src/lib/solicitation/approval.ts:61-63`) — not re-flagged.
- D11 is recorded at
  `docs/superpowers/plans/feat-629-owner-approval-lane-deviations.md:457-475`, including the
  correction of the earlier "Codex is right, the code is wrong" note.

**My own read of the decision, offered because it was invited and for no other purpose:** the
decision is right. CONTEXT.md defines a veto as halt at zero sends, and the derivation
`state === 'sending' ? 'owner_halt' : 'owner_veto'` keys on the only fact the audit trail cares
about — whether email may already have left. A never-approved discard is zero sends, so
`owner_veto` is the accurate record; filing it as `owner_halt` would make the audit trail imply
a drip that never started. The only thing I would keep an eye on is that `owner_veto` now covers
two operationally different acts (discard-before-approval, undo-inside-the-window). The owner
copy already distinguishes them by batch state rather than by reason
(`ApprovalPanel.tsx:190-200`), so nothing is lost today; if #630 ever needs to tell them apart in
analytics, `approved_at IS NULL` on the halted row is the discriminator, and it is already
stored.

---

## Did the fixes introduce anything new?

No defect clearing the bar. Specifically checked:

- **Invariant #1 / ESLint boundary.** `ApprovalPanel.tsx:5` adds `import type { ApproveBatchResult,
  HaltBatchResult } from '@/lib/solicitation/approval'` — type-only, erased at build, and
  `pnpm lint` (which enforces the boundary) passes.
- **Invariant #8 / tenant scope.** Q6 and Q7 carry both keys at the top level of a `WHERE` or a
  `JOIN … ON`; `ci:tenant-scope` holds at 392 entries with no new allowlist entry.
- **`readSendLane`'s throw** (`batch-view.ts:452-454`) is pre-existing, and unreachable: Q1
  selected the batch under the same tenant predicates inside the same REPEATABLE READ snapshot.
- **Render gating.** The only render change is that `nothing_to_send` now shows the list;
  `approvable` still shows `sendable` only, unchanged.
- **`bf3d76d0` and the `ApprovalActions` header** are comment-only, and both corrections are
  substantively right — approval.ts genuinely does not hold an `agent_runs` lock before
  `recordStep`, and `ApprovalActions` is not the only file in the lane rendering a control
  (`SelectableAskList` has the checkbox).
- **Whole-suite regression.** `pnpm test` green at 12,376 tests.

---

## Untriaged appendix (NOT findings — outside the round-2 mandate)

1. **The unconfirmed banner never clears on its own.** `RequestsClient.tsx:79-98, 133-137` — the
   lane sentence is cleared only by `onRetry`, a scope switch, or a later settled write. After an
   unconfirmed approve whose refetch then succeeds, the `role="alert"` banner keeps saying
   "Reloading the batch now" beside a screen that has finished reloading. It claims nothing false
   about the write, so it does not touch finding 2's property; it is stale, not dishonest.
2. **`LANE_REFUSAL_COPY.not_found` is unreachable copy.** `ApprovalPanel.tsx:305` — both routes
   answer `not_found` with a 404, which `postLaneAction` routes to `unconfirmed`, so this string
   can never render. The `Record` needs the key for totality; the sentence could be `null`.
3. **`COUNT(DISTINCT a.id)` survives at `approval.ts:255`.** Different statement (the readiness
   gap in `approveBatch`), not the send-lane aggregate, and not a cross product — with
   `o.id IS NULL` each ask survives once, so the `DISTINCT` is a redundant no-op rather than a
   correctness crutch. Noted only because the fix claim says "no `COUNT(DISTINCT)` remains", which
   is true of the send lane and not of the file next door.
4. **`settled`-mode summary counts unredacted rows only.** `ApprovalPanel.tsx:550-552` — a finished
   batch with 2 sendable and 1 held row reads "2 messages in this batch" above "1 message held by
   the safety check". Consistent with D6a, mildly odd arithmetic for a reader.
5. **D12's `resume` sub-issue is still open** by owner decision
   (`…-deviations.md:495-507`): the glossary bans a word in owner copy that the intake requires in
   owner copy. Recorded there, cosmetic, unchanged by this round.
