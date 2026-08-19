# F1 — Send batch approval lane (FULL)

The five human-triggered verbs. Window PRs: #863/#629, #873/#860, #876/#865,
#883/#872, #868/#858, #870/#859.

## The shared spine

```mermaid
flowchart TD
  A["POST /…/batch/{approve,halt,regenerate,withdraw}<br/>route.ts (4 files)"] --> C["withScopedBatch<br/>scoped-batch-route.ts:111"]
  C --> D1["requireSolicitationSendWriteAccess<br/>location-scope.ts:68"]
  D1 -->|"!watch || !send flag"| X404["404<br/>location-scope.ts:72"]
  D1 --> E["requireWritableOwner → requireContactsLocationScope<br/>location-scope.ts:73 · scoped-batch-route.ts:124"]
  E --> G["readInput: readApproval / readBatchId / readBatchAsk<br/>approve/route.ts:22 · scoped-batch-route.ts:63 · :76"]
  G -->|null| X404b["404 uniform<br/>scoped-batch-route.ts:131"]
  G --> H{{"which verb"}}
  ADM["POST /api/admin/…/halt<br/>halt/route.ts:100 export :161"] --> ADM1["requireAdminWithAal2<br/>:101"]
  ADM1 --> ADM2["strictObject — tenant triple FROM BODY<br/>:62,:113"] --> H
  H -->|approve| V1["approveBatch :225"]
  H -->|halt| V2["haltBatch :587"]
  H -->|admin halt| V3["adminHaltBatch :672"]
  H -->|regenerate| V4["requestAskRegeneration :801"]
  H -->|withdraw| V5["withdrawAsk :1048"]
  V1 & V2 & V3 & V4 & V5 --> CB["canonicalBatchId — toLowerCase<br/>approval.ts:112"]
  CB --> TX["sql.begin<br/>:230 / 592 / 677 / 807 / 1056"]
  V4 -.->|"ONLY verb: enqueue BEFORE lock"| OB["enqueueGenerateSolicitationAsks<br/>approval.ts:813"]
  OB --> LK
  TX --> LK["lockBatchForAction<br/>approval.ts:144"]
  LK --> L1["LOCK 1 pg_advisory_xact_lock<br/>batch-builder.ts:220,224"]
  L1 --> L2["LOCK 2 solicitation_batches FOR UPDATE OF b<br/>approval.ts:155-175"]
  L2 --> L3["deriveBatchState (pure)<br/>outreach.ts:90"]
  L3 -->|"row absent"| NF{{"failure expression DIVERGES"}}
  NF -->|"approve/halt/adminHalt/withdraw"| NFR["return not_found<br/>:232 · :594 · :681 · :1058"]
  NF -->|"regenerate"| NFT["THROW RegenRequestAbort<br/>:823 — rolls back the outbox row"]
  L3 --> BODY["per-verb body"]
  BODY --> RS["LOCK 3 recordStep → agent_runs FOR UPDATE<br/>run-spine.ts:492"]
  RS --> CL["closeBatchIfSettled<br/>outreach.ts:317"]
```

**Lock order** (`approval.ts:34-42`): advisory batch lock → `solicitation_batches` row
→ `agent_runs`. `requestAskRegeneration` **prefixes one lock ahead** — the `job_outbox`
row at `:813` — because `regenerateAsk`'s swap takes `job_outbox` first and the reverse
is an ABBA against it (argument at `:775-785`).

## latchHalt — one body, two arms

```mermaid
flowchart TD
  H1["haltBatch :587"] --> HL["lockBatchForAction :593"]
  H2["adminHaltBatch :672"] --> AL["lockBatchForAction :678"]
  HL --> HG{"state"}
  AL --> AG{"state"}
  HG -->|halted| HR2["already_halted :596"]
  HG -->|"closed | pending"| HR3["not_haltable :598"]
  AG -->|halted| AR2["already_halted :684"]
  AG -->|"closed | pending"| AR3["not_haltable :685"]
  HG --> HD["ownerHaltReason → owner_halt if sending else owner_veto<br/>approval.ts:88 called :600"]
  AG --> AD["ADMIN_HALT_REASON constant<br/>approval.ts:415"]
  HD & AD --> LATCH["latchHalt<br/>approval.ts:468 · called :606 and :687"]
  LATCH --> S1["STEP 1 CAS solicitation_batches<br/>halted_at, halt_reason, halted_by WHERE halted_at IS NULL<br/>approval.ts:471-480"]
  S1 -->|"no row"| LF["latched:false → already_halted<br/>:482, :610, :690"]
  S1 --> S2["STEP 2 UPDATE solicitation_outreach cancelled<br/>WHERE delivery_status IN ('rendered','queued') — 'sending' EXCLUDED<br/>approval.ts:486-496"]
  S2 --> S3{"input.audit !== null"}
  S3 -->|"ADMIN ARM ONLY"| AUD["STEP 3 writeAccountAuditLog same tx<br/>approval.ts:502-516"]
  S3 -->|"owner arm: audit=null :614"| S4
  AUD --> S4{"sendParentRunId !== null"}
  S4 -->|yes| ST["STEP 4 agent_run_steps batch_halted<br/>:521-530"]
  S4 & ST --> S5["STEP 5 closeBatchIfSettled :533"]
```

The arms differ in exactly three places: reason (derived vs constant), the audit
argument, and the result union. **Guard lists are now identical** (`:596-598` vs `:684-685`).

## requestAskRegeneration — the only verb that throws every refusal

```mermaid
flowchart TD
  RT["regenerate/route.ts:55"] --> RL["enforceDashboardRegenRateLimit — Upstash, fails open<br/>route.ts:66"]
  RL --> PK["UPSTASH PEEK peekAskRegenBudgetBatch<br/>route.ts:74 → tracker.ts:487 → :398 MGET"]
  PK -->|"miss/outage ⇒ null ⇒ proceed"| RQ["requestAskRegeneration :801"]
  RQ --> E1["WRITE job_outbox FIRST (lock order)<br/>approval.ts:813"]
  E1 --> LB["lockBatchForAction :822"]
  LB -->|null| T1["THROW not_found :823"]
  LB --> DD{"outboxId null — ON CONFLICT DO NOTHING"}
  DD -->|"yes, answered AFTER ownership proof"| T2["THROW already_in_flight :852"]
  DD --> ST{"state !== built"} -->|yes| T3["THROW not_regenerable :856"]
  ST --> CU["READ attempt ORDER BY attempt_no DESC FOR UPDATE<br/>:863-874"]
  CU -->|"≠ rendered"| T5["THROW ask_not_regenerable :879"]
  CU --> BG{"budgetRemaining ≤ 0"} -->|yes| T6["THROW budget_exhausted — LAST<br/>:891"]
  BG --> RSp["agent_run_steps ask_regeneration_requested<br/>:905-913"] --> OK["202 accepted"]
  T1 & T2 & T3 & T5 & T6 --> CAT["catch instanceof RegenRequestAbort → return err.result<br/>:919-923 — tx ROLLED BACK, outbox row gone"]
```

The only verb with **no domain write**, the only one that enqueues, the only one
touching Redis.

## closeBatchIfSettled (outreach.ts:317-449, 133 lines)

```mermaid
flowchart TD
  A["closeBatchIfSettled :317"] --> B["batchId.toLowerCase() — #858 :321"]
  B --> C["READ + LOCK solicitation_batches FOR UPDATE<br/>halted, approval_window_elapsed (built_at+7d) :322-334"]
  C -->|"no row"| T["THROW :336-340"]
  C --> D["READ grouped tally :353-360"] --> E["tallyOutreach — live = NOT isTerminalDeliveryStatus<br/>:237, :136-147"]
  E -->|"withheld with NULL reason"| T2["THROW :255-259"]
  E -->|"liveCount > 0"| R1["not_settled :363"]
  E --> F["READ send parent agent_runs (subject_id TEXT compare) :368-378"]
  F -->|"no parent, no failure"| R2["no_send_parent :383"]
  F -->|"no parent WITH failure"| G["CAS send_closed_at :390-398"] --> R4["closed_without_parent — no step, no run write :400"]
  F -->|parent| H["CAS send_closed_at :407-415"] -->|"0 rows"| R5["already_closed :416"]
  H --> I["deriveDisposition: halted > expired > generation_failed > gate_closed > exhausted<br/>:281-289"]
  I --> J["agent_run_steps send_batch_closed :419-429"]
  J --> K{"parentStatus failed && input.failure"}
  K -->|yes| L["failSolicitationBatchRun :443"]
  K -->|no| M["completeRun :445"]
```

**Eight production call sites across five enclosing functions** — correcting the brief's
"five": `approval.ts:393` (`approveBatch`), `:533` (`latchHalt`, serving **both** halt
verbs), `:1170` (`withdrawAsk`), `ask-generation.ts:873` (`closeStoppedLane`), `:1005`
and `:1179` (both `generateAsksForBatch`), `:1496` (`regenerateAsk`), `:1690`
(`settleGenerationExhaustion`). It is **three** sites in `approval.ts`, not five.

## Q1 — the predicate: not four spellings, but two owners and a gap

Full repo sweep returns six SQL sites. Three are the predicate under review.

| # | Site | Predicate | Selects | Kind |
|---|---|---|---|---|
| 1 | `approval.ts:494` | `IN ('rendered','queued')` | every batch row halt may cancel | **WRITE** |
| 2 | `approval.ts:1126` | `IN ('rendered','queued')` | the one resolved row, as CAS guard | **WRITE** |
| 3 | `batch-view.ts:948` | `o.delivery_status IN ('rendered','queued')` | `cancellableCount` for the admin panel | **READ** |
| 4 | `approval.ts:1146` | `IN ('rendered','queued','sending')` | `remainingLive` after withdrawal | READ — **superset** |
| 5 | `ask-generation.ts:895` | `IN ('rendered','queued','sending','sent')` | `alive` in `readRenderTally` | READ — **wider superset** |
| 6 | `ArchivalPoller.ts:311` | `('withheld','cancelled','failed','unknown')` | archival candidates | unrelated |

**1, 2, 3 are the same concept** — the Halt latch's cancellable set. `latchHalt:485-486`
and `classifyWithdrawal:1010-1011` both name it; `withdrawAsk:1023-1032` calls itself
"the Halt latch at ask granularity". **3 exists to tell an operator, before pressing
Admin halt, exactly how many rows 1 will cancel** — `SolicitationBatchPanel.tsx:403`
renders it as "{n} rendered and queued message(s) only". If 3 drifted from 1, the admin
panel would state a false consequence for the button beside it.

**4 and 5 are deliberately different questions.** 4 is "is anything still in flight"
(adds `sending`, which halt refuses to touch). 5 is "did generation produce anything
that still counts" (adds terminal-success `sent`). Supersets by construction, not drift.

**Two more spellings the count of four misses:**
- `approval.ts:1010-1013` — the same set in **TypeScript**, inside `classifyWithdrawal`.
  Predicate 2 is the SQL re-assertion of this JS decision under the lock.
- `outreach.ts:136-147` — `TERMINAL_DELIVERY_STATUSES` / `isTerminalDeliveryStatus`, the
  **negated closed list** whose complement is exactly predicate 4's set.

**The finding is not the count.** The lane has **one named owner for the "live" set**
(`outreach.ts:136`) and **no named owner for the "cancellable" set**. That asymmetry is
the thing.

## Q2 — the failure-expression asymmetry is four/one, not two/one

Contract stated at `approval.ts:120-131`.

| Verb | Null-lock arm | Line | Why |
|---|---|---|---|
| `approveBatch` | `return not_found` | :232 | nothing written yet |
| `haltBatch` | `return not_found` | :594 | nothing written yet |
| `adminHaltBatch` | `return not_found` | :681 | nothing written yet |
| `withdrawAsk` | `return not_found` | :1058 | nothing written yet |
| `requestAskRegeneration` | **THROW** `RegenRequestAbort` | :823 | the `job_outbox` row was already INSERTed at `:813`; postgres.js commits when the callback resolves, so a `return` commits the enqueue it just refused (`:787-792`) |

It throws at **every** refusal for the same reason — `:823, :852, :856, :877, :879, :891`
— caught at `:919-923`.

Distinct from the **five hard `throw new Error`** sites, which are broken-invariant
assertions that deliberately propagate past the sentinel catch: `:362, :900, :1112,
:1135, :1153`.

Validate-first/mutate-second is enforced **by ordering, not by a helper**: `approveBatch`
validates exclusions at `:309-320` before the UPDATE at `:323`; `withdrawAsk` returns
every refusal at `:1104-1108` before the UPDATE at `:1117`.

## Q3 — approval.ts is coherent, with one narrow anomaly

21 exports, no orphan concerns: five `Input → Result → function` verb blocks in call
order, two shared helpers at the top (`canonicalBatchId:112`, `lockBatchForAction:144`),
and the halt-only private block wedged between verbs 1 and 2 (`:411-540`). Twelve private
members, all shared or verb-local. Five production importers, all route handlers, each
importing exactly one verb plus its result type.

**The anomaly**: three of the four pure exports have **no production consumer**.
`isWithdrawableState:939`, `classifyWithdrawal:995`, `CurrentAttempt:977`,
`WithdrawalDecision:989` and `ownerHaltReason:88` are referenced outside the file only by
`approval.test.ts:33-39`. `WithdrawalDecision` has **zero** references anywhere outside
its declaration. Two say so in their docstrings (`:934-938`, `:991-994`). That is
deliberate test-seam surface, and it is the file's entire "extra" export weight.

## Gaps

1. `recordStep`'s body and `writeAccountAuditLog`'s body unread; the docstring claim that
   `recordStep` does its own `SELECT … FOR UPDATE` on the send parent (`:44-48`) is taken
   at its word.
2. `requireWritableOwner` / `requireContactsLocationScope` internals unread.
3. Test suites unread — the "test-only export" claim rests on an import-graph grep.
4. Migration 091's index and halt-consistency CHECK cited from comments, not opened.
5. `ask-generation.ts:1005` and `:1179` are both inside `generateAsksForBatch` (294 lines,
   acknowledged-debt marker at `:911-913`); which arm reaches each was not charted.
