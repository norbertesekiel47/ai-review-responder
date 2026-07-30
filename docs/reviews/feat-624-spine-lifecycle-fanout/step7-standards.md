# Step 7 — Standards & maintainability review (2026-07-30)

**Skill run:** `thermo-nuclear-code-quality-review` (invoked via the Skill tool; loaded
successfully, no fallback to `code-review` needed).

**Target:** `git diff 2c8b021a53c50d3120d3b95fcbae6c70b170c914..af44b093` —
46 files, ~7967 insertions. Axis: code quality, standards conformance, abstraction
quality, glossary/doc fidelity. Correctness and spec-coverage are the parallel agent's
remit and were deliberately not duplicated.

---

## What I checked

**Standards read before judging:** `.claude/CLAUDE.md` (all 15 architecture invariants,
the worker-layout conventions, the JSONB allowlist, the gotcha list),
`.claude/rules/repworth.md`, `.claude/rules/engineering.md`,
`.claude/rules/production.md`, `.claude/rules/design.md`, `CONTEXT.md`
(§ Solicitation (send-mode), all seven locked terms).

**Prior-art read so nothing already decided is re-litigated:** the deviations log
(all 16 triaged entries + the four 2026-07-30 F-fix entries), the handoff, and the
step-6 adversarial review (F1–F5, all closed).

**Production surface read in full (13 files, ~650 lines of change):**

| File | Before → after | Verdict |
|---|---|---|
| `src/lib/solicitation/outreach.ts` | 0 → 390 (new) | Clean. Deep module: two exported operations, a closed result union, the lock order and the ABBA history documented at the parameter that fixes it. `deriveDisposition` / `tallyOutreach` are genuine private helpers, not pass-throughs. |
| `supabase/migrations/091_send_mode_spine_lifecycle.sql` | 0 → 545 (new) | Clean. Every CHECK carries its own "why", the deliberate carve-outs (closure-not-implying-approval, the redundant-by-design F3 arm) are stated in the file. |
| `src/lib/agents/run-spine.ts` | 493 → 550 | Clean. `failureToError` extraction turns a growing ternary into an exhaustive `switch` over the closed union — a real improvement, not churn. |
| `src/lib/agents/read.ts` | 428 → 450 | One finding (F-4 below). |
| `src/lib/solicitation/batch-builder.ts` | 705 → 735 | Clean, and a net improvement: the advisory-lock acquisition moved out of an inline `tx\`\`` into `acquireSolicitationBatchLock`, which is now the single named owner of the key derivation *and* of the global lock-order contract both sides cite. |
| `worker/background/pollers/ArchivalPoller.ts` | 300 → 352 | One finding (F-2 below). |
| `worker/background/pollers/health-alert/checks.ts` | 308 → 356 | One finding (F-4 below). |
| `worker/jobs/account-offboarding/purge-stages.ts` | 848 → 867 | Clean. The second advisory acquire is two lines in the existing per-business loop, with the ordering contract stated once and pointed at its owner. |
| `src/lib/account-offboarding/{purge-verification,table-disposition}.ts` | +9 / +7 | Clean — one new registry row each, matching the surrounding rows exactly. |
| `scripts/ci/{tenant-scope-allowlist,tenant-tables}.ts` | +22 / +5 | Clean. Baseline bumped 407 → 409 in the same change, as the file's own doc requires. |
| `src/app/(authenticated)/_styles/console.css`, `src/components/dashboard/timeline/RunStateBadge.tsx` | +4 / +1 | Clean. |

**Explicit checks that came back negative (no finding):**

- **File-size rule (1k threshold).** No production file crosses it. The largest new file
  is a test suite at 1318 lines (`migration-091-send-mode-spine.integration.test.ts`),
  which is inside existing precedent for a migration-shape suite
  (`migration-077-copilot-autopilot.integration.test.ts` is 1285) and maps 1:1 onto one
  migration. Not a decomposition problem.
- **Glossary renames.** All seven locked send-mode terms map onto code with no rename:
  Outreach row → `solicitation_outreach`; Send batch parent → kind
  `solicitation_send_batch`; Lazy child → `startOrGetSolicitationAskRun`; Settled batch →
  `closeBatchIfSettled`; Batch state → `deriveBatchState`/`BatchState`; Halt latch →
  `halted_at`/`halt_reason`/`halted_by`; Body redaction → `body_redacted_at`. The `_Avoid_`
  lists are respected — no "send record", "drip run", "pause", "resume" in the diff.
- **Invariant #15** (DB client as parameter). `outreach.ts` takes `tx: TransactionSql`;
  `checks.ts`/`ArchivalPoller.ts` are registered composition roots. No new
  `@/lib/db/server` importer.
- **Invariant #2** (outbox). 091 adds two in-flight partial uniques and re-spells the
  `('pending','dispatching','dispatched')` set by hand with the reason stated. No new
  enqueue site, so no `ci:outbox-seam` obligation — B10 defers it correctly.
- **JSONB allowlist.** The three new JSONB columns get **no** production parse site in
  this branch (`closeBatchIfSettled` reads nothing out of `error` any more), so the
  16-site allowlist correctly needs no edit.
- **`runArchival` exported for the live-DB suite.** Checked against convention: 8 sibling
  pollers already export a run-once entry point (`runJudgeSweepCycle`, `runOnceInner`,
  `pollOutbox`, …). Consistent, not a test-driven leak.
- **The `outcome-anchor-pairing.test.ts` carve-out comment.** F1's review said the old
  justification ("no holder of such a lock ever waits on `solicitation_batches`") was
  false and "must be rewritten, not merely re-asserted". It **was** rewritten, with the
  correction dated and a "do not restore the old wording" pin. Closed.
- **Deliberate decisions listed in my brief** (091 amended in place, the allowlist
  `sqlSnippet` SQL duplication as tripwire mechanism, blanket `IS TRUE`, composition-root
  DB-singleton asymmetry) — all verified as described, none reported.

---

## Findings (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| Medium | `CONTEXT.md:56` | The **Body redaction** glossary entry — written on this branch — still defines redaction as NULLing `rendered_subject`/`rendered_body` with "the metadata row kept forever", but the shipped sweep also wipes `interpolation_inputs` to `'{}'::jsonb` (`worker/background/pollers/ArchivalPoller.ts:268`). Neither `CONTEXT.md` nor `docs/adr/0014-send-mode-spine-lifecycle.md` records the wider scope, and `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:40` still calls `interpolation_inputs` "load-bearing for the §2.4 provenance verdict" with no note that it survives only 90 days. All three docs are on this branch's edit surface and two were edited by it. |
| Medium | `supabase/migrations/091_send_mode_spine_lifecycle.sql:209` | The `interpolation_inputs` data-minimization guarantee has no owner in the schema — it lives only in one poller's `SET` clause. 091 itself states the opposite principle twelve lines above the constraint it applies it to (`:334`: "Both are closed in the data rather than in the sweep's predicate, because the sweep is not the only future reader"). F3/F4 closed their holes with CHECKs on the same table in the same commit; F5 did not, so a second future writer of `body_redacted_at` (#628's regenerate/supersede path is the obvious candidate) can stamp a redaction and leave `contact_first_name` / `visit_note` in place with nothing to stop it. |
| Low | `src/lib/solicitation/__tests__/outreach-close.integration.test.ts:222`, `src/lib/shared/__tests__/migration-091-send-mode-spine.integration.test.ts:150`, `worker/background/pollers/__tests__/ArchivalPoller.integration.test.ts:140` | Three hand-rolled `INSERT INTO solicitation_outreach` fixtures, each independently spelling 091's 15-column NOT-NULL set, and the 64-char `prompt_hash` fabrication written three times (`outreachId.replaceAll('-','').padEnd(64,'0').slice(0,64)` twice, `checksum(askId)` once). The upstream chain (upload → contact → batch → ask) is re-seeded in each too. `src/lib/shared/__tests__/helpers/` is the established home for shared live-DB test scaffolding and this branch already added to `schema-ready.ts` there. Cost: any future NOT NULL column on `solicitation_outreach` is shotgun surgery across three files (four once #628 lands its own suite). |
| Low | `src/lib/agents/read.ts:33` + `worker/background/pollers/health-alert/checks.ts:16` | `stalledThresholdMsForKind` — a per-kind operational property of an `agent_runs` row — is hosted in the owner-facing dashboard read model, so the worker's health-alert poller now runtime-imports `src/lib/agents/read.ts` and transitively its `@/lib/kpi/types`, `@/lib/escalations/types`, `@/lib/reviews/triage-schema` and `@/lib/shared/response-status` graph. `design.md` trigger rule: "Move the logic to the package/module/layer that already owns the concept" — `run-spine.ts` owns `AGENT_RUN_KINDS` and `STEP_PERSONA`, and `read.ts` had to *add* an import of `AGENT_RUN_KINDS` to host this. Hosting it beside the enum would have given the same single-owner guarantee with zero new cross-layer coupling. |
| Low | `docs/directory.md:534-546` | The new production module `src/lib/solicitation/outreach.ts` is not registered in the `solicitation/` table of the code map, which CLAUDE.md calls "the full file map" and `repworth.md` names as the pre-flight check for adding a file. This continues a pre-existing drift — `batch-builder.ts` (#543) is missing too — but the branch did update its other inventories inline (`.claude/reference/migrations-log.md`, `docs/security/rls-inventory.md`, `CONTEXT.md`), so the code map is the one it skipped rather than a sweep deliberately deferred. |

---

## Low-confidence appendix (NOT findings)

Recorded so the reasoning is on disk, explicitly below the reporting bar.

1. **`ArchivalPoller`'s `totalArchived` now conflates deletes with a redaction.** Arm 9 is
   the only non-deleting arm, and its count is summed into `totalArchived` and logged
   under `Archived` (`ArchivalPoller.ts:290-305`). An operator reading `total: N` cannot
   tell how many rows were deleted. Mitigated: the per-target key
   `solicitation_outreach_bodies` is distinct, the saturation entry is distinct, and the
   comment says "The only arm that does NOT delete". Cosmetic; the author is demonstrably
   aware. Below the bar.

2. **`BATCH_SEND_WINDOW_HOURS` has zero production readers**, and its only test is
   `expect(BATCH_SEND_WINDOW_HOURS).toBe(72)`
   (`src/lib/solicitation/__tests__/outreach.test.ts:110`) — a tautological pin. Against
   `repworth.md`'s "wait for the second concrete use case" this reads as speculative. But
   the ticket is literally titled "fan-out **primitives**", the constant's docstring names
   #630 as its first reader, and this repo uses value-pinning tests deliberately elsewhere
   (`model-pinning.test.ts`). Same reasoning covers `startOrGetSolicitationAskRun` and
   `deriveBatchState`, both production-caller-less today. Shipping the primitives is the
   ticket's stated purpose, so not a finding.

3. **`deriveRunDisplayState` gained a required `kind` parameter whose only live caller is
   pinned to one value.** `getReviewTimeline` queries `WHERE ar.kind = 'review_handler'`
   (`read.ts:349`), so the new `ar.kind` select, the `RunRow.kind` field and the argument
   are effectively constant today. Speculative on its face, but it is exactly what fork
   G10 specified and the test at `read.test.ts:149` names the non-change as its contract.
   Not a finding.

4. **Two spellings of the approval-window boundary** — JS `now >= built_at + 7d`
   (`outreach.ts:93-94`) and SQL `built_at <= NOW() - 7d` (`outreach.ts:301`). Duplicated
   *comparison*, single owner for the *constant*, and the docstring at `:29-34` states
   exactly why both must agree and what breaks if they don't. Correctly handled; the
   integration suite pins the boundary (`outreach-close.integration.test.ts:527`). Not a
   finding.

5. **`closeBatchIfSettled` throws bare `Error` in two places** (`:310`, `:230`) rather than
   a typed domain error. Consistent with the surrounding solicitation modules; the
   `tallyOutreach` throw carries an explicit "loud failure beats a quiet gap" rationale.
   Taste-level. Not a finding.

6. **`outreach.ts`'s module docstring says "Two things live here and nothing else"** while
   the file also exports two window constants, two vocabulary arrays and four types. The
   sentence is about *operations*, and the constants' placement is justified in their own
   docstrings. Not worth a comment edit after four review rounds.
