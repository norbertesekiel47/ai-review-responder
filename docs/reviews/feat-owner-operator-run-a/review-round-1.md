# Review wave round 1 — feat/owner-operator-run-a

Pinned: fork/merge-base `c5e94e6ca7e3c4187854a67129b1651a8f80566e` · head `7224424efa0a226e9a517d28e27850a1973cf14d` · gate GREEN, fingerprint `b3457fcb…`.
Production diff measured from the fork: 3,408 added / 56 deleted lines outside tests and docs (intake estimate 2,800; under the 2× reclassify trigger). Standards axis ran because risk = high.
Wave members: spec & correctness (+ security, tenancy, async risk axes) · standards & maintainability (thermo-nuclear rubric) · Codex adversarial approach review (companion run, no resumable thread id recorded by the companion) · red-team pass round 1 (`docs/reviews/red-team/feat-owner-operator-run-a-b83a4f/`, status OPEN_P0).
Full reports: `spec-correctness.md`, `standards-maintainability.md`, `codex-adversarial.md`, the red-team `findings.md` + `findings.json`.

## Triage verdicts (orchestrator; every ACCEPT is fixed in round-1 fixes)

### Codex adversarial (approach)

| # | Sev | Finding | Verdict | Reason |
|---|---|---|---|---|
| CA1 | high | Outbox vs turn ownership can disagree permanently | ACCEPT (half) / REJECT (half) | REJECT "permanently": a stale-attempt completion is closed by the terminal-turn branch on the next dispatch (`readTerminalTurn` → `markOutboxCompletedIfOwned`), proven live by title 23's third dispatch. ACCEPT the dispatch-exhaustion half: five poller dispatch failures terminalize the outbox row with the turn still `accepted`; successors fail `predecessor_stalled` after 20 min but the turn itself never resolves. `OutboxPoller` is outside this run's surface, so the fix is recorded as a Run B item (spec §14, deviations) — the screen shows a timeout and offers "try again". |
| CA2 | high | `proposal_ref.index` re-derived by `ORDER BY created_at` over same-`NOW()` rows | ACCEPT | Same as SC2. Materialize `proposal_ref` into a stored `{ type: 'proposal', proposalId }` at fenced completion, exactly as `status_ref` is materialized; reads never re-derive an index. |
| CA3 | high | Voice **Version token** truncates microseconds through a JS `Date` | ACCEPT | The CLAUDE.md `timestamptz` gotcha. `readVoiceConfig` selects `updated_at::text` and the token stores that text verbatim; Run B compares text to text. |
| CA4 | medium | Predecessor wait (up to 20 min) vs watchdog reclaim (15 min) — duplicate delivery | ACCEPT as documented tradeoff, no code change | A redundant dispatch of a waiting turn is safe by construction (the **Turn claim** serialises; the loser exits), and at the default watchdog it happens at most once per wait over 15 min. The alternative (a durable waiting state or sequence-aware outbox dispatch) changes `OutboxPoller`, outside this run. Recorded in spec §14 with the two clocks named. |
| CA5 | medium | Envelope 11→12 bypasses ADR 0005's ~10 semaphore trigger | REJECT | Owner decision in the grill (map-level question, 2026-09-11): flag-gated third lane at concurrency 1, envelope 12, ADR 0005 amendment written. The lane is owner-interactive and rare; the non-gated sum stays at 9. Revisit with the semaphore trigger, not in this run. Listed under "Red-team/review findings rejected" in the PR. |

### Spec & correctness

| # | Sev | Finding | Verdict | Reason |
|---|---|---|---|---|
| SC1 | medium | Same-turn supersession: two proposals in one turn with the same (operation, location) supersede each other | ACCEPT | `supersedePendingProposals` excludes only the replacement id; exclude every proposal of the current turn (`turn_id <> current`). Live case added. |
| SC2 | medium | Positional `proposal_ref` binding on a tie-only sort | ACCEPT | = CA2. |
| SC3 | medium | Count/completion validators skip `question` segments | ACCEPT | Apply both patterns to `text` and `question`; unit case added. |
| SC4 | low | Null `readVoiceConfig` silently drops every proposal on a `completed` turn | ACCEPT | A location that vanished between step 3 and step 7 is an authorization change: `failTurnFenced(UNAUTHORIZED)`. |
| SC5 | low | `SnapshotTurn.proposalSummaries` hardcoded `[]` (spec §5.3) | ACCEPT | Populate from one batched `listProposalsForTurns` read (also closes SC7/SM4). |
| SC6 | low | `POST /api/operator/turns` has no impersonation rejection | ACCEPT | Mirror `PATCH /api/settings/auto-approval`: `hasImpersonationCookie` → 409 `impersonation_not_allowed` before any write; route test added. |
| SC7 | low | N+1 `listProposalsForTurn` per turn, unbounded transcript | ACCEPT | One `turn_id = ANY(...)` read; transcript bounded to the 50 most recent turns. |

### Standards & maintainability

| # | Sev | Finding | Verdict | Reason |
|---|---|---|---|---|
| SM1 | medium | ~70 lines of domain mapping in the job handler | ACCEPT | `buildProposalRows` → `proposals.ts`; `materializeStatus` + the new proposal materialization → `render.ts` (`materializeReply`). Handler orchestrates only (invariant #12). |
| SM2 | medium | Catalog lookup + `parseInput` run twice | ACCEPT | `validateModelOutput` returns the parsed proposals it already computed; `buildProposalRows` consumes them. |
| SM3 | medium | `turns.ts` 742 lines, three responsibilities | ACCEPT | Owner reads move to `src/lib/agents/operator/reads.ts` (+ directory row). |
| SM4 | medium | N+1 per turn | ACCEPT | = SC7. |
| SM5 | medium | Effective-rules projection duplicated (`turns.ts` / `context.ts`) | ACCEPT | One exported `projectOperatingRules` in `context.ts`. |
| SM6 | medium | No-turns branch fabricates an all-zeros summary | ACCEPT | `summary: null` when there is no turn to scope the reads to; route DTO says so. |
| SM7 | medium | Prompt lists all eight operation ids as proposable | ACCEPT | Prompt renders `snapshot.allowedOperations` only. |
| SM8 | medium | `job-outbox-helpers.ts` 976→1027 and `worker/index.ts` 982→1006 cross 1k lines | REJECT | Both are registries that grow by exactly one entry per topic/worker by repository design (32 topics, one helper each; one Worker per queue). Splitting a registry is its own refactor with its own audit (`ci:outbox-seam` derives helper ownership from that file). Recorded in the deviations file. |
| SM9 | medium | Single-location voice GET hand-edits the inline query instead of `readVoiceConfig` | ACCEPT | Use the reader for the single-location GET; the all-locations set query stays. |
| SM10 | medium | Voice field limits duplicated between catalog and route schema | ACCEPT | `VOICE_FIELD_LIMITS` exported from `voice-settings.ts`, consumed by both. |
| SM11 | medium | Four stale line citations in new comments | ACCEPT | Cite symbols, not line numbers (also RT11). |
| SM12 | low | `status: string` where `TurnStatus`/`ProposalStatus` exist; DTOs typed by `ReturnType` | ACCEPT | Tighten the types; name the DTOs. |
| SM13 | low | `modelVisibleOperations(_tier)` ignores its parameter; `proposalSummaries` always `[]` | REJECT / ACCEPT | `_tier` is threaded for Run B by plan L5 — keep, documented. `proposalSummaries` is SC5. |
| SM14 | low | `parseJsonbObject`/`nullableIso` duplicate `src/lib/agents/read.ts` | REJECT | `read.ts` is outside this run's surface and exports neither helper; the JSONB allowlist is owned per parse site. Follow-up noted in the deviations file. |
| SM15 | low | `user.accountId!` where `owner.accountId` is in scope | ACCEPT | Trivial. |

### Red team (round 1, OPEN_P0)

| # | Sev | Finding | Verdict | Reason |
|---|---|---|---|---|
| RT1 | P0 | Current-message scrub has no oracle | ACCEPT | Live case: review-shaped `owner_text` through `handleAgentTurn`; assert the prompt lacks the text and the stored reply starts with `server_notice`. |
| RT2 | P0 | `sameTurnPayload` `owner_text` arm unexercised; test comment false | ACCEPT | Pass the same `conversationId` to the repeat call; fix the comment. |
| RT3 | P0 | `getTurnForOwner` cross-tenant guard has no non-mocked test | ACCEPT | Live case in the reads suite: another account's turn id → null. |
| RT4 | P0 | `createTurn` conversation-ownership re-read scope undetected | ACCEPT | Live case: seed a foreign conversation with the same id → `conversation_not_found`, no turn row. |
| RT5 | P0 | Proposal `before`/`after` never asserted end-to-end | ACCEPT | Title 23 asserts the stored `before` (seeded voice) and `after` (proposed tone) JSONB. |
| RT6 | P1 | `failed-hook.ts` has zero covering tests | ACCEPT | Unit suite: exhaustion gate, CAS-first ordering, superseded dispatch writes nothing. |
| RT7 | P1 | `getConversationForOwner` has no non-mocked test | ACCEPT | Live case incl. the `created_by_user_id` actor scope and the no-id most-recent read. |
| RT8 | P1 | `typeof value === 'number'` proxy | ACCEPT | Seed distinct counts; assert the materialized value equals the named metric. |
| RT9 | P1 | Vacuous `mockClaimTurn` assertion | ACCEPT | Delete the line (the statement count covers it). |
| RT10 | P1 | Plan cites `voice/route.ts:197` past EOF | ACCEPT | Plan citation corrected to the symbol. |
| RT11 | P2 | `catalog.ts` cites `voice/route.ts:102` (moved) | ACCEPT | = SM11. |
| RT12 | P2 | `not.toContain('status_ref')` absence proxy | REJECT (recorded) | The surrounding comment argues it honestly; the `StoredSegment` type carries the stronger half; RT8's equality assertion now sits beside it. |
| RT13 | P2 | `INTERVAL '7 days'` hardcoded beside `RECENT_COMPLETED_DAYS` | ACCEPT | Bind the constant. |

Accepted: 33 · Rejected: 5 (CA5, SM8, SM13a, SM14, RT12) · Documented-only: CA1 (half), CA4.
