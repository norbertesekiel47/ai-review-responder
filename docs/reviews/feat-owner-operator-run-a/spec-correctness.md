# Review — SPEC & CORRECTNESS axis · feat/owner-operator-run-a

**Fork / merge-base SHA:** `c5e94e6ca7e3c4187854a67129b1651a8f80566e`
**Head SHA reviewed:** `7224424efa0a226e9a517d28e27850a1973cf14d`
**Conditional axes applied: security, tenancy, async**

Every file was read via `git show <head>:<path>` and every diff via
`git diff <base> <head> -- <path>`; the working tree was never trusted (a
red-team pass mutates it concurrently). No test was run.

Inputs read at head: intake contract, spec of record §0–§12, plan decisions
L1–L6 / V1–V2, the triaged deviations doc (all 16 entries ACCEPT plus the
step-6 read-back), blast-radius, the owner-operator glossary, and the three
accepted-findings checklists. Findings already covered by an ACCEPTed
deviation entry are not re-reported.

---

## Findings (≥80% confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | Medium | `src/lib/agents/operator/proposals.ts:89` | Supersession has no same-turn exclusion: two proposals in one turn sharing `(operation, location_id)` supersede **each other**, leaving the turn with zero pending proposals. |
| 2 | Medium | `src/lib/agents/operator/proposals.ts:131` | `ORDER BY created_at ASC` over rows that all carry the same transaction `NOW()` — the positional `proposal_ref.index` → card binding rests on an unstable sort. |
| 3 | Medium | `src/lib/agents/operator/render.ts:111` | The invented-count and completion-claim gates run only on `type:'text'`; the same sentence inside a `question` segment is rendered to the owner verbatim. |
| 4 | Low | `worker/jobs/agent-turn/AgentTurnWorker.ts:354` | `!voice` silently drops **every** proposal and the turn still completes `completed`, with `proposal_ref` segments that render nothing and no failure reason. |
| 5 | Low | `src/lib/agents/operator/context.ts:235` | `proposalSummaries` is hardcoded `[]`, so the snapshot's turn history carries none — spec §5.3 requires them and no deviation entry records dropping it. |
| 6 | Low | `src/app/api/operator/turns/route.ts:36` | The run's only mutation route performs no impersonation check, unlike the sibling owner mutation `PATCH /api/settings/auto-approval`. |
| 7 | Low | `src/lib/agents/operator/turns.ts:662` | `getConversationForOwner` issues one `listProposalsForTurn` query **per turn** with no `LIMIT` on the transcript — unbounded sequential fan-out on one pooled connection. |

---

### 1. Medium — same-turn proposals supersede each other

**Contract field:** intake `edge_cases` — *"Supersession: a new completed turn's
proposal with the same operation and scope marks **earlier** pending proposals in
the conversation superseded with `superseded_by` set."* (also spec §8.2).

**Evidence.** `src/lib/agents/operator/turns.ts:393-402` inserts every proposal of
the turn with `status='pending'` (`proposals.ts:55` hardcodes
`PROPOSAL_STATUS.PENDING`) and *then*, inside the same fenced transaction, runs
`supersedePendingProposals` once per inserted row. The predicate
(`proposals.ts:84-89`) is:

```
WHERE conversation_id = … AND account_id = …
  AND status = 'pending'
  AND operation = ${replacement.operation}
  AND location_id IS NOT DISTINCT FROM ${replacement.locationId}::uuid
  AND id <> ${replacement.proposalId}::uuid
```

The only exclusion is `id <> self`. There is no `turn_id <> input.turnId` and no
`created_at <` bound, so a sibling inserted by the *same* transaction matches.

Nothing upstream forbids duplicates: `OperatorModelOutputSchema.proposals` is
`z.array(ProposedOperationSchema).max(5)` with no uniqueness
(`schema.ts:164`), `validateModelOutput` never compares two proposals to each
other (`render.ts:142-168`), and `OWNER_OPERATOR_SYSTEM_PROMPT` contains no
one-proposal-per-operation instruction (`prompt.ts:13-28`).

**Failure scenario.** Owner: *"make the tone warmer — actually warm and
professional."* The model returns two `set_tone` proposals for the stored
location. Both rows commit `pending`; the loop's first iteration marks P2
`superseded_by = P1`, the second marks P1 `superseded_by = P2`. The turn
completes, the reply renders two `proposal_ref` cards, and
`listPendingProposals` (the snapshot's `pendingProposals` and the conversation
summary's `pendingProposals`) returns **none** — so the next turn's model sees no
pending work and Run B's Apply path would find nothing applicable behind two
visible cards. Neither proposal is recoverable; both `superseded_by` pointers are
circular.

---

### 2. Medium — `proposal_ref` binding rests on an unstable sort

**Contract field:** spec §5.5 (*"`proposal_ref.index` points at a returned
proposal"*) and intake `user_visible_behavior` (*"GET /api/operator/turns/:id
returns { status, failureReason, segments (rendered), proposals, unsupported }"*).

**Evidence.** The stored reply keeps the model's **positional** index
(`schema.ts:62-65`, `ProposalRefSegmentSchema.index`), and the renderer resolves
it positionally against the read order:

- `src/lib/agents/operator/render.ts:231` — `const proposalId = context.proposalIds[segment.index];`
- `src/lib/agents/operator/turns.ts:559` — `proposalIds: proposals.map((p) => p.id)`
- `src/lib/agents/operator/proposals.ts:131` — `ORDER BY created_at ASC`

`supabase/migrations/120_owner_operator.sql:111` declares
`created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, and PostgreSQL's `now()` is
`transaction_timestamp()` — identical for every row `insertProposals` writes,
because they all commit inside the one `completeTurnFenced` transaction
(`turns.ts:379-416`). The sort key is therefore fully tied and there is no
tie-break column (the ids are uuidv7 and would provide one).

`listProposalsForTurn` filters on `turn_id`/`account_id`, for which migration 120
creates no index, so it plans a seq scan and returns heap order. Heap order is
**not** insertion order after an UPDATE: `supersedePendingProposals`
(`proposals.ts:79-90`) rewrites superseded rows, appending the new tuple
versions.

**Failure scenario.** Turn T1 produces P0 (`set_tone`) and P1
(`set_avoid_facts`); the reply says *"I've prepared a tone change [card 0] and a
list of things to avoid [card 1]"*. A later turn T2 proposes `set_tone` again, so
P0 is UPDATEd to `superseded` and its tuple moves to the end of the heap. A
refresh of `GET /api/operator/turns/T1` now returns `[P1, P0]`, and
`proposal_ref index 0` renders **P1's** id — the tone sentence is attached to the
avoid-facts card. Nothing in the response signals the mismatch. The same tie
affects `listPendingProposals` (`proposals.ts:148`) and `listUnsupportedForTurn`
(`proposals.ts:182`).

---

### 3. Medium — completion claims and invented counts are unchecked in `question` segments

**Contract field:** intake `user_visible_behavior` — *"A model output that invents
a count in text, **claims a change was applied**, references a proposal index that
does not exist … fails validation"* — and the §1 product contract *"The owner
never sees 'I'll remember that' in place of an honest answer about whether
behavior changed."* (Spec §3.4/§5.5 word the rule as *"a `text` segment"*; the
implementation resolved the intake/spec mismatch toward the narrower reading and
no deviation entry records it.)

**Evidence.** `src/lib/agents/operator/render.ts:110-118`:

```ts
for (const segment of output.segments) {
  if (segment.type === 'text') {
    if (INVENTED_COUNT_PATTERN.test(segment.text)) { … }
    if (COMPLETION_CLAIM_PATTERN.test(segment.text)) { … }
  }
```

`QuestionSegmentSchema` (`schema.ts:67-70`) carries a free 400-character string,
is in both the model union and the stored union (`schema.ts:77-83`,
`schema.ts:133-140`), and `renderSegments` emits it verbatim
(`render.ts:211-213`). The system prompt's own rules
(`prompt.ts:20`, `prompt.ts:22`) say "text segment" / "NEVER claim", but a prompt
rule is not the gate — the validator is.

**Failure scenario.** The model emits
`{ type: 'question', text: "I've updated your tone to warm — want me to do the same for the other location?" }`.
Validation passes, the turn commits `completed`, and the owner reads a
false completion claim for a change that in Run A has no executor at all
(invariant #3: nothing is applied). One trivially-produced sentence defeats the
feature's central honesty guarantee.

---

### 4. Low — a null voice read silently empties a completed turn's proposals

**Contract field:** intake `user_visible_behavior` — *"commits reply segments +
proposals + unsupported rows + outbox completion in one fenced transaction"*;
`edge_cases` has no entry for this outcome.

**Evidence.** `worker/jobs/agent-turn/AgentTurnWorker.ts:203-207` reads
`readVoiceConfig`, which returns `null` when the location is not an *active*
member of the account (`src/lib/responses/voice-settings.ts:61-68` —
`archived_at IS NULL`). `buildProposalRows` then drops every proposal:

```ts
if (!operation || !voice) continue;   // AgentTurnWorker.ts:354
```

The turn still takes the `completeTurnFenced` success path
(`AgentTurnWorker.ts:246-262`) and commits `status='completed'`. Step 3's
authorization (`authorize.ts:40-47`) proved the location active *before* the
snapshot and the model call, so the window is real but narrow: an archive between
step 3 and step 7.

**Failure scenario.** A location is archived while its turn is in the model call.
The turn completes; the reply's `proposal_ref` segments resolve to nothing
(`render.ts:232` skips a missing id), so the owner sees "here's the change I've
prepared" with no card and no error, and `failure_reason` is `NULL` — the
observability vocabulary in intake `observability` cannot distinguish this from a
turn that legitimately proposed nothing.

---

### 5. Low — `proposalSummaries` is never populated

**Contract field:** spec §5.3 — *"Last N turns of this conversation (N=10; text
segments **and proposal summaries**, with any pasted review block already replaced
by the §3.4 marker)."*

**Evidence.** `src/lib/agents/operator/context.ts:65-75` declares
`SnapshotTurn.proposalSummaries: string[]` and documents it as part of "what the
model may see"; `context.ts:235` sets it unconditionally to `[]` and nothing else
writes it. The plan snippet at
`docs/superpowers/plans/feat-owner-operator-run-a-plan.md:3665` hardcodes the same
empty array, so this is implemented-as-planned — but the plan's departure from the
spec is not recorded in
`docs/superpowers/plans/feat-owner-operator-run-a-deviations.md` (none of the 16
ACCEPTed entries mentions it).

Mitigating: `snapshot.pendingProposals` (`context.ts:281-287`) does give the model
the conversation's live proposals, so the practical gap is history of
*already-decided* proposals. The dead field is the durable cost: it reads as
implemented and will be carried into Run B unchanged.

---

### 6. Low — POST `/api/operator/turns` accepts impersonated sessions

**Contract field:** intake `risk_reasons` (*"POST /api/operator/turns is an owner
mutation route: same-origin, requireWritableOwner, account-scoped idempotency"*)
and the security/authorization risk axis, which names impersonation. Spec §7's
boundary table requires impersonation rejection only for `POST apply` /
`POST decline` (Run B), so this is a gap in defence rather than a contract breach.

**Evidence.** `src/app/api/operator/turns/route.ts:34-37` gates on
`ownerOperatorEnabled()` then `requireWritableOwner(sql, request)`.
`requireWritableOwner` (`src/lib/auth/route-helpers.ts:133-146`) resolves role and
subscription only; it never inspects `IMPERSONATION_COOKIE_NAME`. The sibling
owner mutation does: `src/app/api/settings/auto-approval/route.ts:42-51` returns
409 `impersonation_not_allowed` when `hasImpersonationCookie(request)`, and
`patchAutoApprovalSettings` throws on `impersonated` as a second line of defence
(`src/lib/auto-approval/settings.ts:203`).

The worker's step-3 re-authorization (`authorize.ts:22-28`) re-resolves the actor
from `users` by id and role; an impersonated session carries the real owner's
user id, so it passes.

**Failure scenario.** An admin with a valid `rw_impersonation` cookie POSTs turns
as the owner. The messages are stored as `owner_text` attributed to
`actor_user_id = <owner>` and are indistinguishable from the owner's own in the
transcript (`turns.ts:710` returns `ownerText` verbatim), each one spending the
owner's LLM budget through `withCostGuard` (`model-call.ts:100-151`) and writing
`api_costs` rows billed to the owner's account
(`model-call.ts:48-60`). Run B's Apply inherits those rows as the owner's own
stated intent.

---

### 7. Low — unbounded per-turn query fan-out on the conversation read

**Contract field:** intake `user_visible_behavior` — *"GET
/api/operator/conversation?id= returns the transcript and summary reads with
timestamps"*; the async/operations axis (admission-gate interaction).

**Evidence.** `src/lib/agents/operator/turns.ts:630-639` selects **every** turn of
the conversation with no `LIMIT`, and `turns.ts:661-668` then issues one
`listProposalsForTurn` query per turn, sequentially:

```ts
for (const turn of turnRows) {
  const proposals = await listProposalsForTurn(sql, { turnId: turn.id, accountId: input.accountId });
  proposalIdsByTurn.set(turn.id, proposals.map((p) => p.id));
}
```

Followed by six more sequential reads for the summary panel
(`turns.ts:679-697`). The snapshot path deliberately bounds its history
(`SNAPSHOT_TURN_LIMIT = 10`, `context.ts:116`); this owner-facing read does not.

Every one of these statements passes through the #773 admission chokepoint on a
single pooled connection, and PgBouncer's ~8 s `statement_timeout` applies
per statement, not per request, so the whole request can outlive any single
statement budget.

**Failure scenario.** A conversation that accumulates 200 turns makes one
`GET /api/operator/conversation` cost 200 + 7 serialized round trips. The screen
issues this read on mount and on every refresh/navigation resume (spec §3.2 step
6). The mitigating factor is that the *polling* loop uses
`GET /api/operator/turns/:id`, not this endpoint, so the blast radius is page
load rather than a 2 s poll.

---

## Verified-clean (checked, no finding)

Recorded so a later pass does not re-derive them.

- **Tenancy.** Every statement over the four new tables carries an `account_id`
  predicate or supplies it in `VALUES`: `turns.ts` (createTurn, claim, release,
  loadPredecessor, readTerminalTurn, both fenced transitions,
  `failTurnIfNonTerminal`, both owner reads, `readRecentTurns` in `context.ts`),
  `proposals.ts` (all six statements), `purge-stages.ts:456-480`,
  `purge-verification.ts:641-664`. All four tables are in `TENANT_TABLES` and
  `TENANT_SCOPE_COLUMNS` (`scripts/ci/tenant-tables.ts:107-191`),
  `TABLE_DISPOSITIONS` as `hard_delete` / `direct_account_id` /
  `must_be_absent`, and `docs/security/rls-inventory.md`.
- **Cross-account probing.** A conversation id minted under another account
  returns `conversation_not_found` via the account-scoped re-read after
  `ON CONFLICT (id) DO NOTHING` (`turns.ts:131-150`); a malformed or foreign turn
  id is the same 404 as a non-existent one (`turns/[id]/route.ts:31,35`).
- **Idempotency.** The conversation `FOR UPDATE` is taken *before* the turn-key
  read (`turns.ts:141-166`), and the cross-conversation race that the lock cannot
  cover is recovered from `23505` on a fresh statement (`turns.ts:91-117`) with a
  byte-for-byte payload comparison (`turns.ts:48-55`, no `.trim()` anywhere on the
  path — `turns/route.ts:25-28`).
- **Outbox.** `enqueueAgentTurn` is a helper-owned topic used inside the turn's
  transaction (`turns.ts:205`); the plain INSERT with no `ON CONFLICT` is
  justified and verified by plan V1 against migrations 004/018/030/091/114. Every
  terminal transition couples `markOutboxCompletedIfOwned`/`markOutboxFailed` to
  the turn write in one `begin`, with the CAS **first** on both unclaimed paths
  (`turns.ts:500-505`, `failed-hook.ts:55-75`). The `claim-missed + terminal turn`
  branch (`AgentTurnWorker.ts:85-96`) closes the watchdog loop the fence would
  otherwise leave open.
- **Delayed predecessor wait.** `job.token` is set by the worker before the
  processor runs (`node_modules/bullmq/dist/cjs/classes/worker.js:523`) and
  `handleFailed` special-cases `DelayedError` without emitting `'failed'`
  (`worker.js:650-661`), so `withJobLogContext`'s pass-through re-throw
  (`worker/job-log-context.ts:38`) is safe and the wait genuinely spends no retry
  budget. `workerOpts` sets no `maxStartedAttempts` (`worker/index.ts:217`), so the
  10 s re-check loop cannot be killed early.
- **Budget / transient classification.** `CostLimitExceededError` and
  `GlobalCostLimitExceededError` are the real `name` values
  (`src/lib/costs/tracker.ts:16,23`), so `isBudgetDecision`
  (`AgentTurnWorker.ts:40-47`) terminalizes correctly; everything else releases
  the claim fenced on the attempt token before rethrowing
  (`AgentTurnWorker.ts:300-305`).
- **Snapshot containment.** `Snapshot` has no field that can hold review text,
  response text or a reviewer name; `facts` is a four-field projection built
  field-by-field rather than a spread, so `sampleResponses` cannot leak
  (`context.ts:318-325`, `voice-settings.ts:15-21`).
- **Flag.** `readFlag` is unset-safe (`src/lib/config/flags.ts:22`); the flag gate
  precedes auth on all three routes; `OWNER_OPERATOR_ENABLED` joins
  `SERVER_ONLY_FEATURE_OPTIONAL_BOOLEAN_ENV` and the envelope moves 11 → 12 with
  the matching ADR 0005 amendment. No `NEXT_PUBLIC_*` companion exists.
- **Worker step 3.** `assertWritableSubscriptionForAccount` returns the literal
  `'account_offboarding_blocked'` (`writable-subscription.ts:131`), which
  `reauthorizeTurn` maps to `ACCOUNT_OFFBOARDING`; everything else maps to
  `UNAUTHORIZED`. No snapshot is built before it returns ok.
- **Allowed edit surface.** Every changed path is covered by
  `allowed_edit_surface`. The two allowed-but-untouched directory pages
  (`lib-platform.md`, `lib-reviews-responses.md`) are covered by ACCEPTed surface
  amendment #2. No scope creep found.
- **Invariants #1 / #15.** No file under `src/app/api/operator/**` imports the LLM
  seam, the cost guard or the worker queue registry, directly or transitively
  (`turns.ts` → `context.ts`/`render.ts`/`proposals.ts`/`schema.ts` only); every
  `postgres` import in the new modules is `import type`.
- **Migration 120.** Single transaction with `SET LOCAL lock_timeout`,
  `CREATE TABLE/INDEX IF NOT EXISTS`, both named uniques, deny-all RLS plus
  `REVOKE ALL FROM anon, authenticated` — re-runnable, and a partial application
  rolls back as a unit. Adds no `job_outbox` index and touches no existing table,
  matching the stated rollback plan.
- **Promised tests.** All 35 `tests_to_add` titles exist verbatim across the new
  suites, and no suite contains `it.todo` / `it.skip` / `describe.skip`.

---

## Appendix — non-actionable observations (below the reporting bar or uncertain)

1. `model-call.ts:115` re-parses `llm.structured` with `OperatorModelOutputSchema`,
   which `runLlmTask` already validated with the same schema
   (`src/lib/llm/run-task.ts:93`). The second parse is dead; if it ever threw, a
   raw `ZodError` would escape past the cost guard, miss `isBudgetDecision`, and
   burn all five BullMQ attempts as if transient.
2. The snapshot's `pending_count` (`readStarBands`, `context.ts:146-162`, which
   joins `reviews` and excludes `status = 'deleted'`) and the conversation
   summary's `pending.pendingCount` (`getPendingApprovalCountsForAccount`, no
   `reviews` join) can disagree for the same location. Both sources are named by
   the contract; the divergence is documented in code comments.
3. `OwnerTurnView.locationId` (`turns.ts:513`) is computed but not returned by
   `GET /api/operator/turns/:id`, so spec §3.3's "prepared for &lt;location&gt;"
   note has no source on that endpoint. The intake's five-field response shape is
   satisfied as written.
4. `REVIEWER_PATTERN` (`render.ts:33`) includes a bare `\bwrote:`, so an ordinary
   instruction such as *"the template I wrote: keep it short"* scrubs the whole
   block and prepends the pasted-review notice. The contract names a `"wrote:"`
   pattern, so this is in-contract.
5. The voice PUT 404 body changed from `Location not found or not updated` to
   `Location not found or not accessible`, and the 200 body gained `updatedAt`.
   `src/hooks/useLocationVoiceForm.ts:248` surfaces `body.error` verbatim; both
   changes are additive/cosmetic and the route suite was re-pointed under ACCEPTed
   surface amendment #1.
6. `OWNER_OPERATOR_ENABLED` is absent from
   `docs/runbooks/infisical-production-manifest.md` and
   `docs/runbooks/launch-flag-readiness.md`, where `JUDGE_ENABLED` appears. Both
   files are outside `allowed_edit_surface` and flipping the flag in production is
   a stated non-goal.
7. `agent_turns.failure_reason` carries no CHECK constraint while `status` does
   (`120_owner_operator.sql:78,82`), so the `TURN_FAILURE_REASON` vocabulary is
   enforced only in TypeScript.
8. Spec §5.2's 120 s lease / 10 min stall are superseded by plan L2
   (180 s / 1200 s) and by the intake's own wording; §14 was updated in T8.
   Verified consistent — not a defect.
9. `insertProposals` / `supersedePendingProposals` / `insertUnsupported` all loop
   row-by-row inside the fenced transaction rather than using a set-based write.
   Bounded at 5 rows each by the model schema, so the round trips are acceptable;
   noted only because the loop shape is easy to copy into an unbounded caller.
