# Solicitation send worker (#899) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-child Solicitation send worker — the **Dispatch gate**, the unsubscribe token mint, the **Messaging adapter** call, and the terminal transaction that CASes the **Outreach row**, terminalizes the **Lazy child**, emits `solicitation_sent`, completes the outbox row and calls `closeBatchIfSettled`.

**Architecture:** One thin composition root (`worker/jobs/solicitation-send.ts`) delegates to one deep domain module (`src/lib/solicitation/dispatch.ts`). The domain module runs the two slow gate checks with **no lock held**, then a short `tx1` (lock batch → fast gate items → stamp consent snapshot → create Lazy child → mint token → CAS `queued → sending`), then the provider call with **no lock held**, then a short `tx2` that commits every terminal fact in ONE transaction. Retry classification lives in its own pure module. No migration — #898's migration 110 carries this family's schema work.

**Tech Stack:** TypeScript, Postgres.js (`postgres`), BullMQ, Vitest, fast-check, Resend (behind the Messaging adapter seam).

---

## Governing documents — read before implementing

| Document | What it settles |
|---|---|
| `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` **B3, B4, B6, B10, B14** | Wins on conflict. B6 is the gate stated once; B14 cuts it to seven items. |
| `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` §4, D12, D14, D18 | Two-transaction shape, retry classification, outcomes, gate content. |
| `CONTEXT.md` → **Dispatch gate**, **Outreach row**, **Lazy child**, **Send batch parent**, **Settled batch**, **Halt latch**, **Owner approval**, **Messaging adapter**, **Solicitation lane**, **Send handoff** | LOCKED vocabulary. Use these terms verbatim in code, comments, commits and step keys. |
| `.feature/intake.json` | The 8 locked grilling decisions and the 23 promised test titles. |

**Vocabulary trap:** `no_postal_address` is a dispatch-time fact about one **Outreach row**. It is a *different fact* from the **Send handoff**'s `postal_address_missing`, which is a handoff-time fact about the business. Never collapse them.

---

## The nine locked decisions (do not re-litigate)

1. `QUEUE_NAMES.SOLICITATION_SEND` lands here. `enqueueSolicitationSend` does **not** — it ships with its producer in #900 (amendment B10).
2. Resend's per-team 10 req/s pacing is **#900's**. #899 only classifies a 429 as retryable.
3. Re-lint and re-moderation run **before `tx1` opens**, over the immutable stored bytes. Their verdicts are applied at gate slots 8 and 9 inside `tx1`.
4. A retry that finds the row already `sending` **never re-gates**. See decision 9 for what it may and may not do.
5. `SOLICITATION_SEND_ENABLED` off mid-drip ⇒ **defer**: leave the row `queued`, complete the outbox row, do not throw, do not terminalize.
6. The dispatch moderation verdict **never overwrites** `moderation_status` / `moderation_detail` (render provenance, amendment B1).
7. The **Lazy child** run is created **here**, inside `tx1`.
8. Child terminal status follows what happened: `completed` (withheld or sent) / `cancelled` (halted) / `failed` (hard bounce, `terminal_other`, or exhaustion).
9. **Retry lives INSIDE one handler invocation, never across a process boundary.** The raw
   unsubscribe token exists only in memory (invariant #5), so a fresh process cannot rebuild
   the same unsubscribe URL. Therefore:
   - Retryable provider failures are retried **in process**, with bounded jittered backoff,
     while the raw token is still in scope. This is also CLAUDE.md's standing rule for every
     outbound provider call.
   - If the handler dies and BullMQ re-invokes, the raw token is gone. The worker **must not
     re-send**. It completes the outbox row, leaves the Outreach row `sending`, and lets
     #900's D12d sweep terminalize it `unknown` / `send_indeterminate` after
     `UNKNOWN_GRACE_MINUTES`.
   - Cost accepted and stated: a process crash mid-send loses that one contact to `unknown`.
     That is precisely the state D12d created for "we do not know whether this was sent", and
     it is the only answer that neither lies nor persists raw token material.

---

## File structure

| File | Responsibility | New? |
|---|---|---|
| `src/lib/shared/queue-names.ts` | Add `SOLICITATION_SEND: 'solicitation_send'`. Must byte-match migration 091's `job_outbox_solicitation_send_inflight` predicate topic. | modify |
| `src/lib/shared/worker-types.ts` | Add `SolicitationSendPayload extends BasePayload`. | modify |
| `src/lib/agents/run-spine.ts` | Add two `STEP_PERSONA` entries: `dispatch_gate_evaluated`, `ask_sent`, both persona `solicitation`. | modify |
| `src/lib/solicitation/send-retry.ts` | **Pure.** `classifySendFailure(err) => SendFailureClass`. D12c's table, one owner. | **create** |
| `src/lib/solicitation/ask-compliance-lint.ts` | Add the pure `lintInputFromSnapshot` mapper — the single owner of which stored values feed the lint (plan review S7). | modify |
| `src/lib/solicitation/ask-generation.ts` | Refactor `assembleInterpolation`'s two value lists through that mapper, so generation and dispatch cannot diverge. | modify |
| `src/lib/solicitation/dispatch.ts` | The deep module. Exports `dispatchOutreach` (orchestrator) and `applyDispatchGate` (pure verdict). | **create** |
| `worker/jobs/solicitation-send.ts` | Composition root. Extract outbox handle, call one domain function. | **create** |
| `worker/jobs/solicitation-send/failed-hook.ts` | `'failed'` exhaustion hook: `failed` / `send_exhausted` + `closeBatchIfSettled`. | **create** |
| `worker/queues.ts` | Queue instantiation + `QUEUE_BY_NAME` row. | modify |
| `worker/index.ts` | `new Worker` + `.on('failed', …)`, inside the existing registration loop that attaches `attachEmitterErrorLogger` and `attachJobFailureSink`. | modify |
| `docs/directory.md` | One row per new production file. CI-enforced by `ci:directory-map` in the same PR. | modify |
| `CONTEXT.md` | Retire "no writer yet" (**Dispatch gate**) and "zero production callers" (**Messaging adapter**). | modify |
| `docs/superpowers/specs/…-cross-spec-amendments.md` | Record the four implementation decisions that refine B6/B4. | modify |

**No new file beyond those four.** `src/lib/solicitation/outreach.ts` was considered for `dispatchOutreach` and rejected: it owns the *render* lifecycle, and `ask-generation.ts` is the precedent for one module per lane. `lintInputFromSnapshot` was considered as a new file and rejected: `ask-compliance-lint.ts` already owns `AskLintInput`, so the function that builds one belongs there.

---

## Interfaces (defined once, referenced by every task)

```ts
// src/lib/shared/worker-types.ts
export interface SolicitationSendPayload extends BasePayload {
  batch_id: string;
  business_id: string;
  outreach_id: string;
}
```

```ts
// src/lib/solicitation/send-retry.ts
/** D12c's four classes. `terminal_bounce` is the only one that stamps bounced_at. */
export type SendFailureClass = 'terminal_bounce' | 'retryable' | 'terminal_other';

export function classifySendFailure(err: unknown): SendFailureClass;
```

```ts
// src/lib/solicitation/dispatch.ts

/** The seven items B6 leaves to the child, in B6's order. */
export type DispatchGateItem =
  | 'batch_open'          // 1. not halted, send window open
  | 'send_flag'           // 2. SOLICITATION_SEND_ENABLED
  | 'suppression'         // 4. Suppression ledger
  | 'consent'             // 5. consent row + SEND_ELIGIBLE_ATTESTATION_VERSIONS
  | 'postal_address'      // 6. exists and byte-matches the stored footer
  | 'lint'                // 8. re-lint at current ASK_LINT_VERSION
  | 'moderation';         // 9. clean provider verdict

/** Evidence gathered with NO lock held (decision 3). */
export interface SlowGateEvidence {
  lintPassed: boolean;
  moderationClean: boolean;      // false when OPENAI_MODERATION_ENABLED is off
}

/** Evidence gathered inside tx1 under the batch row lock. */
export interface FastGateEvidence {
  batchOpen: boolean;
  sendFlagOn: boolean;
  suppressed: boolean;
  consent: { rowId: string; basis: string; attestationVersion: string } | null;
  postalAddressMatches: boolean;
  postalAddressPresent: boolean;
}

export type DispatchGateVerdict =
  | { pass: true }
  | { pass: false; item: DispatchGateItem; outcome: 'withhold'; reason: OutreachWithheldReason }
  | { pass: false; item: DispatchGateItem; outcome: 'defer' };

/** PURE. The single owner of B6's order and of the withheld-reason mapping. */
export function applyDispatchGate(
  slow: SlowGateEvidence,
  fast: FastGateEvidence,
): DispatchGateVerdict;

export interface DispatchOutreachInput {
  batchId: string;
  businessId: string;
  outreachId: string;
  outboxHandle: OutboxHandle;
  correlationId: string;
}

export async function dispatchOutreach(sql: Sql, input: DispatchOutreachInput): Promise<void>;
```

**Reason mapping (`applyDispatchGate`), fixed here so no task re-derives it:**

| Item | Fails ⇒ |
|---|---|
| `batch_open` | `withhold` is wrong — the halt sweep already cancelled the row. Return `defer`; the caller no-ops. |
| `send_flag` | `defer` (decision 5 — 091/110 have no `flag_off` reason) |
| `suppression` | `withhold` / `suppressed` **+ emit `solicitation_suppressed_at_dispatch`** |
| `consent` | `withhold` / `no_consent` |
| `postal_address` | absent ⇒ `withhold` / `no_postal_address`; present but mismatched ⇒ `withhold` / `postal_address_mismatch` |
| `lint` | `withhold` / `lint_failed` |
| `moderation` | `withhold` / `moderation_high` |

---

## Task 0 — The eval task (the spec in executable form)

**Blocking edges:** none. Must land before any implementation task.

**Files:**
- Create: `src/lib/solicitation/__tests__/dispatch-gate.test.ts`
- Create: `src/lib/solicitation/__tests__/dispatch.test.ts`
- Create: `src/lib/solicitation/__tests__/dispatch.integration.test.ts`
- Create: `src/lib/solicitation/__tests__/send-retry.test.ts`
- Create: `worker/jobs/__tests__/solicitation-send.test.ts`
- Create: `worker/jobs/__tests__/solicitation-send-failed-hook.test.ts`

- [ ] **Step 1: Author all 23 promised test titles as failing tests**

Every title below must appear **VERBATIM** as an `it(...)` title. `scripts/verify-gate.sh`'s `promised-tests` row matches them literally, not semantically. Slices not yet buildable use `it.todo(...)` and are converted to real tests by the task that owns them.

Distribute them:

`dispatch-gate.test.ts` (pure, no DB):
1. `evaluates the seven Dispatch gate items in B6 order and reports the first failure`
2. `property: the Dispatch gate never reports a later item before an earlier one has passed`

`dispatch.integration.test.ts` (live DB — file name selects vitest's serialized `integration` project; **no run-time DDL**, call `assertSchemaReady`):
3. `withholds with no_postal_address when the location has no Attested postal address`
4. `withholds with postal_address_mismatch when the stored footer no longer byte-matches`
5. `withholds with suppressed and emits solicitation_suppressed_at_dispatch when the handle is on the Suppression ledger`
6. `withholds with no_consent when the consent row is missing or its attestation version is not send-eligible`
7. `withholds with lint_failed when the stored bytes fail the current ASK_LINT_VERSION`
8. `withholds with moderation_high and leaves the render moderation_status untouched`
9. `defers a queued Outreach row without terminalizing it when SOLICITATION_SEND_ENABLED is off`
10. `no-ops when the batch is halted and the Outreach row is already cancelled`
11. `mints one unsubscribe token row per outreach_id and stores only the SHA-256 hash`
12. `re-uses the existing token row on a retry so the provider idempotency retry has a stable body`
13. `substitutes the raw unsubscribe URL in memory and never writes it to Postgres`
14. `resumes a sending Outreach row without re-running the Dispatch gate`
15. `persists provider_message_id on every successful send`
16. `commits the terminal CAS, the child run terminal, the solicitation_sent outcome, the outbox completion and closeBatchIfSettled in one transaction`
17. `emits solicitation_sent on the child run with unit_count 1, never on the Send batch parent`
18. `classifies a provider hard bounce as terminal with zero retries and stamps bounced_at`

`dispatch.test.ts` (unit, stubbed adapter):
19. `treats OPENAI_MODERATION_ENABLED=false as a failed re-moderation and never sends`
20. `runs re-lint and re-moderation before tx1 opens so no lock is held across a slow remote call`

`send-retry.test.ts` (pure):
21. `classifies a provider 5xx, timeout or rate limit as retryable`
22. `property: every provider error maps to exactly one retry class`

`solicitation-send-failed-hook.test.ts`:
23. `writes failed with send_exhausted on the terminal attempt and calls closeBatchIfSettled`

**Seven more, added by the round-2/3 plan review** (`docs/reviews/feat-899-solicitation-send-worker/plan-review-self.md`). These are a `tests_to_add` EXTENSION, recorded as an owner-approved deviations entry — not an `allowed_edit_surface` amendment, so they do not consume the abort budget:

`dispatch.integration.test.ts`:
24. `does not call the Messaging adapter when re-invoked in a fresh process without the raw token`
25. `ignores a stale outbox attempt and does not call the Messaging adapter`
26. `closes the batch once the last Outreach row terminalizes across a mixed sent, withheld and failed set`
27. `completes the outbox attempt when deferring on a flag-off so the watchdog does not re-pend it`
28. `does not cancel an in-flight sending child when a halt lands after the CAS`
29. `withholds rather than sending when the stored interpolation snapshot is absent`
30. `terminalizes a terminal_other provider error without retrying or leaving the Outreach row sending`

`dispatch.test.ts`:
31. `never logs the raw unsubscribe token or the recipient handle`
32. `retries a retryable provider failure in process with the same idempotency key and the same body`
33. `substitutes the review-link placeholder only in the outbound message and never sends the stored placeholder`

`solicitation-send-failed-hook.test.ts`:
34. `does not terminalize, fail the child, or complete the outbox before the final BullMQ attempt`

- [ ] **Step 2: Run the suites and confirm every non-`todo` test FAILS**

Run: `cd <worktree> && pnpm vitest run src/lib/solicitation/__tests__/dispatch-gate.test.ts src/lib/solicitation/__tests__/send-retry.test.ts`
Expected: FAIL — `Cannot find module '../dispatch'` / `'../send-retry'`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/solicitation/__tests__ worker/jobs/__tests__
git commit -m "test(899): eval task — 23 failing tests for the Dispatch gate, token mint and terminal transaction"
```

---

## Task 1 — Tracer: registration, vocabulary, pure gate, flag-off defer

**Blocking edges:** Task 0. **Runs ALONE** — the first-task enforcement spot check depends on it.

This is the thin vertical slice: a job arrives, the flag is off, the outbox row completes, nothing is sent.

**Files:**
- Modify: `src/lib/shared/queue-names.ts`, `src/lib/shared/worker-types.ts`, `src/lib/agents/run-spine.ts`, `worker/queues.ts`, `worker/index.ts`, `docs/directory.md`
- Create: `src/lib/solicitation/dispatch.ts`, `worker/jobs/solicitation-send.ts`

- [ ] **Step 1: Add the queue name**

In `src/lib/shared/queue-names.ts`, beside `GENERATE_SOLICITATION_ASKS`:

```ts
  // Must byte-match migration 091's in-flight partial-index predicate topic
  // (job_outbox_solicitation_send_inflight). Producer is the release poller
  // (#900); this consumer ships first so no row can be enqueued to a topic
  // with no registered worker (amendment B10).
  SOLICITATION_SEND: 'solicitation_send',
```

- [ ] **Step 2: Add the payload type**

In `src/lib/shared/worker-types.ts`, beside `GenerateSolicitationAsksPayload`:

```ts
export interface SolicitationSendPayload extends BasePayload {
  batch_id: string;
  business_id: string;
  outreach_id: string;
}
```

- [ ] **Step 3: Add the two spine step keys**

In `src/lib/agents/run-spine.ts`, inside `STEP_PERSONA`, after `ask_withdrawn`:

```ts
  dispatch_gate_evaluated: 'solicitation',
  ask_sent: 'solicitation',
```

`agent_run_steps.step_key` has **no DB CHECK** — this vocabulary is TypeScript-only, so no migration is needed. Verify with `grep -rn "step_key" supabase/migrations/*.sql | grep -i check` returning nothing.

- [ ] **Step 4: Write `applyDispatchGate` and the flag-off path in `src/lib/solicitation/dispatch.ts`**

Implement the interfaces block above verbatim. `applyDispatchGate` is pure: it walks the seven items in B6 order and returns the FIRST failure using the reason-mapping table above. `dispatchOutreach` at this task does only: read the outreach row, read the flag via `solicitationSendEnabled()`, and on flag-off complete the outbox attempt with `markOutboxCompletedIfOwned` and return.

Precedents to follow exactly:
- Module doc-comment and `sql`/`tx` parameter style: `src/lib/solicitation/ask-generation.ts:1-140`
- Outbox no-op completion: `ask-generation.ts:799-810` (`completeOutboxNoop`)
- Logger: `createWorkerLogger('solicitation-send', correlationId)`

**Never log** the message body, subject, recipient handle or raw token.

- [ ] **Step 5: Write the composition root `worker/jobs/solicitation-send.ts`**

Mirror `worker/jobs/solicitation-batch/generate.ts` (42 lines) exactly: extract the outbox handle, call `dispatchOutreach`, return. No branching beyond payload shape.

- [ ] **Step 6: Register the queue and the worker**

`worker/queues.ts` — beside `generateSolicitationAsks`:

```ts
  solicitationSend: new Queue(QUEUE_NAMES.SOLICITATION_SEND, { connection: opts, defaultJobOptions }),
```

and a row in the topic→queue map, which is named **`topicToQueue`** (not `QUEUE_BY_NAME` — corrected during Task 1):

```ts
  [QUEUE_NAMES.SOLICITATION_SEND]: queues.solicitationSend,
```

Use `defaultJobOptions`, **not** `llmJobOptions` — this worker makes no LLM call.

`worker/index.ts` — beside `generateSolicitationAsksWorker`:

```ts
const solicitationSendWorker = new Worker<SolicitationSendPayload>(
  QUEUE_NAMES.SOLICITATION_SEND,
  withJobLogContext<SolicitationSendPayload>((job) => handleSolicitationSend(sql, job)),
  { ...workerOpts, concurrency: 1 },
);

solicitationSendWorker.on('failed', (job, err) =>
  handleSolicitationSendFailed(sql, job, err),
);

// Serial sending is structural, not incidental: one in-flight send at a time
// means this worker can never burst against Resend's per-TEAM 10 req/s limit,
// and it keeps the provider idempotency key's one-attempt-at-a-time assumption
// true. The guard reads the EFFECTIVE options, so a future edit that drops
// concurrency: 1 fails boot instead of silently double-sending.
assertSingleConcurrencyWorker(QUEUE_NAMES.SOLICITATION_SEND, solicitationSendWorker.opts);
```

Three registration facts, pinned so nobody has to guess:

1. **Explicit `concurrency: 1` is required.** `assertSingleConcurrencyWorker` checks
   `opts.concurrency !== 1` and therefore REJECTS an undefined concurrency, even though
   BullMQ's own default is 1. Bare `workerOpts` would fail boot.
2. **Do NOT add this worker to `assertSummedLlmWorkerSlots`** (`worker/index.ts:357`). That
   list inventories `runLlmTask` callers, and this worker calls none — only `moderateResponse`,
   which is a separate free endpoint outside the LLM task seam. The non-gated sum already sits
   at the cap of 9, so adding it non-gated would fail boot for the wrong reason.
3. **`assertSolicitationSendEnv` needs no change** (`worker/config/startup-assert.ts:476`). It
   already asserts `SOLICITATION_RESEND_API_KEY`, `SOLICITATION_SEND_FROM_ADDRESS`,
   `SOLICITATION_PLATFORM_DAILY_CAP` and `SOLICITATION_UNSUBSCRIBE_MAILTO` whenever
   `SOLICITATION_SEND_ENABLED=true`.

The `failed` hook is added in Task 7 — Task 1 registers no `.on('failed', …)` at all, and needs no stub.

**The `attachEmitterErrorLogger` / `attachJobFailureSink` loop does NOT auto-discover workers** (confirmed during Task 1). It iterates the explicit `workersByQueue` enumeration, so a new worker MUST get a row there or it silently receives neither listener — and an unlistened `'error'` is a fatal `uncaughtException`.

- [ ] **Step 7: Add `docs/directory.md` rows**

One row per new production file. `ci:directory-map` fails on a production file under `worker/` or `src/lib/` with no row.

- [ ] **Step 8: Turn tests 1, 2 and 9 green**

Run: `pnpm vitest run src/lib/solicitation/__tests__/dispatch-gate.test.ts`
Expected: PASS (2 tests).

Run: `pnpm vitest run src/lib/solicitation/__tests__/dispatch.integration.test.ts -t "defers a queued Outreach row"`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git commit -am "feat(899): register solicitation_send topic + worker; pure Dispatch gate verdict; flag-off defer"
```

---

## Task 2 — Fast gate evidence inside tx1

**Blocking edges:** Task 1.

**Files:** Modify `src/lib/solicitation/dispatch.ts`; convert tests 3, 4, 5, 6, 10.

- [ ] **Step 1: Open `tx1` in the exact precedent order**

`SELECT … FOR UPDATE` is a **no-op outside `sql.begin()`** under PgBouncer — the whole of `tx1` must sit inside one `sql.begin(async (tx) => { … })`.

Four statements, in this order, copied from `src/lib/solicitation/ask-generation.ts:988-1010`:

```ts
// 1. Stale-attempt guard FIRST. Without it, attempt N-1's job can arrive after
//    attempt N was dispatched and BOTH reach the provider. (plan review S2)
const owns = await lockDispatchedOutboxAttemptIfOwned(tx, outboxId, attempt);
if (!owns) { logger.warn('solicitation send: stale outbox attempt — nothing done', {...}); return; }

// 2. Per-business advisory lock.
await acquireSolicitationBatchLock(tx, input.businessId);

// 3. Batch lifecycle row, locked.
const [batchRow] = await tx<BatchLifecycleRow[]>`
  SELECT built_at, approved_at, veto_deadline_at,
         sending_started_at, send_closed_at, halted_at
  FROM solicitation_batches
  WHERE id = ${input.batchId}::uuid AND business_id = ${input.businessId}::uuid
  FOR UPDATE
`;

// 4. batchOpen comes from the domain function, never a hand-rolled window check.
const state = deriveBatchState(batchRow, new Date());
```

`attempt` is required: mirror `ask-generation.ts:789`'s `requireAttempt` and throw when the payload carries no `outbox_attempt`, rather than silently taking the unguarded path.

- [ ] **Step 2: Gather `FastGateEvidence`**

- `batchOpen`: `halted_at IS NULL` and `NOW() < approved_at + BATCH_SEND_WINDOW_HOURS`. Use `BATCH_SEND_WINDOW_HOURS` from `src/lib/solicitation/outreach.ts`, never a literal.
- Re-read the Outreach row `FOR UPDATE`. If `delivery_status = 'cancelled'` ⇒ no-op, complete the outbox attempt, return (test 10).
- `suppressed`: `suppressionMatchSql` from `src/lib/solicitation/suppression.ts`. Do **not** re-spell its predicate.
- `consent`: `solicitation_consent` on `(channel, normalized_handle, business_id)`, then `SEND_ELIGIBLE_ATTESTATION_VERSIONS` from `src/lib/solicitation/attestation.ts`.
- `postalAddressPresent` / `postalAddressMatches`: `readPostalAddressState(tx, { accountId, businessId })` from `src/lib/solicitation/postal-address.ts:199`. It is account-scoped and returns `null` for a business outside the account.

  **The byte-match, resolved exactly.** `assembleAskBody` (`src/lib/solicitation/ask-render.ts:57`) bakes `footer.postalAddress` into the body **verbatim, as its own line**, and refuses to assemble at all when the address is null or whitespace-only. So:
  - `postalAddressPresent` = `state !== null && state.address !== null && state.address.trim().length > 0`
  - `postalAddressMatches` = the stored body contains that address as an exact line

  Do **not** re-derive the footer or re-run `assembleAskBody` at dispatch. The stored bytes are the contract; the check is a containment test against them. Migration 099's all-or-nothing CHECK means `address !== null` and `attestedAt !== null` cannot disagree, so the check never branches on "is this attested".

- [ ] **Step 3: Stamp the consent snapshot on the Outreach row**

Migration 091 comments `consent_basis` / `consent_attestation_version` / `consent_row_id` as "consent snapshot, stamped at dispatch by #630 (nullable until then)". Write all three in `tx1` from the consent row read in Step 2. **This ticket is that writer.**

- [ ] **Step 4: Withhold path**

On a `withhold` verdict, in the same `tx1`: set `delivery_status='withheld'` + `disposition_reason`, create the **Lazy child** via `startOrGetSolicitationAskRun`, `recordStep` `dispatch_gate_evaluated` with the verdict in `detail`, terminalize the child `completed` via `completeRun`, complete the outbox attempt, and call `closeBatchIfSettled`. On the `suppression` item also emit `solicitation_suppressed_at_dispatch` via `enqueueAnalyticsEvent` (`src/lib/analytics/enqueue.ts:20`, takes an executor so it joins `tx1`) with a deterministic `eventKey` of `solicitation_suppressed_at_dispatch:<outreachId>` — the event is already registered in both the DB (migration 097) and TypeScript (`src/lib/analytics/events.ts:27`), so no registration work is needed.

**Getting the Send batch parent run id — resolved here so nobody guesses.** `startOrGetSolicitationAskRun` requires a `parentRunId`, and there is today **no read-only lookup** for the **Send batch parent**; the only helper is `startOrGetSolicitationSendBatchRun`, which would CREATE one. The send worker must never invent a parent — a missing parent means generation never ran, which is an impossible state, and the house rule is to assert impossible states rather than branch around them.

So add a read-only helper to `src/lib/agents/run-spine.ts` (already in the edit surface):

```ts
/**
 * Read the active Send batch parent for one batch. Returns null when there is
 * none — which the send lane treats as an impossible state and throws on,
 * rather than creating a parent the generation lane was supposed to create.
 */
export async function findActiveSolicitationSendBatchRun(
  tx: TxClient,
  input: { batchId: string; accountId: string; businessId: string },
): Promise<{ runId: string } | null>;
```

The lookup is unambiguous: `agent_runs_one_active_per_subject` keys on
`(kind, subject_type, subject_id)`, so `kind='solicitation_send_batch'` +
`subject_type='solicitation_batch'` + `subject_id=batchId` + `status='running'` matches at most
one row. Model it on `findActiveReviewRun` (`run-spine.ts:421`). `dispatchOutreach` throws with
the batch id in the message when it returns null.

Do **not** emit `solicitation_sent` on a withhold. Do **not** touch `moderation_status` / `moderation_detail` (decision 6).

- [ ] **Step 5: Turn tests 3, 4, 5, 6, 10 green**

Run: `pnpm vitest run src/lib/solicitation/__tests__/dispatch.integration.test.ts`
Expected: those five PASS; the rest still `todo` or failing.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(899): tx1 fast Dispatch gate evidence, consent snapshot stamp, withhold path"
```

---

## Task 3 — Slow gate evidence before tx1

**Blocking edges:** Task 2. Same file as Task 2 — **serial, not parallel**.

**Files:** Modify `src/lib/solicitation/dispatch.ts`; convert tests 7, 8, 19, 20.

- [ ] **Step 0: Extract the lint-input mapper (blocking prerequisite — plan review S7)**

`lintAsk` (`src/lib/solicitation/ask-compliance-lint.ts:726`) does NOT take bytes. Its input is:

```ts
interface AskLintInput {
  subject: string;
  body: string;                                // ASSEMBLED, footer included
  interpolationValues: readonly string[];      // classes 1-4 exemption corpus
  subjectDisallowedValues: readonly string[];  // caller decides explicitly, fail-closed
}
```

Today those two lists are built by `assembleInterpolation` (`ask-generation.ts:349`), which is
**not exported** and builds them from the **live** ask row and visit. Calling it at dispatch
would re-derive against data that may have changed since render, breaking the byte-for-byte
**Owner approval** contract this gate exists to protect.

Add a pure mapper to `ask-compliance-lint.ts` — it already owns `AskLintInput`, so it should
own the function that builds one:

```ts
export function lintInputFromSnapshot(
  snapshot: AskInterpolationInputs,
  subject: string,
  body: string,
): AskLintInput;
```

Then refactor `assembleInterpolation` to build its two lists through the same mapper, so
"which stored values feed the lint" keeps exactly one owner. This is the second use, so the
abstraction is earned, not speculative.

- [ ] **Step 1: Gather `SlowGateEvidence` with no lock held**

Before `sql.begin`, read the stored subject, body and `interpolation_inputs`, then:
- Snapshot: `parseOutreachInterpolationInputs(row.interpolation_inputs, outreachId)`
  (`src/lib/solicitation/outreach.ts:634` — an already-sanctioned PgBouncer JSONB parse site).
  **A null snapshot is not a lint pass.** It means a never-assembled `render_failed` row or a
  redacted row. Both withhold; neither ever sends.
- `lintPassed`: `lintAsk(lintInputFromSnapshot(snapshot, subject, body)).blockedReason === null`.
- `moderationClean`: `moderateResponse(`${subject}\n${body}`)` from `src/lib/moderation/moderate.ts`.

**Fail-CLOSED here**, unlike generation. `moderationClean` is true only when the provider returned a clean verdict. `OPENAI_MODERATION_ENABLED=false` and a provider error are **both** false (#623 §3.4 — "a clean provider moderation verdict is a DISPATCH precondition, not a GENERATION precondition").

Why this runs outside the lock: stored bytes are immutable after approval (ADR 0020 — `regenerateAsk` refuses in every state but `built`), so the verdict cannot go stale, and the repo rule "never hold a lock across a slow remote call" binds.

- [ ] **Step 2: Pass both evidence objects to `applyDispatchGate` inside tx1**

The gate's B6 order is unchanged — only the *gathering* moved. `lint` and `moderation` remain items 8 and 9, so a suppressed contact still reports `suppressed`, not `lint_failed`.

- [ ] **Step 3: Turn tests 7, 8, 19, 20 green**

Test 20 asserts ordering structurally: stub `moderateResponse` and assert it resolved **before** the first `sql.begin` callback ran.

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(899): re-lint + re-moderation before tx1, fail-closed per spec 3.4"
```

---

## Task 4 — Unsubscribe token mint (invariant #5)

**Blocking edges:** Task 3.

**Files:** Modify `src/lib/solicitation/dispatch.ts`; convert tests 11, 12, 13.

- [ ] **Step 1: Mint inside tx1, after the gate passes**

Use `mintUnsubscribeRawToken()` and `hashUnsubscribeToken()` from `src/lib/solicitation/unsubscribe.ts`. Insert into `solicitation_unsubscribe_tokens` with `id` = `uuidv7()`, `token_hash`, `normalized_handle`, `channel='email'`, provenance (`account_id`, `business_id`, `ask_id`, `outreach_id`), `sent_at = NOW()`.

**Idempotent on `outreach_id`.** `ON CONFLICT` must match `solicitation_unsubscribe_tokens_outreach_uniq` **BYTE-FOR-BYTE** or Postgres will not infer the constraint. On conflict the existing row wins.

- [ ] **Step 2: Handle the conflict path honestly (decision 9)**

A retry re-enters with the token row already present, and the raw token is **not recoverable
from the hash**. The mint therefore returns the raw token only on first insert, and on
conflict it returns nothing.

This is the whole reason decision 9 exists. A conflict means we are in a fresh process after
a crash: the worker **must not** re-send. It completes the outbox row, leaves the Outreach row
`sending`, and lets #900's D12d sweep terminalize it `unknown`. Do NOT re-issue to the
provider hoping idempotency saves you — if the original request never reached Resend, the
retry's body is what gets sent, and it would carry no working unsubscribe URL.

Document this in the module comment. B4's "idempotent on `outreach_id`" guarantees the token
row is never duplicated; it does **not** guarantee a recoverable body.

- [ ] **Step 3: Substitute BOTH placeholders in memory only**

Build the `OutboundMessage` (`src/lib/messaging/messaging-adapter.ts:24-47` — every field
required) by substituting **both** deterministic placeholders named by B4 — the unsubscribe
URL **and** the review link — into the stored bytes **in memory**. Never write the substituted
body back to Postgres. The postal address is already baked in verbatim and is part of the
byte-match.

**Both placeholders are already exported constants — import them, never re-spell the literals:**

```ts
import { UNSUBSCRIBE_URL_PLACEHOLDER, REVIEW_LINK_PLACEHOLDER } from './ask-render';
// '{{unsubscribe_url}}' and '{{review_link}}' — ask-render.ts:22 and :25.
// Both are documented there as "Replaced by #630 at dispatch". This ticket is #630.
```

`ask-render.ts` is read-only for this ticket: importing requires no edit, so no surface
amendment is needed.

Assert both placeholders are gone from every body field before calling the adapter. A recipient
receiving a literal `{{review_link}}` is a visible defect that no other test in this plan would
catch (plan review C4).

**Where each `OutboundMessage` identity field comes from** (all read inside `tx1`, so one round trip):

| Field | Source |
|---|---|
| `outreachId` | the **Outreach row** id — also the provider idempotency key |
| `accountId` / `businessId` / `batchId` | the Outreach row's own columns |
| `businessName` | `businesses.name` — the From display name, no "via RepWorth" suffix (§2.3) |
| `ownerEmail` | `businesses.owner_email` (`NOT NULL` since migration 001) — the Reply-To |
| `recipient` | `solicitation_contacts.email` via the row's `contact_id`. **Already normalized** — migration 086 stores it lowercased and trimmed, which is why it matches the suppression and consent lookups without re-normalizing |
| `subject` | `rendered_subject` |

`solicitation_contacts.email` is nullable because a contact may be phone-only. For an
`channel='email'` Outreach row a null recipient is an **impossible state** — assert with the
outreach id in the message, do not branch around it.

**The unsubscribe URL.** Spec §7.2 block 3 locks the shape: `https://repworth.net/u/<token>`.
Build it as `${getWorkerConfig().NEXT_PUBLIC_APP_URL}/u/${rawToken}` — the same accessor and the
same route the unsubscribe ingress already uses (`worker/ingress/unsubscribe.ts:195`). The
landing page exists at `src/app/(public)/u/[token]/page.tsx`. **Fail closed when
`NEXT_PUBLIC_APP_URL` is unset**, exactly as the ingress does at `unsubscribe.ts:202`: a message
whose opt-out link cannot resolve is a compliance defect, not a degraded send.

**Multipart is mandatory, and the row stores only ONE body — resolve it here.**
`solicitation_outreach` has a single `rendered_body` (plain text, newline-joined by
`assembleAskBody`). But `OutboundMessage` requires BOTH `bodyHtml` and `bodyText`, and
`EmailAdapter` rejects a blank `bodyText` outright (`email-adapter.ts:92`). Spec §7.1 locks the
reason: "Multipart: HTML + plain-text alternative, always. HTML-only is a meaningful spam
signal."

So derive both from the one stored body, after placeholder substitution:
- `bodyText` = the substituted stored body, unchanged.
- `bodyHtml` = the same text escaped with `escapeHtml` (`src/lib/shared/html.ts:2`) and newlines
  turned into line breaks, with the unsubscribe URL rendered as a real anchor — §7.2 requires
  it to be "human-facing, conspicuous".

This derivation is mechanical, deterministic and content-free, the same class B4 already
excludes from the byte-for-byte comparison. **`bodyText` must remain byte-identical to the
stored body apart from the two placeholder substitutions** — that is what keeps the **Owner
approval** contract honest, and it is the assertion to write.

**The adapter also needs the unsubscribe URL as its own field**, separate from the body: it
feeds `getEmailHeaders('solicitation', { unsubscribeUrl })` for the RFC 8058 `List-Unsubscribe`
header (`email-adapter.ts:32-36`). Same URL, two places, one mint.

**Logging:** every log line that references the token uses `unsubscribeTokenLogPrefix`
(`src/lib/solicitation/unsubscribe.ts:293`), never the raw token. Never log the recipient
handle, the subject or the body.

- [ ] **Step 4: Turn tests 11, 12, 13 green**

Test 13 asserts no raw token appears in any column of `solicitation_unsubscribe_tokens` or `solicitation_outreach`.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(899): unsubscribe token mint at dispatch — hash only, idempotent on outreach_id"
```

---

## Task 5 — Retry classification module

**Blocking edges:** Task 1 only. **Independent of Tasks 2–4** (disjoint file) — may run in parallel with Task 2.

**Files:** Create `src/lib/solicitation/send-retry.ts`; convert tests 21, 22.

- [ ] **Step 1: Implement D12c's table as a pure function**

| Condition | Class |
|---|---|
| provider 4xx invalid-recipient / hard bounce | `terminal_bounce` — zero retries |
| provider 5xx, timeout, rate-limit (incl. a Resend per-team 429) | `retryable` |
| anything else | `terminal_other` |

The two "render lane" rows of D12c (`CostInfraUnavailableError`, budget exceeded) are **out of scope**: this worker makes no LLM call, and the OpenAI moderation endpoint is free (#623 §3.4). Say so in the module comment so a later reader does not add a cost guard.

`EmailAdapter` THROWS on every failure (`messaging-adapter.ts:48-62`). Classify from the thrown error, not from a return value.

- [ ] **Step 2: Turn tests 21, 22 green**

Test 22 is a `fast-check` property over generated error shapes, asserting exactly one class per error. House style: the `invariants` describe block in `src/lib/reviews/__tests__/sentiment.test.ts`.

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(899): send-retry — D12c classification as a pure module"
```

---

## Task 6 — tx1 CAS, provider call, tx2 terminal transaction, resume path

**Blocking edges:** Tasks 4 and 5.

**Files:** Modify `src/lib/solicitation/dispatch.ts`; convert tests 14, 15, 16, 17, 18.

- [ ] **Step 1: Finish tx1 — create the child, CAS `queued → sending`**

Order inside `tx1` after the gate passes: create the **Lazy child** (`startOrGetSolicitationAskRun`), stamp `agent_run_id` on the Outreach row, `recordStep` `dispatch_gate_evaluated` status `completed`, mint the token, then CAS `delivery_status='queued' → 'sending'` with `sending_at = NOW()`. If the CAS matches zero rows another worker owns it — complete the outbox attempt and return.

- [ ] **Step 2: Provider call with NO lock held**

Outside `sql.begin`: `await getMessagingAdapter().send(message)`. Never `EmailAdapter` or a Resend client directly, and no call site names a channel. The idempotency key is already the outreach row id inside `EmailAdapter` (`email-adapter.ts:58`) — do not add a second one.

- [ ] **Step 3: tx2 — ONE transaction, five facts**

```
CAS sending → sent | failed
  + Lazy child terminal (completed on sent, failed on terminal_bounce)
  + solicitation_sent outcome on the CHILD, unit_count = 1   (sent only)
  + outbox row completion
  + closeBatchIfSettled
```

D12a: if `tx2` does not commit, the outbox row is not completed either, so the watchdog still owns the work. The orphan class is closed by construction — do **not** add a sweeper.

On success: stamp `provider_message_id` and `sent_at`. A `sent` row with NULL `provider_message_id` makes every later bounce unattributable — persisting it is not optional.

On `terminal_bounce`: `delivery_status='failed'`, `disposition_reason='send_failed'`, stamp `bounced_at`, child `failed`, **no** `solicitation_sent` outcome, and still call `closeBatchIfSettled`.

On `terminal_other` (plan review C2 — the third class the first draft left unhandled): `delivery_status='failed'`, `disposition_reason='send_failed'`, **no** `bounced_at` (nothing bounced), child `failed`, no `solicitation_sent` outcome, and `closeBatchIfSettled` still called. Never retried, never left `sending`. A class with no arm is how rows get stranded.

On `retryable`: retry **in process** (Step 4). Only when the in-process budget is exhausted does this terminalize the same way `terminal_other` does.

Use `recordOutcome` (`run-spine.ts:531`) — its `ON CONFLICT (agent_run_id, outcome_kind)` makes a post-commit retry safe.

- [ ] **Step 4: In-process retry, and the no-resend resume path (decision 9)**

Two distinct paths. Conflating them is the bug this step exists to prevent.

**(a) In-process retry.** Wrap the `adapter.send()` call in bounded jittered backoff while the raw token is still in scope — CLAUDE.md's standing rule for every outbound provider call. Every attempt carries the same idempotency key and the **same body**. This is where a 5xx, a timeout or a Resend per-team 429 is absorbed.

**(b) Fresh-process re-invocation.** At the very top of `dispatchOutreach`: if the Outreach row is already `sending`, **skip the Dispatch gate entirely** AND **do not call the adapter**. The raw token is unrecoverable, so no correct message can be built. Complete the outbox row, log with `unsubscribeTokenLogPrefix`, and return. #900's D12d sweep terminalizes the row `unknown` after `UNKNOWN_GRACE_MINUTES`.

Do NOT re-issue to the provider hoping idempotency saves you: if the original request never reached Resend, the retry's body is what gets sent, and it would carry no working unsubscribe URL.

Re-gating is forbidden in both paths. Recording `withheld` for a message that may already have reached a real person is the lie-with-teeth argument D12d makes for `unknown`.

Residual exposure, accepted and stated: a halt landing mid-retry does not stop this one child. That is D10's contract — halt excludes `sending` on purpose.

- [ ] **Step 5: Turn tests 14, 15, 16, 17, 18 green**

Test 16 asserts atomicity by aborting the transaction via `src/lib/shared/__tests__/helpers/abort-injection.ts` (note the path — it is under `shared`, not `solicitation`) and confirming that none of the five facts persisted. Do **not** use a temporary constraint — run-time DDL in a live-DB suite deadlocks (40P01) and fails `ci:live-db-suites`.

Also turn tests 24, 30 and 32 green here: the fresh-process no-send path, the `terminal_other` arm, and the in-process retry.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(899): tx1 CAS, adapter send, single terminal transaction, sending-row resume"
```

---

## Task 7 — `'failed'` exhaustion hook

**Blocking edges:** Task 6.

**Files:** Create `worker/jobs/solicitation-send/failed-hook.ts`; modify `worker/index.ts` (replace the Task 1 stub), `docs/directory.md`; convert test 23.

- [ ] **Step 1: Implement the hook**

Mirror `worker/jobs/solicitation-batch/generate-failed-hook.ts`. On the terminal attempt only: `delivery_status='failed'`, `disposition_reason='send_exhausted'` (both already in migration 091's CHECK), terminalize the child `failed`, `markOutboxFailed`, and `closeBatchIfSettled` — one transaction.

**Copy the terminal predicate verbatim from `worker/jobs/judge/failed-hook.ts:44-57`.** Do not reach for `isTerminalAttempt` from `src/lib/shared/outbox.ts` — that is the CATCH-BLOCK form (`attemptsMade + 1 >= maxAttempts`) and fires one attempt early here. Both are correct in their own call context; the judge hook's own comment says "do not unify them".

```ts
function isSendAttemptExhausted(job: Job<SolicitationSendPayload>): boolean {
  const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0
    ? job.opts.attempts
    : 1;
  // 'failed' EVENT context: the Worker emits 'failed' only after
  // job.moveToFailed() has incremented attemptsMade to include the failing
  // attempt, so with attempts=3 only 3/3 is terminal (2/3 still has a retry).
  return job.attemptsMade >= maxAttempts;
}
```

And the guard, which is exactly what test 34 pins:

```ts
if (!job || !isSendAttemptExhausted(job)) return;
```

Before the final attempt the hook must do **nothing at all** — no terminalization, no child failure, no outbox completion, no `closeBatchIfSettled`. Terminalizing early would close the batch and leave a later retry operating against an already-`failed` **Outreach row**.

- [ ] **Step 2: Delete the Task 1 stub and import the real hook in `worker/index.ts`**

- [ ] **Step 3: Turn tests 23 and 34 green, add the `docs/directory.md` row**

Test 34 is the **negative** case and is the one that actually pins the predicate (plan review C3): on a non-final `'failed'` event the hook must do nothing at all — no terminalization, no child failure, no outbox completion, no `closeBatchIfSettled`. Without it, an implementation can terminalize early, close the batch, and leave a later retry operating against an already-`failed` Outreach row.

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(899): solicitation-send failed hook — send_exhausted terminalization"
```

---

## Task 8 — Documentation sweep

**Blocking edges:** Task 7.

**Files:** Modify `CONTEXT.md`, `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md`, `docs/directory.md`.

- [ ] **Step 1: Retire the two "no writer yet" claims in `CONTEXT.md`**

- **Dispatch gate**: "It has **no writer yet**" ⇒ record that #899 is the writer, and add the two implementation facts: the slow items run before `tx1`, and a `sending` row resumes without re-gating.
- **Messaging adapter**: "It has zero production callers today and that is deliberate" ⇒ record `dispatchOutreach` as the first production caller.

Keep both entries inside their existing shape. `src/__tests__/claude-md-shape.test.ts` guards CLAUDE.md, not CONTEXT.md, but stay terse regardless.

- [ ] **Step 2: Record the four refining decisions in the amendments doc**

Add a `B15` section recording six #899 implementation decisions:

1. The two slow gate items (re-lint, re-moderation) run **before** `tx1` opens, over the immutable stored bytes. B6's ORDER is unchanged; only the gathering moved.
2. A `sending` row is never re-gated, and in a fresh process is never re-sent (decision 9). The raw unsubscribe token is unrecoverable, so recovery is D12d's `unknown`, not a second send.
3. A flag-off **defers** rather than terminalizing — 091/110 deliberately carry no `flag_off` withheld reason.
4. The dispatch moderation verdict does **not** overwrite `moderation_status` / `moderation_detail`; those stay render provenance per B1.
5. `lintInputFromSnapshot` is the single owner of "which stored values feed the lint", shared by generation and dispatch.
6. **B10 clarified, not overridden.** B10 assigns the `QUEUE_NAMES` entry and the typed helper to "#630". That was written before #630 was decomposed into #899 (consumer) and #900 (producer). The constant lands with the **consumer** because a BullMQ worker cannot be registered without its queue name; the helper lands with the **producer**, which is what B10's actual argument protects against. Raised as a conflict by the round-3 review and rejected with this reasoning.

- [ ] **Step 3: Confirm `docs/directory.md` is complete**

Run: `pnpm ci:directory-map`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -am "docs(899): record the send worker as Dispatch gate writer and first Messaging adapter caller"
```

---

## Execution order

```
Task 0 (eval)
  └─ Task 1 (ALONE — enforcement spot check)
       ├─ Task 2 ─ Task 3 ─ Task 4 ─┐
       └─ Task 5 ───────────────────┴─ Task 6 ─ Task 7 ─ Task 8
```

Tasks 2, 3, 4 and 6 all edit `src/lib/solicitation/dispatch.ts` and are **serial**. Task 5 is the only parallel opportunity — dispatch it alongside Task 2.

Task 3's **Step 0** (the `lintInputFromSnapshot` extraction) is the one part of Task 3 that touches `ask-compliance-lint.ts` and `ask-generation.ts` rather than `dispatch.ts`. It is a blocking prerequisite for the rest of Task 3 and must land as its own commit, so a regression in the shared mapper is bisectable away from the dispatch work.

**Review-round budget is spent.** All three plan-gate rounds were used (`planReviewRounds=3`). The owner's call on finding C1 substitutes for an `APPROVED` verdict. Any further plan-level disagreement goes to the owner, not to another round.

---

## Self-review

**Spec coverage.** Ticket §1 topic registration ⇒ Task 1 (helper deferred to #900 per decision 1, recorded in non-goals). §2 layout ⇒ Tasks 1, 7. §3 Dispatch gate ⇒ Tasks 1, 2, 3. §4 token mint ⇒ Task 4. §5 two-transaction shape ⇒ Task 6. §6 hard obligations (`provider_message_id`, adapter seam, Lazy child, `solicitation_sent` on child, `closeBatchIfSettled`) ⇒ Tasks 2, 6. §7 retry classification ⇒ Tasks 5, 6, 7. §8 analytics ⇒ Task 2. §9 rate limit ⇒ decision 2, assigned to #900, reaction implemented in Task 5.

**One obligation the ticket did not name**, found in migration 091 and added here: the consent snapshot columns (`consent_basis`, `consent_attestation_version`, `consent_row_id`) are commented "stamped at dispatch by #630". Task 2 Step 3 is that writer.

**Type consistency.** `SendFailureClass`, `DispatchGateVerdict`, `SlowGateEvidence`, `FastGateEvidence`, `DispatchOutreachInput` and `SolicitationSendPayload` are defined once in the Interfaces block and referenced by name everywhere below.

**Placeholders.** None. Every task names exact files, exact precedent file:line, and the exact test titles it turns green.
