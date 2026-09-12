# Review round 2 — SPEC & CORRECTNESS (verification only)

Fix commit verified: `eb21f55c2bf6b61c836ede6fc113e1d2caae3e08`
Round-1 head: `7224424efa0a226e9a517d28e27850a1973cf14d`
Method: every file read via `git show <fix>:<path>`, every change via
`git diff <r1-head> <fix> -- <path>`. The working tree was never read. No test run.

## Verification table

| finding | verdict | file:line | one line |
|---|---|---|---|
| SC1 same-turn supersession | ADDRESSED | `src/lib/agents/operator/proposals.ts:156` | `AND turn_id <> ${input.turnId}::uuid` replaces the `id <> self` exclusion, and `completeTurnFenced` passes `turnId: input.turnId` (`turns.ts:400`), so one turn's two same-scope proposals stay pending. |
| SC2 positional `proposal_ref` on a tie-only sort | ADDRESSED | `src/lib/agents/operator/render.ts:283-286` | `proposal_ref` → stored `{ type:'proposal', proposalId }` at completion; `StoredSegmentSchema` (`schema.ts:177-184`) drops `proposal_ref` entirely and `renderSegments` (`render.ts:354`) is a passthrough — no read-time index resolution survives. |
| SC3 count/completion gates skip `question` | ADDRESSED | `src/lib/agents/operator/render.ts:135-142` | Both patterns now run on `text` **and** `question`, with the segment type in the rejection reason; unit case at `__tests__/render.test.ts:100`. |
| SC4 null voice empties a completed turn | ADDRESSED | `worker/jobs/agent-turn/AgentTurnWorker.ts:198-217` | A null `readVoiceConfig` now takes `failTurnFenced(UNAUTHORIZED)` and returns before any row build; the `if (!operation \|\| !voice) continue` drop is gone with the handler-side builder. |
| SC5 `proposalSummaries` hardcoded `[]` | ADDRESSED | `src/lib/agents/operator/context.ts:300` | Populated from the batched `listProposalsForTurns` (`context.ts:287`) with the catalog-recomputed `describe`, never stored input JSONB. |
| SC6 no impersonation rejection on POST turns | ADDRESSED | `src/app/api/operator/turns/route.ts:45-47` | 409 `impersonation_not_allowed` after the flag gate (`:35`) and `requireWritableOwner` (`:37`), before parse and before `createTurn` — the same order as `PATCH /api/settings/auto-approval`; route test at `turns-route.test.ts:153`. |
| SC7 N+1 + unbounded transcript | ADDRESSED | `src/lib/agents/operator/reads.ts:188,199` | `ORDER BY sequence DESC LIMIT TRANSCRIPT_TURN_LIMIT (50)` reversed to chronological, plus one `turn_id = ANY(...)` read for the whole transcript; live bound case at `reads.integration.test.ts:286`. |
| CA2 `ORDER BY created_at` over same-`NOW()` rows | ADDRESSED | `src/lib/agents/operator/schema.ts:163-184` | Same fix as SC2 — the stored union can no longer express an index, so the tie-only sort is not on any binding path (it only orders card display). |
| CA3 Version token truncates microseconds | ADDRESSED | `src/lib/responses/voice-settings.ts:89,102` | `updated_at::text AS updated_at` returned verbatim, `VoiceRow.updated_at` retyped `string`; oracle fixture `'2026-09-11 10:00:00.123456+00'` + `expect(...).toContain('updated_at::text')` in `__tests__/voice-settings.test.ts:80-93`. |

## Defects introduced by a fix

| severity | file:line | finding |
|---|---|---|
| Low | `src/lib/responses/voice-settings.ts:151` | CA3 was fixed on the READ side only: `updateVoiceConfig` still returns `iso(row.updated_at)`, so the same column leaves this module in two spellings — Postgres text from `readVoiceConfig` (what `preparedVersionToken` stores, `proposals.ts:81`) and ISO-8601-ms from the PUT (`voice/route.ts:180`). Text-to-text comparison of a PUT-returned value against a prepared token can never match, and the ms truncation CA3 names still happens on this path. |
| Low | `src/lib/agents/operator/reads.ts:127` | The SM9/CA3 reader swap changed a client-visible field's format: `GET /api/operator/conversation` now serializes `summary.facts.updatedAt` as Postgres text (`2026-09-11 10:00:00.123456+00`) where it was ISO-8601 before the fix. No Run A consumer exists yet and `new Date()` still parses it, so the cost is a non-ISO timestamp frozen into the response contract. |
| Low | `worker/jobs/agent-turn/AgentTurnWorker.ts:198` | SC4's new terminal branch is uncovered: no unit case in `worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts` (one `it`, flag-off) and no live case in `turn-worker.integration.test.ts` exercises a vanished voice row, so nothing fails if the branch is later reverted to a silent drop. |

## Appendix (untriaged)

1. `schema.ts:29-45` — `asTurnStatus` throws, and `getConversationForOwner` maps it over every turn, so a single out-of-vocabulary row 500s the whole transcript rather than that turn. Guarded by migration 120's CHECK; noted only as the blast radius of the narrowing.
2. `reads.ts:197` — `getLocationsForAccount` is issued before the `!latest` early return, so a conversation with no turns still pays one query for a locations list it discards.
3. `reads.ts:160-174` — the explicit-`conversationId` branch stays account-scoped, not actor-scoped (only the no-id branch filters `created_by_user_id`). Deliberate and documented in `reads.integration.test.ts:233-241`; unchanged by round 1.

Appendix count: 3.
