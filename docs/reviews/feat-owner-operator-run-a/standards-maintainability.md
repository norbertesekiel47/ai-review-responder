# Standards & Maintainability review — feat/owner-operator-run-a

- **Merge base:** `c5e94e6ca7e3c4187854a67129b1651a8f80566e`
- **Head reviewed:** `7224424efa0a226e9a517d28e27850a1973cf14d`
- **Measured production diff (excluding tests and docs):** **3,408 added / 56 deleted lines** — the plan estimated 2,800. Net-negative bias is not met and was not claimed; the branch deletes 56 lines (the voice-route PUT body) against 3,408 added.
- **Rubric:** `~/.claude/skills/thermo-nuclear-code-quality-review/SKILL.md` (ambitious structural simplification, 1k-line rule, spaghetti-condition growth, abstraction quality), `.claude/CLAUDE.md` invariants #1/#2/#12/#15 + working rules, `.claude/rules/agentic-platform.md`, `.claude/rules/worker-layout.md`, `.claude/rules/next-app.md`, `.claude/rules/live-db-tests.md`, ADR 0005, and the plan's named precedents (`worker/jobs/judge/JudgeWorker.ts`, `src/lib/responses/judge.ts`, `src/lib/shared/job-outbox-helpers.ts`, `src/app/api/settings/voice/route.ts` at the fork).
- **Accepted-findings checklist applied:** `docs/reviews/finding-checklists/standards-maintainability.md`. Two listed classes recur on this branch and are reported below: **stale/off-by-N line citations written by the same commit that moves the target** (F10) and **duplicate helpers/renderers with no single owner** (F26, F16).
- **Method:** every file read via `git show <head>:<path>`; every diff via `git diff <base> <head> -- <path>`. Nothing read from the working tree. No tests run.

Issues already enforced by green tooling (`ci:tenant-scope`, `ci:outbox-seam`, `ci:outbox-status`, `ci:db-imports`, `ci:static-policy`, `ci:pool-fanout`, `ci:live-db-suites`, `ci:directory-map`, `eslint-boundaries`) are not repeated here; the diff does not circumvent any of them. Invariants #1, #2, #13, #14, #15 are observed correctly throughout — the routes import `sql` and pass it down, no domain module imports `@/lib/db/server`, `enqueueAgentTurn` is a helper-owned topic inserted in the turn's own transaction, and the flag has no `NEXT_PUBLIC_*` companion.

---

## Findings

### F1 [medium] `worker/jobs/agent-turn/AgentTurnWorker.ts:309-379` — ~70 lines of domain mapping live in the job handler, and the layout convention already names where it should go

**Standard:** `.claude/CLAUDE.md` working rules ("worker boot files orchestrate only: parse input, call one module function, return output — no business logic"); `.claude/rules/worker-layout.md` ("one top-level `*.ts` per worker, plus a per-domain subfolder when a worker has helpers"); rubric §6 "keep logic in the canonical layer", "separate orchestration from business logic".

**Evidence:** `isStatusMetric` (309), `materializeStatus` (317-330) and `buildProposalRows` (338-379) are pure domain transforms — model output → stored `status` segment, model proposal → `ProposalRow` including the catalog `preview()` call and the `preparedVersionToken` shape. None of them touches BullMQ, the outbox, the claim or the logger. The per-domain subfolder `worker/jobs/agent-turn/` already exists and already holds `constants.ts` and `failed-hook.ts`, so the convention for this exact situation is in place and unused. The `status_ref` → `status` loop (225-241) is inline in the handler as well, with a 9-line comment explaining a transform that is not orchestration.

**Smallest correction:** move `isStatusMetric`/`materializeStatus`/`buildProposalRows` and the segment-materialization loop into `worker/jobs/agent-turn/build-turn-rows.ts` exporting one function `buildTurnWrite(claimed, output, snapshot, voice, scrubbed) → { segments, proposals, unsupported }`. The handler then reads `const write = buildTurnWrite(...)` and passes it straight to `completeTurnFenced`. No behaviour change; the handler drops to orchestration and the mapping becomes unit-testable without a Job double.

---

### F2 [medium] `worker/jobs/agent-turn/AgentTurnWorker.ts:349-357` + `src/lib/agents/operator/render.ts:142-167` — the catalog lookup and `parseInput` run twice, and the second run needs two unreachable branches to survive

**Standard:** rubric §0 "code judo — reframe so whole branches disappear"; §4 "narrow edge-case handling implemented in the middle of an already busy function"; "copy-pasted logic instead of extracted helper".

**Evidence:** `validateModelOutput` already resolves each proposal — `proposableOperation(proposal.operation)` (143) and `operation.parseInput(proposal.input)` (165) — then throws both results away and returns only `{ ok: true, output }`. `buildProposalRows` repeats both lookups (350, 355) and, because the values were discarded, must guard each with a branch it documents as unreachable: "The validator already rejected an unknown operation or an out-of-domain input, so a miss here is unreachable" (351-353) and `if (!parsed.ok) continue;` (356). Two dead branches exist solely because a computed value did not cross a seam.

**Smallest correction:** widen the success arm of `ValidationResult` to carry what it already computed — `{ ok: true; output: ModelOutput; resolved: readonly { operation: ProposableOperation; input: Record<string, unknown> }[] }` — and have `buildProposalRows` map over `resolved`. Both `continue` guards and both re-lookups delete; the "unreachable" comments delete with them.

---

### F3 [medium] `src/lib/agents/operator/turns.ts` (742 lines) — three responsibilities in one module, and the third is a cross-domain view assembler

**Standard:** rubric §1/§5 ("did a previously cohesive module become more coupled… harder to scan?", "split a large file into smaller focused modules"); `codebase-design` module-depth; `.claude/CLAUDE.md` "default is no new file" cuts the other way only when the new file has no distinct responsibility.

**Evidence:** the file's own section banners declare the split — turn persistence (1-214), "Claim / release / fence" (216-505), "The owner reads" (507-742) — and `docs/directory/lib-owner-operator.md` enumerates four responsibilities for this one row. The third section is not persistence: `getConversationForOwner` (609-738) reaches into six other domains (`@/lib/auto-approval/settings`, `@/lib/dashboard/pending-count`, `@/lib/locations/repo`, `@/lib/responses/voice-settings`, `./proposals`, `./context`) to assemble an API view, and every one of those imports at the top of the file (6-13) exists only for it. The persistence half — which owns the lock ordering, the fence and the outbox coupling — imports none of them.

**Smallest correction:** move `OwnerTurnView`, `OwnerConversationTurn`, `OwnerConversationView`, `getTurnForOwner`, `getConversationForOwner` and `nullableIso` into `src/lib/agents/operator/owner-views.ts` (with its `docs/directory/lib-owner-operator.md` row in the same PR, per `ci:directory-map`). `turns.ts` drops to ~500 lines, loses five cross-domain imports, and becomes readable as one thing: the turn lifecycle.

---

### F4 [medium] `src/lib/agents/operator/turns.ts:661-668` — an N+1 proposal query per transcript render

**Standard:** rubric §7 "avoidable orchestration complexity"; `.claude/CLAUDE.md` `ci:pool-fanout` context (the rule forbids the *combinator*, not the set-based query).

**Evidence:**
```ts
for (const turn of turnRows) {
  const proposals = await listProposalsForTurn(sql, { turnId: turn.id, accountId: input.accountId });
  proposalIdsByTurn.set(turn.id, proposals.map((p) => p.id));
}
```
`turnRows` (630-639) is unbounded — every turn in the conversation, with no `LIMIT` — so a 40-turn conversation issues 40 sequential round trips on one pooled connection, and the loop only needs `p.id`. The comment two lines above (677-679) correctly says a `Promise` combinator is forbidden here, but the fix was never a combinator.

**Smallest correction:** add `listProposalIdsForTurns(db, { turnIds, accountId })` to `proposals.ts` — one `SELECT turn_id, id … WHERE turn_id = ANY(${turnIds}::uuid[]) AND account_id = …  ORDER BY created_at ASC` — and build the map from its rows. One query, same ordering, the `ci:pool-fanout` rule untouched.

---

### F5 [medium] `src/lib/agents/operator/turns.ts:726-732` duplicates `src/lib/agents/operator/context.ts:307-316` — the effective-rules projection is written twice, comment and all

**Standard:** rubric "copy-pasted logic instead of extracted helper", "reuse the existing canonical helper"; accepted-findings class F26 (duplicate renderers diverge).

**Evidence:** both sites take the same `AutoApprovalSettingsResponse` and compute the same four values with the same fallback chain:
`locationSettings?.effective.threshold ?? settings.accountDefault.threshold`, the same for `vetoWindowMinutes`, `effective.effectiveDailyCap ?? accountDefault.effectiveDailyCap`, and `override.exists ?? false`. Both carry a near-identical `effective`, never `override` comment (context.ts:295-300, turns.ts:725). Two copies of an inheritance rule means the next threshold dial has two places to change and one place to forget — the exact shape of accepted finding F26 on the admin-contract branch.

**Smallest correction:** export one `effectiveRulesFor(settings, locationId): RuleSummary & { locationOverrideExists: boolean }` from `context.ts` (which already owns `RuleSummary`) and call it from both sites. ~20 lines delete.

---

### F6 [medium] `src/lib/agents/operator/turns.ts:646-659` — the "omitted" summary is actually a fabricated all-zeros summary, contradicting its own comment

**Standard:** rubric §5 "a branch relies on silent fallback to paper over an unclear invariant — make the boundary explicit instead".

**Evidence:** the comment at 642-645 says "With no turns yet there is nothing to scope to and the summary is **omitted** rather than guessed." The code then returns a fully-populated summary of invented zeros: `pendingCount: 0`, `draftsWaiting: 0`, `posted7d: 0`, `dailyCap: 0`, `locationOverrideExists: false`, `facts: null`, plus a fresh `asOf` timestamp that vouches for them. `OwnerConversationView.summary` is non-optional (580-597), and `src/app/api/operator/conversation/route.ts:39` returns the view verbatim, so a client on a brand-new conversation is told "0 drafts waiting" and "daily cap 0" for an account that may have dozens waiting — with a timestamp asserting it was just read.

**Smallest correction:** make the field honest — `summary: OwnerConversationSummary | null` — and return `summary: null` in this branch. One type change, one literal; the renderer then has a state to render instead of numbers it cannot distinguish from real ones.

---

### F7 [medium] `src/lib/agents/operator/prompt.ts:23` — the prompt's proposable-operation list is a second, divergent projection of the catalog and names four operations the validator always rejects

**Standard:** rubric §6 "keep logic in the canonical layer… prefer existing canonical utilities over bespoke one-offs"; `.claude/CLAUDE.md` "no string literals… import the constant from its single authoritative TS file" (the spirit: one owner per fact).

**Evidence:** the system prompt says `Propose only these operations: ${CATALOG_OPERATION_IDS.join(', ')}` — which expands to all eight ids, including the three `kind: 'read'` operations and `record_unsupported_request` (`catalog.ts:11-20`). Those four are not proposable: `proposableOperation()` (194-197) returns `null` for them, so `validateModelOutput` (143-146) rejects any proposal naming one with "proposal names an operation outside the catalog". Meanwhile the *correct* list already reaches the model twice over in the same request — `snapshot.allowedOperations` carries `{ id, kind, labelKind, describe }` per operation (`context.ts:326`, serialized by `buildOperatorPrompt`). So the envelope contains two lists of operations that disagree about which ones may be proposed, and the one written in imperative English is the wrong one; a model that obeys it burns the single retry (`model-call.ts:22`).

**Smallest correction:** either derive the sentence from the proposable subset — `Object.values(CATALOG).filter((op) => op.kind === 'proposable').map((op) => op.id)` — or delete the line and let `allowedOperations` be the single owner, keeping `kind` as the discriminator the prompt already ships.

---

### F8 [medium] `src/lib/shared/job-outbox-helpers.ts` 976 → 1027 lines and `worker/index.ts` 982 → 1006 lines — two files pushed past 1,000 by this PR

**Standard:** rubric §1, a stated presumptive blocker: "do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason… if the diff crosses that threshold, explicitly ask whether the code should be decomposed first."

**Evidence:** measured at both pinned SHAs. `job-outbox-helpers.ts` gains `EnqueueAgentTurnInput` + `enqueueAgentTurn` (+51) and is now a 1,027-line flat grab-bag of ~15 unrelated per-topic helpers plus 5 `AGGREGATE_TYPE_*` constants; nothing but convention keeps the next topic from making it 1,080. `worker/index.ts` gains the worker registration, the failed hook, the slot-cap entry and the `workersByQueue` row (+24).

**Assessment and smallest correction:** `worker/index.ts` is the one I would waive — `.claude/rules/worker-layout.md` defines it as "pure registration + lifecycle, no DB writes", the addition is four mechanical entries in four existing lists, and splitting a registration root buys nothing. `job-outbox-helpers.ts` I would not waive silently: it is the third topic added to it this quarter and the file has no internal structure. The minimum is to record the crossing explicitly (it is a rubric blocker, and no deviation row covers it); the cheap structural answer is to split by domain — `job-outbox-helpers/{reviews,billing,solicitation,agents}.ts` re-exported from the existing barrel — so the `ci:outbox-seam` coverage derivation (which reads `job-outbox-helpers.ts` itself) keeps one entry point while the file stops growing without bound. That split is larger than this PR should carry; the actionable ask is the explicit decision, in a deviation row, rather than a silent crossing.

---

### F9 [medium] `src/app/api/settings/voice/route.ts:33-62` — the branch created `readVoiceConfig` and then hand-edited the query it replaces

**Standard:** rubric "reuse the canonical helper instead of introducing a near-duplicate"; `.claude/CLAUDE.md` "no near-duplicate"; the extraction's own stated purpose ("so the settings route and the Owner Operator share one lock order and one column map", `voice-settings.ts:1-4`).

**Evidence:** `readVoiceConfig` (`voice-settings.ts:57-77`) is exactly the single-location read: same five voice columns, same `id = … AND account_id = … AND archived_at IS NULL`, same null-coalescing to `[]`/`null`, returning `null` when the location is not an active member ("the same shape the route's 404 uses" — its own docblock). The route's GET does the same thing inline, and this diff *touched those very lines* to add `highlight_facts` to the type, the `SELECT` list and the response (diff hunks at 37-61) instead of calling the function the same PR wrote. The PUT half was extracted properly; the read half was left behind and then maintained by hand. `display_label`/`name` is the only genuine difference and it comes from a different concern (`getDisplayLabel`).

**Smallest correction:** in the single-location branch, call `readVoiceConfig(sql, { accountId, locationId })` for the voice fields and keep one small `SELECT id, name, display_label` for the label (or add the two label columns to the reader's row and project them). The duplicated column list and its null-coalescing delete.

---

### F10 [medium] `src/lib/agents/operator/catalog.ts:98-100` — the zod field domains are duplicated in two files with a prose comment as the only link, and the citation in that comment is already stale

**Standard:** rubric §5 "prefer explicit typed models or shared contracts"; accepted-findings class F10/F12 ("the commit that writes the citation is the commit that moves the target").

**Evidence:** `ToneInput`/`ProductsServicesInput`/`AvoidFactsInput`/`HighlightFactsInput` (101-110) restate the limits of `VoiceConfigSchema` (`route.ts:107-121`) under the comment "Limits mirror the settings route's `VoiceConfigSchema` (src/app/api/settings/voice/route.ts:102) so a Proposal can never carry a value the shared writer's own route would reject." Two independent definitions of one field domain, and nothing mechanical holds them together — a future `max(2000)` → `max(4000)` on the route leaves the catalog silently stricter and the proposal path quietly refusing values the UI accepts. The cited line is wrong at head: `route.ts:102` is `  });` (the end of the GET response object); `VoiceConfigSchema` begins at **107**, moved +5 by this same commit's `highlightFacts` additions.

**Smallest correction:** move the four field schemas into `voice-settings.ts` next to `VOICE_FIELD_TO_COLUMN` (the file that already claims to own "one column map"), have the route compose its `VoiceConfigSchema` from them and the catalog import them directly. The comment and the citation both delete, and the mirroring becomes a compile-time fact. If the split must stay, cite by symbol name only — never a line number.

---

### F11 [medium] Four more citations written by this branch do not resolve at head

**Standard:** accepted-findings F10/F12 ("landing on a plausible-looking line is worse than landing on nothing. Cite by symbol"); `.claude/CLAUDE.md` gate-evidence discipline.

**Evidence** (all verified with `git show <head>:<file> | sed -n '<n>p'`):

| Citation in the diff | Resolves at head to | Actual location |
|---|---|---|
| `authorize.ts:31-32` → "the same gate requireWritableOwner uses at the route (src/lib/auth/route-helpers.ts:154)" | a docblock sentence belonging to a *different* helper (`?accountId` operational-UI gate) | `requireWritableOwner` is at `route-helpers.ts:133` |
| `context.ts:129-130` → "`r.status <> 'deleted'`, src/lib/reviews/status.ts:30" | `FAILED: 'failed',` | `DELETED: 'deleted'` is at `status.ts:31` |
| `context.ts:288-293` → "Projection from AutoApprovalSettingsResponse (src/lib/auto-approval/settings.ts:191)" | `return {` inside a function body | the type is not declared in `settings.ts` at all — it is imported there at line 40 from `auto-approval/types.ts` |
| `context.ts:291-292` → "each entry of `locations` is an AutoApprovalLocationSettings (src/lib/auto-approval/types.ts:142)" | a blank line | the interface is at `types.ts:143` |

Twelve other citations on the branch (`judge.ts:80`, `outbox.ts:19`, `outbox.ts:211`, `pending-count.ts:35`, `types.ts:129`, `JudgeWorker.ts:27`, `purge-stages.ts:245`, …) resolve exactly, which makes the four wrong ones harder to spot, not easier.

**Smallest correction:** replace the line numbers with symbol names (`route-helpers.ts` `requireWritableOwner`, `reviews/status.ts` `REVIEW_STATUS.DELETED`, `auto-approval/types.ts` `AutoApprovalSettingsResponse` / `AutoApprovalLocationSettings`). Nothing else in the comments changes.

---

### F12 [low] Type contracts widened where the branch's own vocabularies exist, and three API DTOs are defined by `Awaited<ReturnType<…>>`

**Standard:** rubric §5 "question unnecessary optionality/`unknown`/cast-heavy code when a clearer type boundary could exist"; "prefer explicit typed models or shared contracts over loosely-shaped ad-hoc objects"; `.claude/CLAUDE.md` "no string literals for statuses — import the constant from its single authoritative TS file".

**Evidence:** `schema.ts:12` exports `TurnStatus` and `:22` exports `ProposalStatus`, and then six public surfaces take or return a bare `string`: `PredecessorState.status` (`turns.ts:301`), `isTerminalTurnStatus(status: string)` (`:322`), `readTerminalTurn` → `{ status: string }` (`:335`), `OwnerTurnView.status` (`:512`), `OwnerConversationTurn.status` (`:570`), and `StoredRow.status` / `mapStored` (`proposals.ts:96,110`). `isTerminalTurnStatus('completd')` compiles. Separately, the two route response shapes are typed by inference from query functions — `proposals: Awaited<ReturnType<typeof listProposalsForTurn>>` and `unsupported: Awaited<ReturnType<typeof listUnsupportedForTurn>>` (`turns.ts:516-517`), `pendingProposals: Awaited<ReturnType<typeof listPendingProposals>>` (`:595`), and `voice: (Awaited<ReturnType<typeof readVoiceConfig>>)` (`AgentTurnWorker.ts:346`, with redundant parens) — so the public JSON contract of `/api/operator/turns/:id` changes shape whenever a `SELECT` list changes, with no named type to review.

**Smallest correction:** annotate the six with `TurnStatus` / `ProposalStatus` (the reads already filter on those literals, so no cast is needed at the query boundary — a single `as TurnStatus` on the row type at the parse site is the honest spelling); name the DTOs — `export interface ProposalCard { … }` returned by `mapStored`, `UnsupportedCard` for the second — and write `voice: VoiceConfig & { updatedAt: string } | null` in the worker.

---

### F13 [low] `src/lib/agents/operator/catalog.ts:182-184` and `context.ts:97` — a tier parameter and a snapshot field that no code reads

**Standard:** rubric §4 "be skeptical of generic mechanisms that hide simple data-shape assumptions"; `.claude/CLAUDE.md` "no abstractions for a single caller"; speculative generality.

**Evidence:** `modelVisibleOperations(_tier: SubscriptionTierValue)` ignores its only parameter and returns `Object.values(CATALOG)` unconditionally; the docblock says so plainly ("Every Run A operation is available on every tier… the parameter is threaded now rather than retrofitted when Run B adds them"). Threading it is not free: `Snapshot.subscriptionTier` (`context.ts:97`) and `BuildSnapshotInput.subscriptionTier` (`:246`) exist to carry it, `authorize.ts` runs a fourth query (`:49-56`) to resolve it, and `AgentTurnWorker.ts:175,181` passes it twice. Of those, only `model-call.ts`'s `withCostGuard({ subscriptionTier })` is a real consumer — the catalog's copy is dead. Related: `SnapshotTurn.proposalSummaries` (`context.ts:74`) is declared on the model-facing type and set to `[]` unconditionally (`:235`), so every historical turn ships the model an empty array with a name promising content.

**Smallest correction:** drop the parameter — `modelVisibleOperations(): readonly ModelVisibleOperation[]` — and re-add it in Run B when a tier-gated operation exists (one call site to change). Keep `subscriptionTier` on the snapshot: the cost guard genuinely needs it. Delete `proposalSummaries` until something fills it, or fill it from the `listProposalsForTurn` data the same read already has.

---

### F14 [low] `src/lib/agents/operator/schema.ts:177-183` and `turns.ts:741-743` re-implement helpers that already exist one directory up

**Standard:** rubric "bespoke helpers where the codebase already has a canonical utility"; `.claude/CLAUDE.md` "no near-duplicate".

**Evidence:** `parseJsonbObject(value, column)` in `schema.ts:177` is byte-identical to `src/lib/agents/read.ts:212` apart from the error prefix (`agents/operator:` vs `agents/read:`); `nullableIso` in `turns.ts:741` is byte-identical to `read.ts:208`; `iso` in `voice-settings.ts:48` is a third copy of `read.ts:204`. The plan's Modules-and-seams table names `read.ts:212` as the *precedent* for `schema.ts`, so this was a deliberate follow-the-shape decision rather than an oversight — but "precedent" in the working rules means reuse the canonical one, not copy it, and both copies live inside `src/lib/agents/`.

**Smallest correction:** export the two from a shared `src/lib/agents/jsonb.ts` (or export `read.ts`'s existing pair) and import in both places, parameterising only the error prefix. ~20 lines delete across three files. Note the CLAUDE.md gotcha requires every production JSONB parse site to be on the lab-notes allowlist — the branch updates that allowlist (`lab-notes/postgres.md`), and consolidating shrinks the list rather than growing it.

---

### F15 [low] `src/app/api/settings/voice/route.ts:148` — a non-null assertion where a non-nullable field is already in scope

**Standard:** rubric §5 "why does this need a cast here? make the boundary more explicit instead"; `.claude/CLAUDE.md` no-`any`/explicit-boundary bias.

**Evidence:** the branch's rewritten PUT writes `accountId: user.accountId!`. Two lines earlier, `requireWritableOwner` returned `{ ok: true; user: AppUser; accountId: string }` (`src/lib/auth/route-helpers.ts:102`) — `owner.accountId` is already `string` and needs no assertion. The GET handler in the same file uses `owner.accountId` correctly at line 66. The pre-existing code did not need the assertion because it interpolated `user.accountId` into SQL, where the type did not matter; the extraction to a typed parameter is what surfaced it, and `!` was the shortcut taken.

**Smallest correction:** `accountId: owner.accountId`.

---

## Appendix — noted, not reported as findings

1. **`render.ts` carries three unrelated concerns** under one name: the pasted-review scrub (input sanitisation, 62-82), `validateModelOutput` (the policy gate, 106-171) and `renderSegments` (view mapping, 204-245). `model-call.ts` therefore imports "render" in order to validate. The plan names the module this way and the file is only 245 lines, so I would not move it in this PR — but the validator is the natural `policy.ts` if a fourth concern ever lands here.
2. **`insertProposals` / `insertUnsupported` loop one `INSERT` per row** (`proposals.ts:32, 161`). Bounded at 5 by the schema, inside one transaction; a multi-row `VALUES` would be tidier but this is not worth a round of review.
3. **`supersedePendingProposals` loops one `UPDATE` per replacement** (`proposals.ts:78`). Same bound, same judgement.
4. **`buildProposalRows`'s `if (!operation || !voice) continue;`** (`AgentTurnWorker.ts:354`) conflates a per-proposal condition (unknown operation) with a turn-level one (the location's voice row vanished between `reauthorizeTurn` and here). A null `voice` silently drops *every* proposal while the reply still ships `proposal_ref` segments, which `renderSegments` then drops too (`render.ts:232`). Unreachable today because `reauthorizeTurn` just verified the location; folding into F2's `resolved` shape removes the question entirely.
5. **The 821-line live-DB suite for `handleAgentTurn` lives at `src/lib/agents/operator/__tests__/turn-worker.integration.test.ts`** while the worker's own `worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts` is 109 lines covering only the flag gate. Cross-tree test imports have precedent in this repo (`src/lib/agents/__tests__/run-spine.integration.test.ts`, `src/lib/accounts/__tests__/billing-locks.integration.test.ts`), and `ci:live-db-suites` is satisfied, so this is a locality preference, not a violation.
6. **The `agent_turns` transcript read has no `LIMIT`** (`turns.ts:630-639`) — every turn in a conversation, every poll. Pagination is a product decision outside this axis; it does compound F4.
7. **Queue/flag/slot-cap wiring is exemplary.** `queues.ts` (`llmJobOptions` with a stated reason), `startup-assert.ts` (envelope 11 → 12 with the fourth-lane trigger preserved), `worker/index.ts` (`flagGated: true` with the ADR 0005 reasoning), `enqueueAgentTurn` (no `ON CONFLICT`, with the `42P10` reasoning) and the offboarding chain (dispositions, verification arms, purge DELETEs children-first, `TENANT_TABLES`) all follow the named precedents exactly and need no change.
