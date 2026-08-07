# Handoff — #679 Import consent worker guard

**Written at the step 3→4 boundary, 2026-08-07.** Everything below is a pointer;
nothing here restates content that lives in a file. A resumed session needs only
this doc, then the files it names.

## Current position

**Step 3 complete — plan APPROVED.** Next action: step 4, dispatch T0.

| Fact | Value |
|---|---|
| Branch | `feat-679-import-consent-worker-guard` |
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-679-import-consent-worker-guard` |
| Base | `main@2f369582` |
| Risk / surface | high / mixed, DB-touching |
| Plan review rounds used | **2 of 3** (`APPROVED` at round 2) |
| Surface amendments used | **0 of 2** |
| Gate | green, `docs_only` mode (no implementation exists yet) |

## Artifacts by path

| What | Path (relative to worktree root) |
|---|---|
| Intake contract (locked, owner-signed) | `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json` |
| Implementation plan | `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` |
| Round-1 review + orchestrator triage table | `docs/reviews/feat-679-import-consent-worker-guard/plan-review-round-1.md` |
| Round-2 verification review (`APPROVED`) | `docs/reviews/feat-679-import-consent-worker-guard/plan-review-round-2.md` |
| Design of record | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.1, §5.3 |
| ADR | `docs/adr/0015-consented-import-unflagged-replacement.md` §2, §3 |
| Machine state | `.feature/state.json` |

## Glossary excerpt to hand every subagent

From `CONTEXT.md` — use these terms verbatim, never paraphrase:
**Review import**, **Import consent**, **Import offer**, **Import window**,
**Live-ingest cutoff**. `src/lib/reviews/import-consent.ts` is the SINGLE owner of
the derived-expiry predicate and of every consent write; #679 **consumes** it and
must not re-spell its guard.

## The one thing not to re-derive

Round 1's blocking finding: an **unserialized** consent guard permanently loses an
accepted import. The guard must run inside `sql.begin` with `SELECT … FOR UPDATE`
on `businesses` and its `markOutboxCompleted` **in that same transaction**, in
business-before-outbox lock order. Full interleaving and the lock-order proof are
in the plan §2 and round-2 report; do not re-litigate, and do not "simplify" the
transaction away.

## Dispatch order (plan §4)

```
T0  (alone — enforcement spot check)
 ├─ T1 ─── T2
 ├─ T3 ─── T4
 └─ T5
```

Wave 1: T0 alone; then diff `git status --porcelain` against
`allowed_edit_surface` before dispatching anything else.
Wave 2: T1, T3, T5 in parallel. Wave 3: T2, T4 in parallel.

## Known traps recorded during planning

- `.claude/CLAUDE.md` and the #679 ticket comments cite a nonexistent **"ADR 0015
  R2"**. The ADR has §§1–4; R2 is spec §8a:301 and governs different ticket
  ordering. Fix CLAUDE.md in the post-merge sweep (deviation D7).
- Spec §5/§5.3 still say **three** enqueue producers; source has **four**
  (deviation D8). Spec is outside `allowed_edit_surface` — sweep, don't patch.
- The ticket comments' "27 existing backfill tests" is stale. Real count on this
  base: **35 tests / 30 `pushImportSqlSetup` call sites**, plus **three** tests
  that hand-queue SQL outside the helper (plan T0 lists them).
- Migration head is **101**; 102 is free but #680 wants the same slot.
- `worker/__tests__/helpers/mock-sql.ts` already supports `sql.begin` with
  `inTransaction` tracking on `sqlCalls` — the transactional guard needs no live DB
  to unit-test. Use `sqlCalls`, never `mockSql.mock.calls` (the latter does not
  flatten the `importConsentStateSql` fragment).

## Deploy sequence (RISK = high lane)

In the plan §6. Migration 102 to **staging Supabase first**, then the staging ride,
then PR → `main`, then prod Supabase **in lockstep at promotion, before the emitting
code is live**. An emission against an un-extended CHECK rolls back a legitimate
owner consent decision.
