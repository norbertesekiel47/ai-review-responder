# Plan review — round 2 (verification-only, codex, read-only)

**VERDICT: REVISE** · 3 findings not landed (F5 NO, F9 NO, F8 PARTIAL) + 2 defects
introduced by fixes · dispatched via direct `codex exec --sandbox read-only --json`
Raw transcript: session scratchpad `codex-plan-round2.jsonl` (session-scoped; the
findings are reproduced in full below, which is the durable copy).

Mandate: for each of F1–F9, did the fix reach the **checkboxed step a subagent
executes** — not merely the plan's discussion? Plus: did any fix introduce a defect?
New fronts against unchanged sections were out of scope; none were raised.

## Verification table

| # | Landed? | Evidence | Verdict |
|---|---|---|---|
| F1 | YES | Task 1 authors every body + runs the response-generation suite; locked title exercises real `persistResponseAndNotify` (`intake.json:129`); copied fast-check predicate demoted to regression | — |
| F2 | YES | Race + simultaneous-click titles locked (`intake.json:130-131`); D2 defers the fix; `process-review.ts` fence respected — Task 3 edits only routes/tests | — |
| F3 | YES | SQL emits `is_orphan` + orphan fields; both LATERALs inside the paginated query; Step 2a deletes query/binding/merge/import; `groupReplies` takes one array; counts include every no-posted-sibling review | **but see Defect A** |
| F4 | YES | D3 records 37→50; 3 poller titles present (`intake.json:135-137`); Task 1 creates the suite, Task 3 runs it | — |
| **F5** | **NO** | Fix existed **only** in the Round-1 appendix. Task 3's poller still returned every non-terminal draft as `ready` **with text**; Task 4's draft LATERAL had no held check. A subagent executing verbatim exposes moderation-held content — invariant #4 | **ACCEPT** |
| F6 | YES | Consumer title locked (`intake.json:139`); Task 7 states missing entry → no counter, button enabled | — |
| F7 | YES | Executable SQL carries the total order `ORDER BY (resp.id IS NOT NULL), r.review_date DESC, r.id DESC` | — |
| **F8** | **PARTIAL** | `editRepliesEnabled()` collapse + call-site renames landed. But the live-reference sweep was appendix-only: Task 8 Step 4 grepped `docs/` and never instructed edits to `.claude/reference/review-ingestion.md`, `.claude/reference/lab-notes.md`, `scripts/ci/process-env-baseline.ts` — the three files D1 widened the surface *for* | **ACCEPT** |
| **F9** | **NO** | Title locked (`intake.json:140`) but Task 1 created only a normal `route.test.ts`; its sole `*.integration.test.ts` was the list-query suite. The live-Postgres requirement existed only in the appendix | **ACCEPT** |

## Defects introduced by a fix — both ACCEPT

**Defect A — F3's single-query merge silently breaks orphan recovery.** Task 4 now
emits `orphan_failed_response_id` / `orphan_posting_error` / `superseded_text`, but
Task 5 deleted `toOrphanCardRow` without specifying the replacement mapping. That
mapper (`replies-view.ts:100-117`) fed `failed_response_id` — which is exactly what
`PastReplyCard` reads to decide a row is recoverable (`:157`
`!!row.failed_response_id && row.posted_at === null`) and to gate the recovery
actions (`:201`). An orphan would classify as `recover` and then render without the
identifier needed to open or execute recovery.

*Verified independently before accepting:* both cited loci read as described.

**Defect B — no representable "held, no affordance" row state.** F5's accepted fix
requires held reviews to sit in `Unanswered` with no affordance, but the executable
five-state union falls back to `generate` when no draft/outbox/posted/orphan marker
is present, and Task 7 switched over those five only. Filtering the held draft from
the LATERAL therefore offers `Generate`; retaining it offers `Draft ready`. Neither
satisfies the fix — and `Generate` is actively harmful, since the partial unique
index (023+026+029) would reject the resulting job after the LLM spend.

## Rejected / not adopted

- **Round 1's "use `hasOpenFlag`" wording** — not adopted as written. Its signature
  is `(tx: TransactionSql, responseId)`, an in-tx post-`FOR UPDATE` release gate;
  neither new site is a transaction, and `held-draft.ts` is outside
  `allowed_edit_surface` (a helper there would burn amendment 2 of 2 → abort
  criteria). Both sites spell the `EXISTS` inline naming `held-draft.ts` as the
  semantic owner; consolidation is a #680 item. See deviations **D6**.
- **Cosmetic — stale "37 titles" at Task 1** (reviewer flagged, correctly, as not
  grounds for REVISE). Fixed to 52 anyway.

## Fixes applied — all in the executable steps, not an appendix

| Finding | Applied at |
|---|---|
| F5 | Task 3 poller (`EXISTS … AS held` → `{status:'idle'}`), Task 4 draft LATERAL carries `held`, Task 5 `held` state |
| F8 | Task 8 Step 4 — three checkboxes for the live refs, with `pnpm ci:process-env` after the baseline edit |
| F9 | Task 1 creates `generate-version.integration.test.ts` (+ live-DB conventions) |
| Defect A | Task 5 field-mapping table carrying `toOrphanCardRow`'s behaviour into `toCardRow` |
| Defect B | Sixth `held` state; `draft_held` branched on the same test as `draft_ready`; Task 7 renders a non-actionable row with a `never` default |

New deviations: **D6** (inline predicate), **D7** (the process finding), **D8**
(2 titles, 50→52), **D9** (`held` as new user-visible behavior — owner ratification
pending, nothing blocks on it).

## The systematic finding — worth more than any single item

Four of nine round-1 fixes (F3 partially, F5, F8, F9) never reached a checkbox;
they lived in the `# Round-1 revisions` appendix. F3's was caught by the
orchestrator pre-dispatch, F5/F8/F9 by this round. The failure is structural, not
careless: an appendix entry reads as "addressed" at every later checkpoint —
including to the reviewer who raised it — because the plan demonstrably discusses
the fix. Nothing distinguishes *described* from *applied* without opening the
owning task.

Recorded as deviations **D7** for promotion to lab-notes at step 8, since it is a
`/feature` workflow lesson rather than a #678 one.

## Round budget

Plan review rounds: **2 of 3 used.** Round 3 is the last and is verification-only
over this table. Its brief must apply the D7 test: *if a subagent executes only the
checkboxes of the owning task, does the fixed behaviour result?* After round 3,
per feature.md, remaining disagreement goes to the owner — their call substitutes
for APPROVED.
