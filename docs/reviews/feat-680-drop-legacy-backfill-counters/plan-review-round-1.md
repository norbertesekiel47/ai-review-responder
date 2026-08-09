# Plan review round 1 — codex adversarial (read-only)

**Ticket:** #680 · **Reviewer:** `codex exec --sandbox read-only` (codex-cli 0.145.0)
**Brief:** `<scratchpad>/codex-plan-brief-680.md` · **Raw transcript:** `<scratchpad>/codex-plan-review-680.jsonl`
**Usage:** 1,316,839 input / 13,529 output / 8,508 reasoning tokens
**Verdict:** `REVISE`

## Primary question — can the eval pass while the feature is wrong?

**Yes**, and codex is right. My T1 asserted only *final schema shape*. That does not establish that
migration 103 CAUSED the shape, nor that 103 does nothing else: a hand-dropped column, a
draft-provisioned container, or a 103 that also ran `UPDATE`/`TRUNCATE`/`DROP … CASCADE` all pass.
Worse, my test 4 inspected only a SQL **comment**.

## Findings and triage

| # | sev | finding | verdict |
|---|---|---|---|
| F1 | BLOCKER | Final-state introspection does not constrain executable 103; extra destructive statements or a hand-dropped DB pass | **ACCEPT** — add a statement-list assertion over `executableSql` |
| F2 | MAJOR | Text-searching a SQL comment for two substrings proves neither predicate semantics nor an abort — theatre | **ACCEPT** — preflight becomes an executable DO/RAISE guard, both branches tested (owner-approved reversal) |
| F3 | MAJOR | Deleting the worker UPDATE guard removes the only check over emitted SQL; mock-`sql` accepts a reintroduced legacy assignment that production rejects with 42703 | **ACCEPT** — guards KEPT and retargeted (owner-approved reversal) |
| F4 | MAJOR | Retitled reactivation test's positive assertions permit extra legacy INSERT columns | **ACCEPT** — same, keep the negative assertion |
| F5 | MAJOR | Citation false: `migration-102-…integration.test.ts` uses neither `acquireLiveDbLock` nor `assertSchemaReady` | **ACCEPT** — verified: 102 is text-only over the migration file. Precedent split: 100 for live introspection, 094/102 for text assertions |
| F6 | MINOR | "Tests 1–4 RED" wrong — 2–3 already pass under migration 100 | **ACCEPT** — only 1, 4 and retargeted 5 are red pre-103 |
| F7 | MINOR | "102 deliberately has no schema-ready entry" inaccurate — `schema-ready.ts:437-470` has a specialized requirement | **ACCEPT** — verified; reworded to "no generic `SchemaRequirement`" |
| F8 | MINOR | Precedent list not uniform: 074/076/077/078/088 are in `MIGRATION_SHAPE_SUITES`, 091 in `DDL_PROBE_SUITES`; only 100/102 support no-DDL treatment | **ACCEPT** — verified; plan now cites only 100/102 |
| F9 | MINOR | "A pre-#675 row with real work but zero legacy counters cannot exist" too broad — interruption after review writes but before the counter UPDATE leaves all six zero | **ACCEPT** — narrowed to the guaranteed claim: nonzero-collapsed ⇒ nonzero-legacy. Predicate unaffected (such a row has `imported_count = 0`, nothing to reconcile) |
| F10 | MINOR | `docs/runbooks/completed_runbooks/zernio-ingestion-test-runbook.md:355-377` still offers an operator query over the four dropped columns → 42703 if reused | **ACCEPT** — verified at those lines; surface amendment A1 |

**Rejected: none.** Every finding survived verification against disk.

## What codex independently CONFIRMED (not findings — corroboration)

- The two-branch predicate is **sound**; `count(*) = 0` is the correct abort condition. All four
  legacy counters are `INTEGER NOT NULL DEFAULT 0` (028) and both collapsed counters likewise (100),
  so three-valued logic cannot hide a deployed row. Matches my own independent live check on both
  projects.
- The **100→worker deployment window is covered**: an old worker's legacy-only write becomes a
  nonzero mismatch and is caught.
- **"Zero production TypeScript" checks out** — no worker, poller, offboarding/purge, admin, RLS,
  analytics or KPI path reads or writes the four identifiers.
- **"No down migration" is correct** because it cannot restore historical values.
- Staging-first / prod-at-promotion ordering is safe, **provided the preflight runs in the apply
  window** — which the executable guard now enforces by construction rather than by discipline.
- The worker, allowlist, migration-100 test, spec §8a R4, ADR §4, and staging-proof citations all
  match disk.

## Consequences for the plan

1. T1 gains the statement-list assertion (F1) and the two preflight-branch behaviour tests (F2).
2. T2's migration grows an executable `DO`/`RAISE` preflight guard before the `ALTER`, existence-
   guarded so it stays re-runnable.
3. The worker guards are retained and retargeted rather than deleted (F3/F4); `tests_to_add` went
   7 → 10 titles and `estimated_test_lines` 155 → 260.
4. Precedent and redness claims corrected (F5–F8); the header's soundness argument narrowed (F9).
5. Surface amendment A1 adds the stale completed runbook (F10). **Amendment count: 1** — a second
   one trips the abort criteria.

## Testing the guard — why the failing branch is mandatory

A preflight guard that never fires is **indistinguishable from a working one on clean data**: both
report zero abort rows, and both environments are currently clean. So staging apply-time evidence
cannot prove the guard works. The only proof is executing the migration's OWN guard text against a
`pg_temp`-shadowed replica of the pre-103 shape and asserting it RAISES on a mismatched row. That
needs `acquireLiveDbLock` and a per-line `-- live-db-ddl-ignore` (a `CREATE TABLE` on `pg_temp`
reads exactly like one on the shared table — the documented sanctioned escape).
