# Red team — fix/1105 unmapped block reason signal

**Mode** `feature` · **Risk** `high` · **Round** 1 · **Status** `OPEN_P0`

| | |
|---|---|
| Fork / merge-base | `313a3e01fa73612037eb6674718619e5bf75eb4b` |
| HEAD | `01aa07f3113af2688137f5d4004419ac03cc4264` |
| Intake SHA-256 | `9b3075f79c1c6daea851b6197b18c364d71485f7f12a77776559f3ba3430f82b` |
| Mutants applied | 22 (21 killed, 1 confirmed survivor) |
| Excluded rows | 2, each with a recorded reason |
| `inconclusive` / `skipped-budget` | 0 / 0 |

Every claim below is evidence produced in this pass. The verify gate, the
implementer's reasoning and the PR narrative were treated as claims, not proof.

## What was re-derived before anything was mutated

- **Gate.** `.feature/gate-status.json` carries 27 checks, all `PASS`.
  `.feature/codex-gate-fingerprint.json` binds them to `headSha` `01aa07f3…`,
  `baseSha` `313a3e01…`, and the same intake digest as `.feature/state.json`.
  Fingerprint is current. **Confirmed.**
- **18 promised titles.** The gate's `promised-tests` row is a fixed-string
  EXISTENCE check (`scripts/verify-gate.sh:451-478`) and proves nothing about
  passing. Re-derived directly: `vitest run` over both suites is **85 passed /
  85** at HEAD, and the 18 intake titles resolve as 12 in `write.test.ts` plus 6
  in `persist.test.ts`. **Confirmed** (but see F-05 — the write-suite docblock
  says thirteen).
- **Live-DB lane.** D9's figures are recorded at the pre-rebase SHA `229c51ba`,
  and D9 itself says to re-run. Rather than accept the number I ran the one
  covering live-DB suite at HEAD against the local test database:
  `worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts`
  is **32 passed / 32**, matching D9's "the named suite alone is 32 passing
  cases". Substance holds; the citation is stale (F-10).
- **The gate's own skip.** `.feature/logs/test.log:122-123` — `1039 passed | 96
  skipped` files, `13788 passed | 1133 skipped` tests. D9's account of why is
  accurate.

## Duty 1 — hand-mutation

Budget honoured: 2 mutations per test, 120-180 s per run, and the runner's
per-round counter. `round-start` was re-issued once mid-pass because `finalize`
had closed the journal before three candidates were executed; this remains one
logical round-1 pass and no fixes were verified, so `round` is recorded as 1.
The environment was the runner's allowlist plus a scrubbed `.env.local`
(dotenv-swap) for every unit run; the one live-DB run passed a validated
localhost URL through the runner rather than the process environment.

### The survivor

**M-p01 — `worker/jobs/response-generation/persist.ts:960`.**

    -    if (unmapped.length > 0) noteUnmappedBlockReasons(unmapped);
    +    if (unmapped.length > 0) noteUnmappedBlockReasons(autoDecision.blockReasons);

Designated case (`… a mixed mapped and unmapped decision signals the vocabulary
hole only`) **passed**. Full-file confirmation: **59 / 59 passed.**

Arbiter confirmation, recorded verbatim in the sidecar: the mutant is **not
equivalent** — for any mixed set the joined string differs, so the operator's
Sentry issue and durable log line would read `…has no category mapping:
rating_below_threshold, ghost_reason`, naming a *mapped* code as unmapped. It is
**not on an unexecuted branch** — the mixed case is exactly this input. The hole
is structural rather than incidental: the only two cases that assert
`mock.calls[0]![0]` feed ALL-unmapped sets, where filtered and unfiltered are
the same array; the one input that discriminates asserts only
`toHaveBeenCalledTimes(1)`. `write.ts:488-492` and the `docs/directory.md` row
both state the parameter contract as *already-unmapped codes*, and nothing
enforces it. See **F-01**.

### The seven `[R1-n]` cases — each verified against its named target

| Tag | Case | Mutant built to be its target | Result |
|---|---|---|---|
| `[R1-1]` | never invokes `resolvePolicyGateRefusal` | helper resolves-and-catches before joining | **kills** |
| `[R1-2]` | a prior ledger-dark warning does not suppress | entry guard READS `warnedThisEpisode` | **kills** |
| `[R1-3]` | one structured logger line | log emitted before the latch guard (logs every call, latches only Sentry) | **kills** |
| `[R1-4]` | inherited object key | `Object.hasOwn` -> `in` | **kills** |
| `[R1-5]` | empty block-reason set | `if (unmapped.length === 0) return;` deleted | **kills** |
| `[R1-6]` | input order | `[...new Set(u)].join()` **and** `[...u].sort().join()` | **both kill** |
| `[R1-7]` | both transports throw | Sentry `try`/`catch` removed | **kills**, but see F-08 |

`[R1-6]`'s repeated-code fixture is doing real work: the de-duplication mutant
is a defect that an order assertion over two *distinct* codes would not catch,
and it dies here. `[R1-7]` is the only one whose *uniqueness* I could not
establish — F-08 records that as an inspection claim, not a measurement.

### The mutual-exclusivity claim — no counterexample exists

The branch justifies two `if`s with no `else` on the ground that no block-reason
set makes both predicates fire. Searched for a counterexample and there is none,
by construction rather than by luck:

`unmappedBlockReasons(S) != []` iff `there is c in S with not Object.hasOwn(MAP, c)`,
while `wouldRecordRefusal(S)` requires `for all c in S: Object.hasOwn(MAP, c) and MAP[c] != null`.
The two use the **same** membership test on the **same** object, so a witness for
the first falsifies the universal in the second. The awkward inputs behave: for
`'toString'` and `'__proto__'`, `Object.hasOwn` on an object literal is `false`
in both predicates, so they agree. Duplicates and ordering are irrelevant to
both. Adding an `else` is therefore a **provably equivalent** edit — which is
why it was not raised as a survivor. The `else`-less form is safe.

### The three "must NOT fire" lane cases can fail

The prompt asked whether they passed at RED by construction. All three are
falsifiable, measured:

| Case | Mutant | Result |
|---|---|---|
| a fully mapped held decision … signals no vocabulary hole | call site drops its `length > 0` guard | **fails** |
| a veto-only decision raises neither signal | `unmappedBlockReasons` filter inverted | **fails** |
| with the ledger on … invokes no vocabulary-hole signal | signal raised before the kill-switch read | **fails** |

## Duty 2 — fragile assertions

Scanned every added assertion in both suites. **No finding.** Specifically
looked for and did not find: absence-of-tag proxies, exact string counts on
rendered output, and order assertions with no ordering contract (the one order
assertion pins a contract `vocabulary.ts` states for `allRefusalCodes`).

One item was considered and dismissed with evidence: `unmappedSignals()` filters
console lines by a message substring, so a negative assertion behind it
(`toHaveLength(0)`) would go vacuous if the message were reworded. Every case
that makes such a negative assertion also makes a message-independent one on
`captureMessage`, and mutant M-w09 (message identity changed) dies on the
positive side — so the filter is not load-bearing alone.

## Duty 3 — docs vs reality

`prevalidate-plan.py` was run against all three changed plan docs. Plan and
deviations **PASS**. The handoff reports two "stale commits" — both are halves
of a Codex session UUID (`01a069d3-87db-7aa0-bcb8-b2f63e9769e6`), a tool false
positive, not a finding. Every remaining claim was re-resolved by hand and is
listed below; the true ones are recorded as verified so the next pass does not
re-derive them.

**False at HEAD** -> F-02, F-03, F-04, F-05, F-06, F-09, F-10.

**Verified TRUE at HEAD** (each was load-bearing for a design decision):

- `createWorkerLogger` really does drop arrays — `sanitizeAnalyticsProperties`
  (`src/lib/analytics/events.ts:117,124`) excludes arrays from both the nested
  and the scalar branch. Mutant M-w12 proves the suite enforces it.
- The two-reset design's justification is real: `refusal-write.integration.test.ts`
  calls `resetRefusalLedgerWarningForTests()` MID-TEST at lines **1209** and
  **1232**, exactly as `write.ts`'s docblock claims.
- `POLICY_GATE_HELD_REFUSAL_CATEGORIES` (`vocabulary.ts:464-487`) is an ordinary
  object literal, so the `'toString'` fixture genuinely separates `Object.hasOwn`
  from `in`.
- `resolvePolicyGateRefusal` (`vocabulary.ts:726`) is the only throwing resolver
  in the vocabulary module, and guard 4 is the only early kill-switch read
  outside `write.ts` — both premises of the containment argument hold.

## Duty 4 — missed sibling cases

**Patterns searched:** `isRefusalLedgerEnabled\(\)`, `noteRefusalLedgerDark`,
`writeRefusalEvent`, and every consumer of a `*_REFUSAL_CATEGORIES` map.
**Scope:** the whole repository. **Exclusions:** `node_modules`, `docs/`, and
`*.test.ts` (searched separately for the reverse-import inventory).

Result: the exact #1105 shape — an early kill-switch guard in FRONT of a
throwing resolver — has **no sibling**. `held_draft`'s non-goal is structurally
sound (`HELD_DRAFT_REFUSAL_CATEGORY` is a frozen literal, no map, no hole
possible). The five map-indexing lanes, `auto-policy-downgrade.ts` included,
carry the same fault *class* in a different mechanism — recorded as **F-07**,
non-blocking.

## Duty 5 — operational completeness

One finding, **F-02**, and it is the most consequential non-P0 item here: the
alerting runbook still tells an operator that this exact fault raises nothing,
and scopes the `subsystem:refusal_ledger` rule to three `warning`-level emitters
where HEAD has a fourth at `error`. Three of the six compared facets contradict
the emitted signal.

No env-registry row is owed — the change adds no variable and correctly reuses
`REFUSAL_LEDGER_ENABLED`; the gate's `env-registry` row is `PASS`.

## Findings

| Severity | `file:line` | Finding | Disposition |
|---|---|---|---|
| **P0** | `worker/jobs/response-generation/persist.ts:960` | Passing the whole block-reason set instead of the filtered one survives all 59 cases — the mixed case never asserts the argument | open |
| **P1** | `docs/runbooks/beta-launch-alerting.md:54-83` | Runbook still says an unmapped reason "raises nothing"; records 3 `warning` emitters where HEAD has a 4th at `error` | open |
| **P1** | `.claude/reference/arch-review-log.md:1663` | "Promoted to lab notes." is false — lab-notes is unchanged and outside the edit surface; D6 says it is still pending | open |
| **P1** | `worker/jobs/response-generation/__tests__/persist.test.ts:1259` | Comment asserts the call site "does not pre-filter"; it does. Reverted-design residue, and it is why F-01 looks intentional | open |
| **P1** | `src/lib/refusals/__tests__/write.test.ts:871` | "SEVEN OF THESE THIRTEEN CASES … THE OTHER SIX" — the block holds twelve, six review-added | open |
| **P1** | `worker/jobs/response-generation/persist.ts:785-787` | `_PrecedenceIsTotal` credited with the unmapped guarantee; it covers *unranked*. `satisfies` at `vocabulary.ts:487` is the real guard | open |
| **P2** | `worker/jobs/publisher/auto-policy-downgrade.ts:218` | `held_draft` non-goal defensible; the five map-indexing lanes keep the same fault class, unrecorded | open |
| **P2** | `src/lib/refusals/__tests__/write.test.ts:1090` | `[R1-7]` may be redundant with case 4 — inspection, not measured | open |
| **P2** | `…-handoff.md:52-56` | "Nothing implemented" is stale at HEAD; bounded because the file names `state.json` as the authority | open |
| **P2** | `…-deviations.md` D9 | Live-DB figures cited at the pre-rebase SHA; substance independently verified GREEN at HEAD | open |

Full reasoning, including the verbatim arbiter confirmation for the P0, is in
`findings.json` beside this file.

## Authorizations

None. No finding on this pass carries an `accepted-risk` disposition.

## Restoration

`node .agents/skills/red-team/scripts/mutation-runner.mjs finalize` was run
before the first byte of this report. Both production files verified at their
HEAD blob object ids (`write.ts` `e8a2c2d6…`, `persist.ts` `c2c599ee…`);
`git status --porcelain` shows no tracked modification, the dotenv backup is
restored, and the journal is closed.
