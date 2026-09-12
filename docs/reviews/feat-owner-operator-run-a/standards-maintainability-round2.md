# Standards & Maintainability — ROUND 2 (verification only)

- **Round-1 head reviewed:** `7224424efa0a226e9a517d28e27850a1973cf14d`
- **Fix commit verified:** `eb21f55c2bf6b61c836ede6fc113e1d2caae3e08`
- **Method:** every file read via `git show eb21f55c…:<path>`; every diff via `git diff 7224424e… eb21f55c… -- <path>`. Nothing read from the working tree. No tests run. Read-only except this file.

## Line counts at `eb21f55c…`

| File | Round-1 | Fix commit | Δ |
|---|---|---|---|
| `src/lib/agents/operator/turns.ts` | 742 | **510** | −232 |
| `src/lib/agents/operator/reads.ts` | — (new) | **278** | +278 |
| `src/lib/agents/operator/render.ts` | 245 | **367** | +122 |
| `src/lib/agents/operator/proposals.ts` | ~180 | **313** | +133 |
| `worker/jobs/agent-turn/AgentTurnWorker.ts` | 379+ | **313** | −66 |

Neighbours for context: `context.ts` 377, `catalog.ts` 204, `schema.ts` 247, `voice-settings.ts` 152, `src/app/api/settings/voice/route.ts` 187, `prompt.ts` 63. No file on the branch crosses 1,000 lines; `job-outbox-helpers.ts` and `worker/index.ts` are untouched by the fix commit (SM8 rejection honoured).

## Verification table

| finding | ADDRESSED/NOT | file:line | one line |
|---|---|---|---|
| SM1 domain mapping in the job handler | ADDRESSED | `worker/jobs/agent-turn/AgentTurnWorker.ts:219`, `:244` | `buildProposalRows` → `proposals.ts:60`, `materializeStatus`/`isStatusMetric`/the `status_ref` loop → `render.ts:212-294` as `materializeReply`; the handler now calls two named functions and the file drops 379→313. |
| SM2 catalog lookup + `parseInput` run twice | ADDRESSED | `src/lib/agents/operator/render.ts:116`, `:197-202`; `proposals.ts:65` | `ValidationResult.ok` carries `proposals: ParsedProposal[]`; `buildProposalRows` maps over them — both re-lookups and both "unreachable" `continue` guards are gone. |
| SM3 `turns.ts` three responsibilities | ADDRESSED | `src/lib/agents/operator/reads.ts:1-11`; `turns.ts:8-27` | Owner reads split into `reads.ts` (510-line `turns.ts` now imports zero cross-domain modules); `docs/directory/lib-owner-operator.md` gained the `reads.ts` row in the same commit (`ci:directory-map`). |
| SM4 N+1 proposal query per transcript render | ADDRESSED | `src/lib/agents/operator/proposals.ts:232`; `reads.ts:199` | One `turn_id = ANY(…)` read keyed by turn, empty-list short-circuit, transcript bounded to `TRANSCRIPT_TURN_LIMIT = 50` (`reads.ts:45`, `:188`). |
| SM5 effective-rules projection duplicated | ADDRESSED | `src/lib/agents/operator/context.ts:84` | `projectOperatingRules` is the one owner; consumed at `context.ts:356` (snapshot) and `reads.ts:257` (summary panel) — no second copy anywhere. |
| SM6 all-zeros fabricated summary | ADDRESSED | `src/lib/agents/operator/reads.ts:143`, `:223` | `OwnerConversationView.summary` is `OwnerConversationSummary \| null` and the no-turns branch returns `null`; the route DTO annotates it (`src/app/api/operator/conversation/route.ts:39`). |
| SM7 prompt lists all eight operation ids | ADDRESSED | `src/lib/agents/operator/prompt.ts:28` | Prompt now says "operations the snapshot lists under allowedOperations with kind \"proposable\""; `CATALOG_OPERATION_IDS` is no longer imported there, and `OWNER_OPERATOR_PROMPT_VERSION` bumped to `2026-09-11.2` (`prompt.ts:10`). |
| SM9 voice GET hand-edits the inline query | ADDRESSED | `src/app/api/settings/voice/route.ts:44` | Single-location GET calls `readVoiceConfig`; a narrow `id, name, display_label` read (`:52`) covers the one genuine difference, account-scoped and active-only the same way. |
| SM10 voice field limits duplicated | ADDRESSED | `src/lib/responses/voice-settings.ts:47` | `VOICE_FIELD_LIMITS` is the single owner; `catalog.ts:104-117` and `route.ts:120-133` both build their zod schemas from it — no third copy, and the prose citation that pointed at a moved line is gone. |
| SM11 four stale line citations | ADDRESSED | `authorize.ts:31-32`; `context.ts:179-180`, `:351-355` | All four now cite symbols + file (`requireWritableOwner`, `REVIEW_STATUS.DELETED`, `AutoApprovalSettingsResponse`/`AutoApprovalLocationSettings`); zero `*.ts:<n>` citations remain in the operator modules except `model-call.ts:2` and `:100`, both of which resolve at the fix commit. |
| SM12 `status: string` / `ReturnType` DTOs | ADDRESSED | `turns.ts:300`, `:322`, `:335`; `reads.ts:49`, `:108`; `proposals.ts:170` | `TurnStatus` on all six surfaces, narrowed at the row boundary by `asTurnStatus`/`asProposalStatus` (`schema.ts:31`, `:39`); named DTOs `ProposalView`/`UnsupportedView`/`OwnerConversationSummary`; zero `Awaited<ReturnType<…>>` left in the operator/worker/route surface. |
| SM15 `user.accountId!` | ADDRESSED | `src/app/api/settings/voice/route.ts:168` | `accountId: owner.accountId`, with a comment naming why the assertion was never needed. |

### Rejected items — confirmed left as triaged

| finding | state | file:line | note |
|---|---|---|---|
| SM8 (1k-line registries) | LEFT AS TRIAGED | — | `job-outbox-helpers.ts` and `worker/index.ts` are absent from the fix diff; the rejection is recorded in the deviations entry. |
| SM13a (`modelVisibleOperations(_tier)`) | LEFT AS TRIAGED | `src/lib/agents/operator/catalog.ts:189-191` | Parameter still threaded and still unread, docblock states the Run B reason. (SM13b `proposalSummaries` was accepted and IS populated — `context.ts:287`, `:311`.) |
| SM14 (`parseJsonbObject`/`nullableIso` duplicates) | LEFT AS TRIAGED | `schema.ts:221`; `reads.ts:276`; `voice-settings.ts:65` | Still three copies against `src/lib/agents/read.ts:204`/`:208`; `read.ts` untouched, as the surface bound requires. |

## Fix-introduced smells

| severity | file:line | finding |
|---|---|---|
| low | `src/lib/agents/operator/render.ts:1-367` | The fix added a fourth concern to `render.ts` (scrub · validator · **materialization** · renderer), 245→367 lines, which is exactly the trigger round 1's own appendix named ("the validator is the natural `policy.ts` if a fourth concern ever lands here"); `context.ts` now imports `render.ts` for `scrubPastedReview` while `proposals.ts` imports it for `ParsedProposal`, so three modules depend on "render" for three unrelated reasons. |
| low | `src/lib/agents/operator/proposals.ts:214`, `:240`, `:260` | `listProposalsForTurn`, the new `listProposalsForTurns` and `listPendingProposals` now spell the same ten-column `SELECT` list three times; the batched reader could subsume the singular one (`turnIds: [turnId]`), which is what "single owner" would mean here. |
| low | `worker/jobs/agent-turn/AgentTurnWorker.ts:232-238` | SM1 moved `buildProposalRows` out but left its sibling — the `UnsupportedRow` construction (uuid mint + field rename) is still inline in the handler, and `uuid` is imported into the worker boot file for it alone; the analogous `buildUnsupportedRows` belongs beside `buildProposalRows` in `proposals.ts`. |

Answers to the four named questions:

- **`reads.ts` is one responsibility with a small interface** — yes. Two exported functions (`getTurnForOwner`, `getConversationForOwner`), one exported constant, four view types; the module docblock states the write/read split and `turns.ts` no longer imports any of the six cross-domain modules that only the reads needed.
- **`materializeReply` / `buildProposalRows` left the worker as orchestration** — substantially yes (313 lines, two named calls, no catalog or metric logic); the single residual is the inline `unsupported` mapping above.
- **Batched `listProposalsForTurns` has a single owner** — yes, defined once at `proposals.ts:232` and consumed by `reads.ts:199` and `context.ts:287`; no second batching path exists.
- **`VOICE_FIELD_LIMITS` and `projectOperatingRules` removed the duplication** — yes, both are single owners with two consumers each and no third copy; the duplicated literals and the duplicated projection body are deleted, not mirrored.

## Appendix (untriaged)

1. `getConversationForOwner` (`reads.ts:156-274`) is a 119-line function issuing 9 sequential round trips per poll (conversation, turns, locations, batched proposals, pending counts, posted7d, settings, voice, pending proposals). The fix removed the N+1 and bounded the transcript, so this is strictly better than round 1 — but the summary-panel half is a separable `readSummaryPanel(sql, {accountId, locationId, conversationId})` if the panel ever grows another read.
2. `mapStored` is called twice per row in the `listProposalsForTurns` accumulator (`proposals.ts:249-250`) — once in each arm of the `existing ? push : set` branch. Harmless (pure function) but it reads as an accident; hoisting the call above the branch is a one-line tidy.
3. `src/lib/agents/operator/schema.ts` gained `asTurnStatus`/`asProposalStatus` (`:31`, `:39`) as the DB-boundary narrowers for SM12. Both are correct and tested by the compile, but neither is on a documented boundary list the way the JSONB parse sites are; if a third status vocabulary lands, the pattern deserves one named home rather than a third `as*` twin.

**Appendix count: 3.**
