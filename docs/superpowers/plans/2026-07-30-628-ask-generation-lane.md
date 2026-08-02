# Ask-Generation Lane (#628) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The batch-build transaction auto-enqueues `generate_solicitation_asks`; a new
LLM worker renders personalized asks into `solicitation_outreach` under a `solicitation_ask`
LLM task (temp 0.6), each render gated by the fail-closed 7-class compliance lint and
provider moderation, with task-scoped cost-guard reservation and worker-enforced per-ask
regenerate.

**Architecture:** Pure content modules (`ask-prompt-policy`, `ask-schema`,
`ask-compliance-lint`, `ask-render`) feed one deep orchestration module
(`ask-generation.ts`, DB client as explicit param — invariant #15); the worker handler in
`worker/jobs/solicitation-batch/generate.ts` is a thin composition root. Renders persist on
`solicitation_outreach` (091/092 schema — NO migration in this ticket). Generation steps
bulk-write on a new `solicitation_send_batch` spine parent.

**Tech stack:** Postgres.js, BullMQ, zod, `runLlmTask` seam, Redis cost tracker, fast-check.

**Governing docs (read the slice named in each task):**
- SPEC = `docs/superpowers/specs/2026-07-28-ask-generation-design.md` (banner: §5 table superseded)
- AMEND = `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` (B1/B2/B4/B5/B10 bind)
- EXEC = `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` (D3, D21, D14, D17)
- INTAKE = `docs/superpowers/plans/feat-628-ask-generation-lane-intake.json` (drift detector; test titles are VERBATIM promises)
- DEVIATIONS = `docs/superpowers/plans/feat-628-ask-generation-lane-deviations.md` (postal-address inert-landing note; #625 merge order)

**Locked grilling decisions (do not re-litigate):**
1. Land inert pre-#627: footer takes `postalAddress: string | null` param; loader SQL
   references `businesses.solicitation_postal_address` but is unreachable while
   `SOLICITATION_SEND_ENABLED` is off/nonexistent.
2. `render_failed` rows fill: `rendered_subject`/`rendered_body`=NULL, `lint_detail='[]'`,
   `moderation_detail='{}'`, `moderation_status='error'`, `interpolation_inputs`=actual snapshot.
3. One topic `generate_solicitation_asks`, payload `{batch_id, ask_id?}`; aggregate_id=batch id;
   in-flight unique serializes regenerates per batch.

**Adversarial-review round-1 resolutions (codex session 019fb5dc; pending owner sign-off
with the plan):**
4. **Moderation fill for every never-moderated withheld row** — `lint_failed` rows (lint
   runs before moderation, §3.1) fill `moderation_status='error'`, `moderation_detail='{}'`
   exactly like `render_failed` (same principle the owner already locked: "no clean
   provider verdict was obtained"; inert because withheld is terminal).
5. **Idempotency check = any non-cancelled attempt skips the ask** (NOT live-only). A
   `withheld` row is terminal for the batch — a live-only check would re-generate blocked
   children on job retry, violating blocked-is-terminal and re-spending. `cancelled`
   rows never exist alone (supersede swap is atomic), so the check is complete.
6. **Budget exhaustion mid-batch** (`CostLimitExceeded`/`GlobalCostLimitExceeded` after k
   of n children): terminal for the GENERATION JOB — SPEC §7.5's "terminal for the batch"
   means generation stops and never same-day-retries, NOT that the batch lifecycle
   terminalizes. The job does not rethrow. Each remaining un-generated ask gets a
   `withheld`/`render_failed` row (decision-2 fills; `interpolation_inputs='{}'` when
   never assembled) so every ask has a settled representation; already-rendered rows STAY
   live and the partially-rendered batch proceeds through the NORMAL approval lifecycle
   (`closeBatchIfSettled` correctly reports not-settled while live renders exist). Only
   the k=0 case terminalizes via generation_failed. 091 has no budget-specific reason and
   this ticket ships no migration — recorded in DEVIATIONS as a candidate vocabulary
   widening for a later migration ticket.
7. **Regenerate supersede is unconditional per AMEND B2's mechanics**: prior row →
   `cancelled`/`superseded` + new row at `attempt_no+1` in one tx, regardless of the new
   render's verdict. A regen that produces a blocked render leaves the ask with no live
   render — blocked-is-terminal, bounded by the 3/day budget. The LLM call NEVER runs
   inside a transaction (no locks across provider calls); eligibility is re-verified
   inside the swap tx (`FOR UPDATE` on the live row) and the swap aborts if the row is no
   longer `rendered` — the finalized spend is logged and accepted as rare waste.
8. **Parent/batch closure has ONE owner: `closeBatchIfSettled`** (outreach.ts, shipped by
   #624) — and it owns the failure transition and batch-close CAS INTERNALLY
   (outreach.ts:355/366/394). The generation finale calls `closeBatchIfSettled` ALONE and
   never invokes a run-spine failure arm beside it. If its internal disposition mapping
   does not yet produce D14's `generation_failed` for the all-withheld/failed case,
   EXTEND `closeBatchIfSettled` (deepen the owner) rather than composing a second
   terminalizer next to it. Read its contract before wiring; record what was found in
   DEVIATIONS.
9. **Outbox completion rides the finale transaction, CAS-first**: the exported
   `markOutboxCompletedIfOwned` (outbox.ts — batch-builder's `completeOwnedAttempt` is a
   private wrapper over it) executes as the FIRST statement of the same tx as the bulk
   step write + closure; false ⇒ stale attempt ⇒ abort with zero domain writes. Every
   early no-op return path completes the outbox row via its own minimal tx — no code
   path leaves a dispatched row stranded.
10. **Day-0 visit bucket**: a same-day visit renders bucket `today` (spec §1.1 starts at
   1 day — gap recorded in DEVIATIONS as a spec delta).

**091/092 facts the code must satisfy (from recon, not the superseded spec §5.2):**
- `solicitation_outreach` columns incl. `source CHECK (IN ('llm'))`, `attempt_no`,
  `ask_lint_version`/`lint_detail`/`moderation_status`/`moderation_detail`/
  `interpolation_inputs` all NOT NULL, `rendered_at` NOT NULL, consent columns nullable
  (stamped by #630).
- `delivery_status` vocab: rendered|queued|sending|sent|withheld|cancelled|failed|unknown.
  `withheld` reasons include `moderation_high`,`render_failed`,`lint_failed`; `cancelled`
  includes `superseded`.
- `solicitation_outreach_one_live_per_ask`: `UNIQUE (ask_id) WHERE delivery_status IN
  ('rendered','queued','sending')`. Supersede = update old row terminal THEN insert
  `attempt_no+1`, one transaction. Do NOT use `ON CONFLICT` against this index (spec §5.2
  note; existence check + single-replica makes insert unconditional).
- Body-presence CHECK is **092's** (terminal-keyed): bodyless rows legal only when
  `withheld` or redacted; `(rendered_subject IS NULL) = (rendered_body IS NULL)`.
- RLS: owner SELECT excludes `withheld`+`moderation_high`; all writes via worker/server.
- `job_outbox_generate_solicitation_asks_inflight` index exists; helper + QUEUE_NAMES entry
  ship HERE (AMEND B10).

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/llm/anthropic-provider.ts` | modify | forward `temperature` (SPEC §4.4 prerequisite) |
| `src/lib/llm/__tests__/anthropic-provider.test.ts` | create | temperature forwarding |
| `src/lib/llm/types.ts` | modify | `LLMTaskId` gains `'solicitation_ask'` |
| `src/lib/llm/tasks.ts` | modify | `solicitation_ask` entry (0.6 / 400 / schema) |
| `src/lib/solicitation/ask-schema.ts` | create | `SolicitationAskOutputSchema` (shape only) |
| `src/lib/costs/tracker.ts` | modify | `estimateCents` param threading; `checkAskRegenBudget` |
| `src/lib/costs/cost-guard.ts` | modify | `CostGuardOptions.estimateCents?` |
| `src/lib/solicitation/ask-render.ts` | create | placeholders, footer, body assembly (pure) |
| `src/lib/solicitation/ask-compliance-lint.ts` | create | note admissibility + 7-class lint (pure, versioned) |
| `src/lib/solicitation/ask-prompt-policy.ts` | create | prompt base/version/hash + `buildAskPrompt` |
| `src/lib/solicitation/outreach.ts` | modify | render insert + supersede-swap + JSONB parsers |
| `src/lib/agents/run-spine.ts` | modify | send-parent start + bulk generation steps |
| `src/lib/solicitation/ask-generation.ts` | create | deep orchestration: load→reserve→LLM→lint→moderate→persist |
| `src/lib/solicitation/flags.ts` | modify | `solicitationSendEnabled()` |
| `src/lib/shared/queue-names.ts` | modify | `GENERATE_SOLICITATION_ASKS` |
| `src/lib/shared/worker-types.ts` | modify | `GenerateSolicitationAsksPayload` |
| `src/lib/shared/job-outbox-helpers.ts` | modify | `enqueueGenerateSolicitationAsks` |
| `src/lib/solicitation/batch-builder.ts` | modify | build-tx enqueue (flag && sendCount>0) |
| `worker/jobs/solicitation-batch/generate.ts` | create | thin handler (composition root) |
| `worker/jobs/solicitation-batch/generate-failed-hook.ts` | create | exhaustion hook |
| `worker/index.ts` | modify | register worker + health map + LLM slots assert |
| `src/lib/solicitation/batch-view.ts` | modify | live-render join + moderation_high redaction |
| `.claude/CLAUDE.md` | modify | JSONB allowlist 16→19 |
| `.claude/reference/env-vars.md` | modify | `SOLICITATION_SEND_ENABLED` row |
| `src/lib/responses/__tests__/model-pinning.test.ts` | modify | extends to `solicitation_ask` |

Tests colocate in each module's `__tests__/`. Live-DB suites are `*.integration.test.ts`,
never apply migration SQL, assert via `assertSchemaReady` (#573 conventions).

---

## Task 1: Anthropic temperature forwarding (prerequisite — SPEC §4.4)

**Files:** modify `src/lib/llm/anthropic-provider.ts`; create
`src/lib/llm/__tests__/anthropic-provider.test.ts`; append DEVIATIONS entry.
**Blocking edges:** none.

- [ ] Write failing test `forwards temperature to the Anthropic SDK` (INTAKE title, verbatim):
  mock `@anthropic-ai/sdk`, call `complete({... temperature: 0.6 ...})`, assert
  `messages.create` received `temperature: 0.6`; second case: `temperature: undefined` ⇒
  key absent (SDK default preserved for undefined).
- [ ] Also write the SPEC §9 fallback-regression test (title:
  `changes reply_generation and insights anthropic fallback temperature knowingly`):
  through `runLlmTask` with the OpenAI provider mocked to fail and the Anthropic SDK
  mocked, assert the fallback request carries `temperature: 0.7` for `reply_generation`
  and `0.5` for `insights` — the behavior change rides deliberately, not silently.
  (`run-task.ts:167` already threads task temperature into the request; only the
  provider drops it today.)
- [ ] Run: `pnpm test src/lib/llm/__tests__/anthropic-provider.test.ts` → FAIL.
- [ ] Implement: forward `...(request.temperature !== undefined ? { temperature: request.temperature } : {})`;
  REPLACE the "deliberately not forwarded" comment block with one line noting forwarding
  landed with the first temperature-sensitive Anthropic task (#628) and that
  `reply_generation` (0.7) / `insights` (0.5) fallback behavior changed knowingly.
- [ ] Run test → PASS. Append the DEVIATIONS entry (spec-mandated: behavior change for
  reply_generation/insights fallbacks rides deliberately).
- [ ] Commit `feat(#628): forward temperature in anthropic provider (spec §4.4 prerequisite)`.

## Task 2: LLM task registry + output schema

**Files:** create `src/lib/solicitation/ask-schema.ts`; modify `src/lib/llm/types.ts`,
`src/lib/llm/tasks.ts`; modify `src/lib/responses/__tests__/model-pinning.test.ts`.
**Blocking edges:** after Task 1 (registers the temp the provider must honor).

- [ ] `ask-schema.ts`: `SolicitationAskOutputSchema = z.object({ subject: z.string().min(1), body: z.string().min(1) }).strict()`
  — SHAPE ONLY, no length bounds (SPEC §4.2: an 81-char subject must become a legible
  `blocked` render via lint class 5, never a terminal `LLMStructuredOutputError`).
- [ ] `types.ts`: widen `LLMTaskId` union with `'solicitation_ask'`.
- [ ] `tasks.ts`: entry exactly per SPEC §4.3 — pinned pair `OPENAI_MODEL`/`ANTHROPIC_MODEL`,
  `maxTokens: 400`, `temperature: 0.6`, `outputSchema: SolicitationAskOutputSchema`.
- [ ] Extend model-pinning test: `pins solicitation_ask to the shared model pair at temperature 0.6`
  (INTAKE title). Note: existing test asserts temp 0 for structured tasks — scope that
  assertion to triage/judge; solicitation_ask is structured AND 0.6 by design.
- [ ] `pnpm test src/lib/responses/__tests__/model-pinning.test.ts` → PASS. Commit.

## Task 3: Cost chain — task-scoped estimate + ask regen budget

**Files:** modify `src/lib/costs/tracker.ts`, `src/lib/costs/cost-guard.ts`; tests in
`src/lib/costs/__tests__/`.
**Blocking edges:** none (parallel-safe with Tasks 1–2).

- [ ] Failing tests first (INTAKE titles, verbatim):
  - `reserves, finalizes, and releases with the same task-scoped estimate` — reserve at
    `estimateCents: 1`, assert Redis INCRBY of 1 (not 15); finalize with actual
    `actualCostCents: 0` asserts adjustment `-1` (INTEGER cents only — `withCostGuard`
    rejects non-safe-integer costs at cost-guard.ts:59 and Redis INCRBY is integer-only;
    callers round via `Math.ceil(usd * 100)`, generator.ts:168 precedent); release
    asserts `-1`. Existing-caller regression case: omitted param ⇒ 15 everywhere.
  - `acquires no concurrency slot when withConcurrency is false` — spy on
    `acquireConcurrencySlot`; `withCostGuard({... withConcurrency: false, estimateCents: 1}, fn)`
    never calls it (extend existing cost-guard test file if one covers this — check first;
    if covered, the new assertion is estimateCents pass-through).
  - `enforces the three-per-day ask regeneration budget in the worker` lives in Task 10
    (worker seam) — here add the primitive's unit: `checkAskRegenBudget` throws
    `RegenBudgetExceededError` on the 4th call for one askId (key `regen:ask:{askId}:{date}`,
    TTL 86400).
  - Property (INTAKE): `reserve followed by release restores the daily counters for any estimate`
    — fast-check integer estimate 1..50, house style from
    `src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block.
- [ ] Implement: `reserveCost(businessId, tier, estimateCents = PESSIMISTIC_ESTIMATE_CENTS)`;
  `finalizeCost(businessId, actualCostCents, reservationDate, estimateCents = PESSIMISTIC_ESTIMATE_CENTS)`;
  same for `releaseCost`. `CostGuardOptions.estimateCents?: number`; `withCostGuard` passes
  it to all three — the estimate travels via the closure, NEVER re-read from the module
  constant on finalize/release (SPEC §7.2: a reserve/finalize mismatch silently leaks budget).
  `checkAskRegenBudget(askId)` shares the private Lua primitive with `checkRegenBudget`
  (two named doors, one mechanism — `moderation/flags.ts` precedent); add read-only
  `peekAskRegenBudget` only if #629 needs it — it does not; skip (YAGNI).
- [ ] Cost-guard skill contract check: Redis transport failures on the new paths remain
  `CostInfraUnavailableError` (retryable); budget throws stay terminal. No reclassification.
- [ ] `pnpm test src/lib/costs` → PASS. Commit.

## Task 4: `ask-render.ts` — placeholders + footer assembly (pure)

**Files:** create `src/lib/solicitation/ask-render.ts` + `__tests__/ask-render.test.ts`.
**Blocking edges:** none.

- [ ] Interface (the byte-contract #630 substitutes into — AMEND B4):
  ```ts
  export const UNSUBSCRIBE_URL_PLACEHOLDER = '{{unsubscribe_url}}';
  export const REVIEW_LINK_PLACEHOLDER = '{{review_link}}';
  export interface AskFooterInput { businessName: string; postalAddress: string | null; }
  /** Returns null when postalAddress is missing/blank — caller withholds
   *  missing_required_element (render fails closed without a postal address, #622 §7.6). */
  export function assembleAskBody(llmBody: string, footer: AskFooterInput): string | null;
  ```
  Footer block: review-link line (placeholder), separator, sender identification
  (businessName), postal address verbatim, unsubscribe line (placeholder). Deterministic —
  same inputs, same bytes.
- [ ] Tests: byte-determinism; null on missing address; both placeholders present exactly once.
- [ ] Commit.

## Task 5: `ask-compliance-lint.ts` — admissibility + 7-class lint (pure, versioned)

**Files:** create `src/lib/solicitation/ask-compliance-lint.ts`,
`__tests__/ask-compliance-lint.test.ts`, golden file `__tests__/ask-lint-classes.golden.json`.
**Blocking edges:** Task 4 (imports placeholder constants for class 7).

- [ ] Interface (mirror `restraint-policy.ts` conventions — pure, no DB/clock/IO):
  ```ts
  export const ASK_LINT_VERSION = 'ask_lint_2026-07-30.1';
  export const ASK_BLOCK_REASONS = [/* SPEC §2.1 list, 8 members incl. moderation_high */] as const;
  export type AskBlockReason = (typeof ASK_BLOCK_REASONS)[number];
  export type NoteDisposition = 'admitted' | 'absent' | `rejected:${string}`;
  export function assessNoteAdmissibility(note: string | null): { admissible: boolean; disposition: NoteDisposition };
  export interface AskLintInput { subject: string; body: string; interpolationValues: readonly string[]; }
  export interface AskLintVerdict { blockedReason: Exclude<AskBlockReason,'moderation_high'> | null; matches: string[]; /* every class that matched, for lint_detail */ }
  export function lintAsk(input: AskLintInput): AskLintVerdict;
  ```
  `moderation_high` is in the vocabulary but never assigned by the lint (SPEC §2.1).
- [ ] Class table: SPEC §2.3 rows 1–7 with class 5 as amended by AMEND B5 — subject-only:
  leading Re:/Fwd:, deception patterns, non-empty, **≤80 chars**, ≤1 `!`, not ALL-CAPS,
  no URL, **≤1 emoji**, **no PII beyond contact first name** (PII check = any interpolated
  value other than `contact_first_name`/`business_name` appearing in subject, plus email/
  digit-run patterns). First-hit-wins order; all matches recorded. Class 6 = provenance
  (SPEC §2.4: capitalized non-sentence-initial tokens + digit runs must appear in
  interpolation values or the closed scaffolding allowlist). Class 7 = both placeholders +
  postal-address block present (imports Task 4 constants). Classes 1–4 apply the
  interpolated-value exemption (SPEC §2.5). Admissibility rules = SPEC §1.2 items 1–4.
  Module header records the deliberate non-reuse of `output-filter.ts` (SPEC §2.7).
- [ ] Failing tests (INTAKE titles verbatim):
  `blocks incentive language introduced by the model` ·
  `does not block incentive-looking tokens inside interpolated values` ·
  `reports the earliest matching class as the block reason and every match in lint_detail` ·
  `blocks a subject over 80 characters` · `blocks a subject with more than one emoji` ·
  `blocks a subject carrying PII beyond the contact first name` ·
  `blocks a render missing the unsubscribe placeholder` ·
  `flags a capitalized token absent from interpolation inputs as unverifiable_fact` ·
  `omits an inadmissible note and records the rejection in note_disposition` ·
  `rejects a note containing a digit run of seven or more` ·
  plus one positive + one negative per remaining class (SPEC §9) and fast-check property
  `lint verdicts are deterministic across repeated evaluations of arbitrary subject and body`.
- [ ] Golden-file the full class table (regex sources serialized) so tuning is a visible diff.
- [ ] `pnpm test src/lib/solicitation/__tests__/ask-compliance-lint.test.ts` → PASS. Commit.

## Task 6: `ask-prompt-policy.ts` — prompt base + assembly

**Files:** create `src/lib/solicitation/ask-prompt-policy.ts` + `__tests__/ask-prompt-policy.test.ts`.
**Blocking edges:** Task 5 (uses `NoteDisposition` type for input shape).

- [ ] Mirror `src/lib/responses/prompt-policy.ts` exactly: `SOLICITATION_ASK_PROMPT_VERSION`,
  `SOLICITATION_ASK_PROMPT_BASE` (array-joined; MUST carry the five SPEC §1.3 lines incl.
  the verbatim untrusted-data line from prompt-policy.ts), memoized
  `solicitationAskPromptHash()` via `createHash('sha256')` (`node:crypto`, invariant #10).
- [ ] `AskInterpolationInputs` type = SPEC §5.3 shape (five allowlisted fields +
  `note_disposition`). `buildAskPrompt(inputs)` → `ChatPrompt`: labelled block; visit_note
  fenced + labelled untrusted; ABSENT entirely when inadmissible/absent. Bucketing fn
  `daysSinceVisitBucket(visitDate, decidedAt)` per SPEC §1.1 table (yesterday/a few days
  ago/last week/a couple of weeks ago/recently) — clock passed in, never read.
- [ ] Tests: hash stability + memoization; note fencing; note absence; bucket boundaries
  (0 → `today` per decision 10, then 1, 2, 4, 5, 9, 10, 17, 18 days); prompt contains all
  five policy lines.
- [ ] Commit.

## Task 7: Persistence + spine primitives (live-DB)

**Files:** modify `src/lib/solicitation/outreach.ts`, `src/lib/agents/run-spine.ts`;
tests `src/lib/solicitation/__tests__/outreach-render.integration.test.ts`,
extend `src/lib/agents/__tests__/run-spine.integration.test.ts`.
**Blocking edges:** none (schema shipped in 091/092).

- [ ] `outreach.ts` gains (all take `tx: TransactionSql` — invariant #15):
  ```ts
  export interface InsertOutreachRenderInput { /* ids, attemptNo, subject/body (null for render_failed/bodyless-withheld), promptVersion, promptHash, askLintVersion, lintDetail, moderationStatus, moderationDetail, interpolationInputs, deliveryStatus: 'rendered'|'withheld', dispositionReason, renderedAt, agentRunId } */ }
  export async function insertOutreachRender(tx, input): Promise<string>;
  export async function supersedeLiveRender(tx, { askId, accountId, businessId }): Promise<{ priorAttemptNo: number } | null>;
  //   UPDATE live row (delivery_status='rendered' only — B2: released rows never superseded)
  //   → 'cancelled'/'superseded'; returns null if no live rendered row (caller refuses).
  export function parseOutreachLintDetail(value: unknown, outreachId: string): ...
  export function parseOutreachModerationDetail(value: unknown, outreachId: string): ...
  export function parseOutreachInterpolationInputs(value: unknown, outreachId: string): ...
  ```
  Parsers follow `parseEvidence` (throw on non-object/bad discriminant — batch-view.ts:93-110
  precedent). Insert is unconditional (no ON CONFLICT — existence check upstream, plan header).
  JSONB via `tx.json()` (domain module — never `jsonb()`).
- [ ] `run-spine.ts` gains `startOrGetSolicitationSendBatchRun(tx, { batchId, accountId,
  businessId, correlationId? })` (kind `solicitation_send_batch` — 091 §1 widened the kind
  CHECK; mirror `startOrGetSolicitationBatchRun`) and
  `recordGenerationSteps(tx, { parentRunId, accountId, businessId, batchId })` —
  **database-derived**: ONE set-based `INSERT … SELECT` on `agent_run_steps` sourced from
  the batch's non-cancelled `solicitation_outreach` rows, NOT an in-memory array (retry
  completeness: a run that skipped already-persisted children still records their steps).
  EXEC D3: steps on the parent, no child fan-out; D17: NO `cost_cents` on steps — cost
  lives in `api_costs`. Closure is decision 8: the finale calls `closeBatchIfSettled`
  ALONE (outreach.ts:277 — it owns the batch lock, closure CAS, and parent transition
  internally); if its disposition mapping lacks D14's `generation_failed`, EXTEND it —
  never compose `failSolicitationBatchRun` beside it.
- [ ] Integration tests (live-DB conventions #573; `assertSchemaReady`; named
  `*.integration.test.ts`; no DDL): INTAKE titles verbatim —
  `supersedes the prior attempt and inserts attempt_no plus one in a single transaction` ·
  `writes a withheld moderation_high render whose body a direct authenticated read cannot return`
  (direct authenticated Supabase read — AMEND B1 test obligation) · plus: render_failed row
  satisfies all 091/092 CHECKs (locked fills); one-live-per-ask violated insert throws.
- [ ] Run explicitly with `TEST_DATABASE_POOL_URL` set. Commit.

## Task 8: `ask-generation.ts` — the deep orchestration module

**Files:** create `src/lib/solicitation/ask-generation.ts` + `__tests__/ask-generation.test.ts`
+ `__tests__/ask-generation.integration.test.ts`.
**Blocking edges:** Tasks 2, 3, 5, 6, 7.

- [ ] Interface (two doors):
  ```ts
  export const SOLICITATION_ASK_ESTIMATE_CENTS = 1; // SPEC §7.1/§7.2 — ~40× actual; NEVER the 15¢ reply estimate
  export interface GenerateAsksResult { rendered: number; withheld: number; failed: number; skippedExisting: number; }
  // outboxHandle = the extractOutboxHandle result — the finale tx completes the owned
  // attempt itself (decision 9), so the handle is part of the interface, not the handler's.
  export async function generateAsksForBatch(sql: Sql, input: { batchId: string; outboxHandle: OutboxHandle; correlationId?: string }): Promise<GenerateAsksResult>;
  export async function regenerateAsk(sql: Sql, input: { batchId: string; askId: string; outboxHandle: OutboxHandle; correlationId?: string }): Promise<void>;
  ```
- [ ] `generateAsksForBatch` sequence (children SEQUENTIAL — SPEC §7.3):
  1. Load batch + account (subscription status, tier) + business (name, category,
     `solicitation_postal_address` — column lands with #627; unreachable pre-flag, see
     DEVIATIONS) + send-asks with contact first name (first whitespace token — surnames
     never reach the model, SPEC §1.1) + latest visit (date, note). New query — the
     existing candidate window deliberately selects no PII; do not widen it.
  2. Gate: `solicitationSendEnabled()` off ⇒ no-op return (flag flipped between enqueue
     and run). `subscriptionGrantsFullAccess` fails ⇒ no-op (invariant #11). Zero send
     asks ⇒ no-op (defensive; build tx should not have enqueued).
  3. `startOrGetSolicitationSendBatchRun` in its own short tx.
  4. Per ask: **existence check FIRST — skip when ANY non-`cancelled` outreach row exists
     for the ask** (`skippedExisting`, NO reservation — decision 5: a `withheld` row is
     terminal and must never be re-generated on retry; SPEC §7.4's "live render" wording
     is superseded by this stricter check). Then build interpolation inputs
     (admissibility → disposition); `withCostGuard({ businessId, subscriptionTier,
     withConcurrency: false, estimateCents: SOLICITATION_ASK_ESTIMATE_CENTS,
     onFinalizeError: 'log-and-return-value' }, () => runLlmTask('solicitation_ask', prompt))`;
     on structured output → `assembleAskBody` (null postal ⇒ withheld,
     `disposition_reason='lint_failed'`, `lint_detail=['missing_required_element']`) →
     `lintAsk` (`blocked_reason` maps per AMEND B1: all SEVEN content classes fold to
     `lint_failed` with the matched classes in lint_detail; `moderation_high` keeps its
     own reason; lint-blocked rows use the decision-4 moderation fills — moderation is
     never called on copy already known non-compliant, SPEC §3.1) →
     `moderateResponse(subject + '\n' + body)` ONCE over both fields (SPEC §3.2 mapping:
     high ⇒ withheld/moderation_high; flagged med/low ⇒ rendered + moderation_detail;
     error/disabled ⇒ rendered with that status — produced, not dispatchable) →
     `insertOutreachRender` (+ `api_costs` row: prompt_version + hash, best-effort
     log-and-swallow — SPEC §7.6).
  5. Failure classification per SPEC §7.5: `LLMStructuredOutputError` ⇒ withheld
     `render_failed` (locked fills), continue batch; `TransientLLMError`/
     `CostInfraUnavailableError` ⇒ rethrow (BullMQ retry; idempotency resumes);
     `CostLimitExceeded`/`GlobalCostLimitExceeded` ⇒ decision 6 — STOP generating, write
     `withheld`/`render_failed` rows for every remaining un-generated ask
     (`interpolation_inputs='{}'` when never assembled), then proceed to the finale;
     the job COMPLETES (no rethrow — a same-day retry would fail identically).
  6. **Finale — ONE transaction (decisions 8+9), CAS FIRST:**
     `markOutboxCompletedIfOwned` (the exported primitive, outbox.ts:94 — NOT
     batch-builder's private wrapper) runs as the transaction's FIRST statement; a false
     result means a stale attempt — abort with ZERO domain writes (the CAS-before-mutation
     contract; batch-builder.ts:614 precedent). Only then: `recordGenerationSteps`
     (database-derived, Task 7) → `closeBatchIfSettled` (decision 8: alone — it owns any
     failure transition internally). A crash before commit leaves the outbox row
     dispatched → watchdog replay re-runs everything idempotently (children skip via
     decision 5; steps derive from DB; CAS succeeds on the replay).
  7. **No-op paths complete the outbox too**: the flag-off, subscription-denied, and
     zero-send-asks early returns each run a minimal tx containing only
     `markOutboxCompletedIfOwned` — a no-op is a SUCCESS, never a stranded dispatched row.
- [ ] `regenerateAsk` (decision 7 shape — NO transaction across the LLM call):
  1. Pre-checks, no tx: `checkAskRegenBudget(askId)` (worker-enforced — outbox replay
     cannot bypass); load ask + its non-cancelled row; refuse if none, if
     `delivery_status != 'rendered'` (covers withheld/blocked — INTAKE:
     `refuses regeneration for a blocked ask`, SPEC §8.2 r6), or batch
     halted/expired/released per AMEND B2.
  2. Generate the replacement (same per-child pipeline: reserve → LLM → lint → moderate),
     entirely outside any tx.
  3. ONE swap tx, in the B11 global lock order — `acquireSolicitationBatchLock` FIRST
     (advisory, transaction-scoped), then the batch row (`FOR UPDATE`, re-verify
     eligibility), then the outreach row (`FOR UPDATE`, re-verify still `rendered`) —
     all inside `sql.begin` (the PgBouncer FOR-UPDATE no-op gotcha); then
     then — with `markOutboxCompletedIfOwned` having run as the tx's FIRST statement
     (CAS-before-mutation; false ⇒ abort, zero writes) — `supersedeLiveRender` + insert
     the new render at `attempt_no+1` — UNCONDITIONAL of the new verdict (B2 mechanics; a
     blocked replacement leaves the ask with no live render = terminal) — + one regen
     step on the parent. If eligibility re-verification fails, roll back the domain
     writes but still complete the outbox row (own minimal tx), logging the discarded
     spend (accepted rare waste).
- [ ] Unit tests with fakes (mock `runLlmTask`, `moderateResponse`, cost fns): INTAKE titles
  `skips reservation for asks that already hold a live render at the current prompt version` ·
  `refuses regeneration for a blocked ask` · plus: a `withheld` attempt also skips (decision
  5 — blocked-is-terminal survives job retry) · budget-exhaustion mid-batch settles the
  remaining asks as withheld/render_failed and completes (decision 6) · moderation mapping
  rows · render_failed fills · sequential (no slot) behavior.
- [ ] Integration test: `re-running generation over a half-complete batch reserves nothing for rendered asks`
  (INTAKE, verbatim — seed 3 asks, render 2, re-run with counting fake reserve, assert 1).
- [ ] Commit.

## Task 9: Enqueue seam — flag, topic, helper, build-tx trigger

**Files:** modify `src/lib/solicitation/flags.ts`, `src/lib/shared/queue-names.ts`,
`src/lib/shared/worker-types.ts`, `src/lib/shared/job-outbox-helpers.ts`,
`src/lib/solicitation/batch-builder.ts`; tests in existing batch-builder +
job-outbox-helpers test files.
**Blocking edges:** none (parallel with 4–8); Task 10 depends on it.

- [ ] `flags.ts`: `solicitationSendEnabled()` via `readFlag('SOLICITATION_SEND_ENABLED')`
  (mirror `solicitationWatchEnabled`).
- [ ] `queue-names.ts`: `GENERATE_SOLICITATION_ASKS: 'generate_solicitation_asks'` (must
  byte-match 091's index predicate topic). `worker-types.ts`:
  `GenerateSolicitationAsksPayload { batch_id: string; ask_id?: string; correlation_id?: string }`.
- [ ] `job-outbox-helpers.ts`: `enqueueGenerateSolicitationAsks(tx, { outboxId?, batchId,
  askId?, correlationId? }): Promise<string | null>` — mirror `enqueueBuildSolicitationBatch`'s
  payload shape; `aggregate_id = batchId` (091 comment contract). **In-flight dedup is in
  the INSERT itself**: `ON CONFLICT (topic, aggregate_id) WHERE topic =
  'generate_solicitation_asks' AND status IN ('pending', 'dispatching', 'dispatched') DO
  NOTHING RETURNING id` — predicate spelled byte-for-byte against 091's partial index
  (CLAUDE.md gotcha; the in-flight literal is a sanctioned re-spell site audited by
  `ci:outbox-status`). No row returned ⇒ `null` = already in flight — the atomic,
  exception-free form of the locked "regeneration already in progress" contract
  (`enqueueValidatePlaceId` is the dedup-variant precedent). The build-tx caller treats
  `null` as fine (idempotent build retry); #629's route surfaces it as 409. AMEND B10
  discharged: helper + first call site land together; `ci:outbox-seam` derives coverage
  from the helper file itself.
- [ ] `batch-builder.ts`: in the `built_at` tx, after the CAS — when
  `solicitationSendEnabled()` && sendCount > 0 ⇒ `enqueueGenerateSolicitationAsks` (EXEC
  D21). Zero send asks ⇒ no enqueue, no parent, watch-mode report unchanged.
- [ ] Tests: INTAKE title `does not enqueue generation when the batch has zero send asks`
  (and: flag off ⇒ no enqueue; flag on + send asks ⇒ outbox row in same tx). Extend the
  existing batch-builder test file.
- [ ] `pnpm ci:outbox-seam && pnpm ci:outbox-topics && pnpm ci:outbox-status` → PASS. Commit.

## Task 10: Worker handler + registration

**Files:** create `worker/jobs/solicitation-batch/generate.ts`,
`worker/jobs/solicitation-batch/generate-failed-hook.ts`; modify `worker/index.ts`;
tests `worker/jobs/solicitation-batch/__tests__/generate.test.ts`.
**Blocking edges:** Tasks 8, 9.

- [ ] `generate.ts`: thin composition root — `extractOutboxHandle`, dispatch on
  `payload.ask_id` presence: `regenerateAsk` vs `generateAsksForBatch`, passing the
  outbox handle through — the DOMAIN finale tx completes it (decision 9; batch-builder
  precedent), the handler does not. `generate-failed-hook.ts`: mirror `failed-hook.ts`
  (Sentry + outbox failure marking). Handler failure semantics: regen-budget throw
  terminal; transient rethrow for BullMQ retry; budget-exceeded completes via decision 6
  inside the domain module.
- [ ] `worker/index.ts`: register `Worker<GenerateSolicitationAsksPayload>` on
  `QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` per the `:287-300` pattern; add to health map
  (`:414`); add to `assertSummedLlmWorkerSlots` (`:327` — LLM-calling worker; note
  `withConcurrency:false` means the sum contribution is its BullMQ concurrency of 1 —
  verify the assert's contract when editing).
- [ ] Worker tests (mock `ask-generation`): INTAKE titles verbatim —
  `enforces the three-per-day ask regeneration budget in the worker` (budget throw ⇒
  terminal, no LLM call) ·
  `terminalizes the send parent failed with generation_failed when every render fails or is withheld`
  (integration-flavored; may live in ask-generation.integration.test.ts if cleaner — keep
  the title verbatim wherever it lands).
- [ ] `pnpm test worker/jobs/solicitation-batch` → PASS. Commit.

## Task 11: Read model — live render join + redaction

**Files:** modify `src/lib/solicitation/batch-view.ts`; extend its test files.
**Blocking edges:** Task 7 (parsers).

- [ ] Join the ask's current attempt — `delivery_status != 'cancelled'` (NOT the live-only
  predicate: `withheld` rows are terminal yet owner-visible; lint blocks teach, SPEC §5.2).
  At most one such row exists per ask: `withheld` ends the attempt line (no regen, r6) and
  a `rendered` row is only ever replaced via the atomic supersede swap. Expose
  subject/body, attempt_no, disposition; **withhold subject/body when
  `disposition_reason='moderation_high'`** — count + reason + redaction marker only
  (SPEC §3.3; DB RLS is the second layer, app-enforced here because server reads bypass RLS).
- [ ] Use Task 7 parsers for the three JSONB reads (PgBouncer carve-out).
- [ ] Tests: redaction case; drafted case exposes bytes; withheld `lint_failed` exposes
  text + classes (SPEC §5.2: lint blocks teach the owner).
- [ ] Commit.

## Task 12: Docs, allowlist, registry + final gate

**Files:** modify `.claude/CLAUDE.md`, `.claude/reference/env-vars.md`.
**Blocking edges:** Tasks 7, 9, 11.

- [ ] CLAUDE.md JSONB allowlist: 16 → 19 — add the three `solicitation_outreach` parser
  sites (named by file: the shared parsers in `outreach.ts`, consumed by batch-view +
  worker re-reads), keeping the allowlist's per-table grouping style.
- [ ] env-vars.md: `SOLICITATION_SEND_ENABLED` row in the flags section (server-only,
  default off, accessor `solicitationSendEnabled()`, masters the whole send surface incl.
  generation — decision 7; note the #627 postal-address precondition for any flip).
  `SOLICITATION_ASK_ESTIMATE_CENTS` is a code constant, NOT an env var — no row.
- [ ] Full gate: `bash scripts/verify-gate.sh` (all ci:* audits, promised-tests row must
  find all 24 INTAKE titles verbatim, integration suites with `TEST_DATABASE_POOL_URL`).
- [ ] Commit.

---

## Self-review checklist (run after drafting, before adversarial review)

- Spec coverage: §1 interpolation (T6), §2 lint (T5), §3 moderation (T8), §4 task+schema
  (T1/T2), §5-as-amended storage+read model (T7/T11), §6 placement (all), §7 cost (T3/T8),
  §8 regen (T7/T8/T10), §9 tests (distributed, titles verbatim), §10 #628 bindings
  (T1 temperature, T3 estimate, T12 allowlist; offboarding entry VOID per deviations).
  AMEND: B1 (T7/T11), B2 (T7/T8), B4 (T4), B5 (T5), B10 (T9). EXEC: D21 (T9), D3/D17 (T7/T8),
  D14 (T8/T10).
- Every INTAKE `tests_to_add` title appears in exactly one task, verbatim.
- No task edits outside `allowed_edit_surface`.
