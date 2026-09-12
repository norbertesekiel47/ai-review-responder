# Red team — `feat/owner-operator-run-a`, ROUND 2

- **Mode** feature · **Risk** high · **Round** 2 of a hard cap of 2
- **Fork** `c5e94e6ca7e3c4187854a67129b1651a8f80566e`
- **Merge base** `c5e94e6ca7e3c4187854a67129b1651a8f80566e`
- **Head** `eb21f55c2bf6b61c836ede6fc113e1d2caae3e08`
- **Intake SHA-256** `86430051ff3276a792c58195a3ad4ac66fd7171bbba44b183afc47d2ead38a7f`
- **Status** `OPEN_P0`
- **Inventory** 39 rows — 13 killed, 2 survived-confirmed-P0, 3 inconclusive (oracle), 19 skipped-budget, 2 excluded
- **Budget** 29 of 30 supervised runs spent

Round 1's report is superseded by this file; it remains in git history at
`41f94b874`. `findings.json` beside this file is the machine-readable record and
is what `red-team-status.mjs` validates — the tables below are rendered from it.

## Scope

Round 2 is scoped to the round-1 FIX HUNKS and their direct callers: the diff
`7224424efa0a226e9a517d28e27850a1973cf14d..eb21f55c2bf6b61c836ede6fc113e1d2caae3e08`
("review round-1 fixes"). No front was opened against unchanged code.

## 1. The five round-1 P0 mutants — ALL FIVE NOW KILLED

Each was re-applied at its current location and re-measured against the test the
fix added or repaired.

| Round-1 | What was re-mutated | Test that now kills it | Verdict |
|---|---|---|---|
| F1 | `scrubPastedReview` at the worker seam (`AgentTurnWorker.ts:159`) replaced by a pass-through | `turn-worker.integration` › *worker scrubs a pasted review out of the prompt and stores the notice as the first segment* | **KILLED** |
| F2 | `sameTurnPayload`'s `owner_text` arm deleted (`turns.ts:54`) | `turn-worker.integration` › *createTurn stores owner_text byte-for-byte and treats a trimmed repeat as a conflict* | **KILLED** |
| F3 | `getTurnForOwner`'s `account_id` predicate deleted (`reads.ts:81`) | `reads.integration` › *getTurnForOwner returns null for a turn id that belongs to another account* | **KILLED** |
| F4 | `createTurn`'s conversation re-read scope deleted (`turns.ts:145`) | `reads.integration` › *createTurn refuses a conversation id that already exists under another account and writes no turn* | **KILLED** |
| F5 | proposal `before`/`after` swapped (`proposals.ts:77`) | `turn-worker.integration` › *worker claim race…* | **KILLED** |

The round-1 P1/P2 items were also re-resolved statically: F9 (vacuous
`mockClaimTurn` assertion) is deleted, F8 (`typeof value === 'number'`) is
replaced by equality against three distinct seeded metrics, F10 and F11 (stale
`voice/route.ts` citations) are corrected at their two flagged sites — but see
**R6** for two rows of the same table that were not. F6 (`failed-hook.ts`
untested) is closed by a new unit suite, which this round mutation-tested. F7
(`getConversationForOwner` untested) is closed by `reads.integration.test.ts`,
which this round mutation-tested — and which is where **R1** and **R2** were
found.

## 2. Findings

| ID | Severity | Location | Finding | Disposition |
|---|---|---|---|---|
| R1 | **P0** | `src/lib/agents/operator/proposals.ts:237` | `listProposalsForTurns` is fake-covered: an always-empty map survives, so the transcript's proposal cards and the snapshot's `proposalSummaries` are asserted nowhere | open |
| R2 | **P0** | `src/lib/agents/operator/context.ts:102` | `projectOperatingRules`' `locationOverrideExists` has no non-mocked oracle: forcing it to `true` on a location with no override row survives | open |
| R3 | P1 | `worker/jobs/agent-turn/AgentTurnWorker.ts:198` | The new `if (!voice)` terminal branch ships with zero covering tests | open |
| R4 | P1 | `src/lib/agents/operator/__tests__/reads.integration.test.ts:261` | Fragile assertion: `vetoWindowMinutes).toBeGreaterThan(0)` is a range-shaped proxy — it is what let R2 survive | open |
| R5 | P1 | `src/lib/agents/operator/__tests__/context.test.ts:70` | The closed-list `toHaveLength(4)` guard no longer closes the list: the new fifth read is invisible on a zero-turn fixture | open |
| R6 | P1 | `docs/superpowers/plans/feat-owner-operator-run-a-plan.md:71` | Stale citation in the same table the F10 fix corrected: `voice/route.ts:23` moved off the GET handler in this very commit | open |
| R7 | P1 | `src/lib/responses/voice-settings.ts:151` | Missed sibling: `updateVoiceConfig` still returns `iso(row.updated_at)`, so the two spellings of the Version token disagree by format | open |
| R8 | P2 | `src/lib/agents/operator/__tests__/render.test.ts:307` | Absence-of-token proxies extended into the new tests | open |
| R9 | P2 | `worker/jobs/agent-turn/AgentTurnWorker.ts:213` | The new terminal failure path emits `logger.warn` only — no Sentry signal, no rule row | open |
| R10 | P2 | `src/lib/agents/operator/schema.ts:31` | The new status narrowings' throw branch has no test | open |

Full arbiter reasoning for every finding — including the searches that were run
and what they excluded — is in `findings.json` under `findings[].arbiter_reasoning`.

### The two P0s, in short

**R1.** The fix introduced one batched `turn_id = ANY(...)` read and wired it
into two consumers: `OwnerConversationTurn.proposals` (the cards a stored
`proposal` segment names) and `SnapshotTurn.proposalSummaries` (which the
round-1 tree hard-coded to `[]`). Forcing the function to return an empty Map
before it issues its statement leaves `reads.integration`'s
`getConversationForOwner` case green. `rg proposalSummaries src worker` returns
only the two production sites; the single `.proposals` assertion in the suite
(`turn-get-route.test.ts:71`) runs behind a mocked `reads` module. The batched
read's account scoping, its keying and its very existence are unconstrained.

**R2.** `projectOperatingRules` is the new single owner of the inheritance
projection, feeding both the owner's summary panel and the model's snapshot.
Forcing `locationOverrideExists` to `true` on a tenant that has no
`auto_approval_policies` row for its location leaves the same case green. The
only assertion on the rules object is `vetoWindowMinutes > 0`; the only
assertion on the field itself is in a suite that mocks the module producing it.

## 3. Duty 2 — fragile assertions in the changed tests

Recorded as R4, R5 and R8 above. Two changed tests improved on round 1 and are
noted for the record: `AgentTurnWorker.test.ts` deleted the vacuous
`not.toHaveBeenCalled()` on an unmocked module rather than papering over it, and
the claim-race case replaced a `typeof … === 'number'` proxy with equality
against three deliberately distinct seeded counts (2 / 3 / 4).

One more, below the reporting bar and recorded here only: the two changed GET
cases in `src/app/api/settings/voice/__tests__/route.test.ts` now depend on the
ORDER of two `mockResolvedValueOnce` calls. A reordering of the route's two
reads fails loudly (the label row would be undefined and the route 404s), so it
is coupling rather than a false-pass, and no finding is raised.

## 4. Duty 3 — docs vs reality

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` ran against
`feat-owner-operator-run-a-plan.md`: **93 citations checked, 0 unresolved,
PREVALIDATE: PASS**. That script verifies a cited line EXISTS, not that it points
at the claimed thing, so every `path:line` in the changed docs was additionally
resolved by hand against HEAD. One stale citation was found (R6). The two
citations round 1 flagged (F10, F11) are genuinely corrected. The
`docs/directory/lib-owner-operator.md` rows added for `reads.ts` and rewritten
for `render.ts` / `turns.ts` / `proposals.ts` were checked against the code and
are accurate, including the "bounded to the 50 most recent turns" claim
(`TRANSCRIPT_TURN_LIMIT = 50`, `reads.ts:45`).

## 5. Duty 4 — missed sibling cases

| Pattern searched | Scope | Exclusions | Result |
|---|---|---|---|
| A **Version token** built from a postgres.js `Date` round-trip (`iso(row.updated_at)`) | `rg updated_at src/lib worker`, non-test files, filtered to token / text / `iso(` uses | `account_updated_at` in `worker/jobs/notification/context.ts` and `worker/jobs/publisher/load-context.ts` — context values, never compared | **1 sibling: R7** |
| A reference resolved by INDEX into a parallel array at read time | `rg '\[segment\.index\]\|\[\w+\.index\]' src worker` | `src/components/dashboard/**` chart hover state — in-render, no persistence | 0 siblings; the only remaining index resolution is the write-path one the fix intends (`render.ts:284`) |
| Another producer or consumer of `prepared_version_token` | `rg 'preparedVersionToken\|prepared_version_token' src worker`, non-test | — | 0 siblings; `proposals.ts` is the sole writer and Run A has no reader |
| An owner read whose only coverage mocks the module it is meant to prove | the two operator route suites plus reverse import search on `reads.ts` | — | The two flagged in round 1 are now backed by live-DB cases. The singular `listProposalsForTurn` / `listUnsupportedForTurn` pair reached through `getTurnForOwner` is unasserted in the same way — folded into R1 rather than raised separately |

No sibling was invented; the zero-result rows are recorded as results.

## 6. Duty 5 — operational completeness

One operator-actionable TERMINAL path is added by this diff: `AgentTurnWorker.ts:198`
fails the turn `unauthorized` when the location's voice row has vanished since
step 3. It emits `logger.warn` and nothing else; `docs/runbooks/beta-launch-alerting.md`
carries no rule row for `agent_turn`, and the subsystem emits no Sentry signal at
all. Recorded as **R9 (P2)** rather than P1 because the five sibling terminal
paths in the same handler all pre-date this commit and are identical in this
respect — escalating the one new line would be opening a front on unchanged
code, which round 2 forbids. The gap is real and belongs in Run A's go-live
adjudication as one decision, not ten.

## 7. Environment, restoration, and what the orchestrator must still do

Every mutation ran under `mutation-runner.mjs` with the allowlist environment
(temporary `HOME`, `NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`, and a
validated-localhost `TEST_DATABASE_POOL_URL`), with `--test-db` passed on both
`env` and every `run`, and with the dotenv files swapped for scrubbed copies.
`watchers` reported none. Every supervised run was asserted to have executed
EXACTLY ONE test.

All 15 journaled mutations were restored to their original blobs and verified:
`git status --porcelain` is empty on every tracked path apart from this run's two
report artifacts. **The dotenv swap is still open by design** — per this run's
instructions the finalizer belongs to the invoking orchestrator, not to this
pass. The orchestrator MUST run:

```bash
node .agents/skills/red-team/scripts/mutation-runner.mjs finalize
```

before the gate re-run, or `.env.local` stays scrubbed and
`red-team-status.mjs` will fail on the open journal.

## Authorizations

None. No finding on this run is `accepted-risk`.
