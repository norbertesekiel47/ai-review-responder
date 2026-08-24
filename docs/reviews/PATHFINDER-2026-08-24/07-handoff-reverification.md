# Handoff re-verification — 2026-08-24

Every handoff left open by the 2026-08-18 and 2026-08-22 passes, re-derived from
current source at `main` @ `0278366c`. **Merge titles were not trusted.** Each
row was verified by reading the code the handoff demanded.

## Status table

| ID | Demanded change | Present at HEAD? | Evidence | `gh` state | Verdict |
|---|---|---|---|---|---|
| #890 H1 | Named leaf owning the delivery-status subsets | yes | `src/lib/solicitation/delivery-status.ts:26,31,35,39,49` | closed | **CLOSED** |
| #891 H2 | One positive `batchDidClose`, adopted at four wire sites | **3 of 4** | `outreach.ts:269-274`; missing at `approve/route.ts:60` + `approval.ts:448` | closed | **CLOSED-BUT-DEFECTIVE** |
| #892 H3 | One owner for the purge tombstone sentinels | no | zero hits for `PURGE_TOMBSTONE_SENTINELS` | open | **OPEN (unchanged)** |
| #893 H4 | Sequence admin fan-outs; replace pins with a rule | yes | `scripts/ci/pool-fanout-audit.ts`, wired in all three places | closed | **CLOSED** |
| #894 H5 | Tenant-scope comments, then `PLATFORM_TABLES` | no | false reason verbatim at `pending-count.ts:29-30` | open | **OPEN (unchanged)** |
| #895 H6 | Six-item truth-and-tripwire bundle | (b) only | five items live, see below | open | **OPEN (5 of 6)** |
| #896 H7 | `ci:merge-ledger` + Stop-hook sentinel in BOTH hooks | yes, both | `.claude/hooks/…:65-68` **and** `.codex/hooks/…:59-62` | closed | **CLOSED** |
| 08-22 PR1 | Three send-lane integrity tests | yes, all three | `dispatch.integration.test.ts:1970,1982,2072,2155` | — | **CLOSED** |
| 08-22 PR2 | `canonicalBatchId` at both entry points | yes | `ask-generation.ts:1337`, `:1617` | — | **CLOSED** |

**Five of nine genuinely closed. One closed with a live defect. Three untouched.**

---

## #891 — incomplete adoption. Latent, NOT a live defect.

> **Correction, made during this pass.** The first draft of this section called
> the approve path a live wire defect. **That was wrong, and the error is
> recorded rather than deleted** because the reasoning that produced it is the
> reasoning a future reader will repeat. See "Why the first reading was wrong"
> below.

`batchDidClose` exists and works (`outreach.ts:269-274`). Both halt routes and
the withdraw route adopted it with explicit `#891` comments. **The approve path
never did** — it still launders the union through the negation the predicate was
built to replace:

- `approval.ts:448` — `close: close.status === 'not_settled' ? null : close`
- `approve/route.ts:60` — `closed: result.close !== null`

The status that makes the negation wrong is `no_send_parent` (`outreach.ts:445`),
and `batchDidClose`'s docstring at `outreach.ts:256-261` names it exactly:
*"`!== 'not_settled'` is a wrong proxy: `no_send_parent` means nothing was
written … yet it passes the negation, so [the route] would report `closed: true`
while `send_closed_at` stays NULL."*

### Why the first reading was wrong

`no_send_parent` is **unreachable from `approveBatch`**. Two guards make it so:

1. `approveBatch` refuses a batch with no send parent 130 lines before the close
   call — `approval.ts:305-308` returns
   `{ status: 'not_approvable', reason: 'no_send_parent' }`.
2. That `send_parent_run_id` comes from a subquery at `approval.ts:209-219`
   whose predicate is **identical** to `closeBatchIfSettled`'s own parent lookup
   at `outreach.ts:430-439` — same `kind`, `subject_type`, `subject_id`,
   tenant columns, and `ORDER BY started_at DESC LIMIT 1`.

So a non-null `send_parent_run_id` guarantees `closeBatchIfSettled` finds the
same row. The other divergent status, `closed_without_parent`, needs
`input.failure`, and `approveBatch` passes none (`approval.ts:437-441`).

On every status the approve path can actually produce — `not_settled`, `closed`,
`already_closed` — **the negation and `batchDidClose` agree**. There is no wrong
answer reaching any browser today.

### What the real finding is

The approve route is correct **by distance**, not by construction. Its
correctness rests on a guard 130 lines away in a different function, and nothing
states the dependency. Three things make that worth closing cheaply:

- It is the exact anti-pattern the predicate's own docstring was written to
  eliminate, surviving in the one place the predicate was not applied.
- If the `:306` guard were ever relaxed — say to let an all-withheld batch be
  approved and closed in one step — approve would silently begin reporting
  `closed: true` with `send_closed_at` NULL, and nothing would catch it.
- The approve route's `closed` field has **zero test coverage** (below).

Rank it as cheap hygiene with a real latent edge, not as a bug. The handoff
prompt's second half, "drop `approval.ts:466`'s ternary", is unshipped. The
requested non-adoption note for the release tally **did** land correctly
(`release.ts:401-404`), so the author was working from the right prompt and
stopped one site short.

The handoff prompt's second half, "drop `approval.ts:466`'s ternary", is
unshipped. The requested non-adoption note for the release tally **did** land
correctly (`release.ts:401-404`), so the author was working from the right
prompt and stopped one site short.

### The test evidence makes this worse, not better

A regression test for this exact defect **exists**:
`approval-routes.test.ts:375` — *"reports closed: false when the close wrote
nothing (no_send_parent) — #891"*. Its comment even names the reachable case:
an all-withheld `built` batch has no send parent, so `closeBatchIfSettled`
answers `no_send_parent`, nothing is written, and the old negation proxy
reported `closed: true`.

**That test sits inside `describe('POST …/batch/halt')` (line 297) and calls
`HALT()`.** It covers the halt route only.

The approve route's own `describe` block (line 219) contains five tests —
send-mode off, subscription gating, trialing access, missing location scope,
cross-origin — and **not one of them references `close` or `closed`**. The
approve route's `closed` wire field has zero test coverage.

So the team understood the defect precisely, wrote the predicate, wrote the
docstring that specifies it, wrote the regression test, adopted it at three
sites — and the fourth site kept the negation and was never tested. This is not
a knowledge gap. It is a completeness gap, and it is the kind a checklist
closes and a test suite does not.

## #892 — OPEN, unchanged

No sentinel constant anywhere. Seven writer/verifier literal pairs remain
byte-duplicated across `purge-stages.ts:657-696` and
`purge-verification.ts:113-161`: `'Deleted location'`, `'Deleted owner'`,
`'professional and friendly'`, `'[]'::jsonb`, `'Deleted account'`,
`'Deleted user'`, and the `deleted-<id>@repworth.invalid` shape.

Counted at HEAD: the `businesses` OR-chain is **28** predicates
(`purge-verification.ts:113-150`) against 28 tombstone columns plus
`updated_at`. `docs/directory.md:1221` still says 27, and still claims `tone` is
the only restored column when `tracked_keywords = '[]'::jsonb` is the second
(`purge-stages.ts:672`).

The 08-22 refutation still holds — `tracked_keywords` is `NOT NULL`, so the
`<>` comparison is sound. The issue text has not been corrected.

## #894 — OPEN, unchanged

`pending-count.ts:29-30` still carries the false reason the backlog said to pull
forward: "The explicit `JOIN businesses … account_id` scope is what the
tenant-scope audit requires for an account-wide read."

Step-1 production adoption is still exactly one (`batch-view.ts:399`).
`suppressions-service.ts:116`'s `LEFT JOIN users` still carries no comment.
Steps 2–3 untouched: no `PLATFORM_TABLES`, no `REVIEWED_NOT_TENANT_SCOPED`, and
`scripts/ci/rls-audit.ts:12` is still `REQUIRED_RLS_TABLES = TENANT_TABLES`.

## #895 — OPEN, five of six live

Item (b) confirmed delivered pre-window. The rest:

- **(a)** `HALT_REASON_LABELS[summary.haltReason]` at
  `SolicitationBatchPanel.tsx:343` is an unguarded index. The map at `:55-63` is
  total over the now-six-member `HaltReason` including `platform_halt`, so the
  residual exposure is the cached-browser case only — but the file's own two
  `Object.hasOwn` guards are still not applied here.
- **(c)** `purge-stages.ts:794` still says "recordSuppression has zero
  production callers". There are **four**: `contacts-repo.ts:250`,
  `unsubscribe.ts:402`, `suppressions-service.ts:174`,
  `solicitation-lane.ts:243`.
- **(d)** `purge-stages.ts:391-395` gives only the FK rationale for
  outcomes-before-runs; the dependent side (`approval.ts:42-46`) is unnamed.
  Note the *other* lock-order comment at `:270-273` is correctly two-sided — do
  not mistake it for (d).
- **(e)** `recordFailure`'s log at `solicitation-lane.ts:456-462` omits
  `business_id`; its sibling at `:425-431` logs it.
- **(f)** `src/components/auth/auth-island/auth-island.css:6-15` re-declares 8
  colour and 2 font tokens. `design-scope-purity.test.ts:32-34` scopes to
  `globals.css`, `sections/landing`, `(public)/_styles` and
  `(authenticated)/_styles` — `src/components/auth/**` is in none of them.

---

## Did the window make anything worse?

**No — nothing with file:line evidence.** Two stale references worth folding
into the next touch of those files, neither a behaviour regression:

- `src/lib/costs/tracker.ts:83` cites "`canonicalBatchId`
  (src/lib/solicitation/approval.ts)". PR2 moved the owner to
  `src/lib/solicitation/outreach.ts:94`.
- `src/lib/solicitation/approval.ts:467` asserts "ALREADY canonical" in prose
  only. The claim is now true across both files, but nothing mechanical holds it.

## One deviation worth recording as a credit, not a defect

`isTerminalizableArrival` was **not** exported from the leaf as the H12 prompt
asked. `worker/jobs/solicitation-send/failed-hook.ts:94-97` keeps it local and
pins it to `DISPATCHED_ARRIVAL_STATUSES` with a two-way `satisfies` (`:83`,
`:95`). That is a **stronger** mechanical binding than the prompt requested. The
author improved on the instruction; the log should say so rather than record a
miss.
