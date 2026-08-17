# Spec & correctness review — `feat-860-ask-regeneration-surface`

Reviewed: `git diff f28451ee..HEAD` (28 files, +5295/−150).
Inputs read field by field: `.feature/intake.json`, the D1–D14 deviations file,
`blast-radius.md`, the plan + its three review appendices, `CONTEXT.md`
(**Ask regeneration**, **Owner approval**, **Ask exclusion**, **Halt latch**).

Review only. Nothing was edited, nothing was committed.

---

## Findings (≥80 % confidence)

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | **High** | `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:532` → `RequestsClient.tsx:423-426` | The regenerate 202 settles through the shared `onChanged` → `retry()` path, which sets `phase: LOADING` and **unmounts `ApprovalPanel`**; `excludedAsks` (`ApprovalPanel.tsx:592`) resets to empty, silently re-selecting every ask the owner had deselected. |
| 2 | **High** | `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:600, 655-668` | The same remount destroys the `pendingRegen` ref, so the settle effect can never fire — `user_visible_behavior[6]` ("the panel says so rather than silently showing the same text") is unreachable in production. Both tests that claim it pass only because they `rerender` (state-preserving) instead of remounting. |
| 3 | Medium | `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:395-404` with `:195-203` | Widening the poll predicate to built batches makes the `stalled` phase reachable for a **built, approvable** batch. After the 5-minute ceiling the approval panel and every rendered message are replaced by the "Building your batch… / Still processing / The build keeps running on our side" ghost, and Approve is gone. |
| 4 | Medium | `src/lib/solicitation/batch-view.ts:570-576` | The advisory Upstash `MGET` runs **inside** `readLatestBatch`'s `REPEATABLE READ` transaction (`batch-view.ts:725-726`), holding an admission-gated Postgres connection across a Redis round trip (≤ 3 s `commandTimeout`) on every built-batch GET and every 2 s poll. |
| 5 | Low | `src/lib/costs/tracker.ts:72` with `src/app/api/dashboard/solicitation/batch/regenerate/route.ts:88` | `askRegenBudgetKey` interpolates the **caller-supplied** ask id verbatim and nothing canonicalises it (unlike `canonicalBatchId` two files over), so a POST with an upper-cased `askId` reads and increments a **different** daily counter — a fresh 3/day budget per case variant. |
| 6 | Low | `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:346-347` | `LANE_REFUSAL_COPY.not_regenerable` asserts "This batch has been approved" for **every** non-`built` state; a stale tab regenerating a halted / expired / closed / sending batch reads a false statement, even though the wire already carries `state`. |

---

## Detail

### 1 & 2 — the regenerate write remounts the panel and discards both pieces of its state

**Root cause, one code path, two broken behaviours.**

`useLaneWrites.perform` treats regenerate exactly like approve and halt
(`ApprovalPanel.tsx:513-533`): on any non-refused outcome it calls
`onChanged(announce(outcome.status), 'settled')` at line 532. The parent's
handler is

```
// RequestsClient.tsx:92-98
const onLaneChanged = useCallback((message, outcome) => {
  setLane({ scope: currentScope, message, outcome });
  retry();
}, [currentScope, retry]);

// RequestsClient.tsx:423-426
const retry = useCallback(() => {
  setState({ scope: currentScope, phase: LOADING, announcement: '' });
  setAttempt((value) => value + 1);
}, [currentScope]);
```

`phase: LOADING` makes `Screen` return `<LoadingCard />` (`RequestsClient.tsx:165-166`)
instead of the `<><ApprovalPanel/><BatchReport/></>` fragment. Different element
type at the same position ⇒ React unmounts `ApprovalPanel`. The refetch then
remounts a **fresh** instance.

That was harmless for #629 because approve and halt are terminal — the panel
that comes back is a different screen anyway. #860 routes a **non-terminal**
write through the same path, and two pieces of panel-owned state do not survive
it:

**(1) `excludedAsks` (`:592`).** The owner deselects Bo and Cara, then clicks
Regenerate on Ana. The panel unmounts, the screen flashes "Loading the latest
batch…", and the remounted panel starts with an empty exclusion set — Bo and
Cara are re-checked and the approve button silently goes back to "Approve and
send 3 messages". This is precisely the harm round-1 finding 6 reversed the
pruning approach to prevent ("could send a message the owner had deselected"),
and it is also `user_visible_behavior[2]` ("disabled on asks the owner has
deselected") failing for the ask being regenerated *and* every other one.

Note the ask-keyed exclusion design is still correct — it works for the
*other* refetch path (the poll loop's in-place `setState` at
`RequestsClient.tsx:406-410` keeps the panel mounted, so a regeneration
initiated in another tab does preserve the set). Only the this-tab click path
is broken, and that is the path the feature exists to create.

**(2) `pendingRegen` (`:600`).** The ref is set in `onRegenerate` (`:645-654`)
and read by the settle effect (`:655-668`). Because the panel unmounts the
instant the 202 lands, the remounted instance has `pendingRegen.current === null`
and the effect returns at its first guard forever. Consequently:

- `user_visible_behavior[6]` — "When a rewrite settles without changing the copy
  (a worker-side refusal), the panel says so rather than silently showing the
  same text" — never happens. A worker refusal (`regen_budget_exhausted`,
  `subscription_inactive`, `batch_not_regenerable:*`) shows the owner the same
  words with no explanation, which is exactly the symptom the effect was written
  for.
- `edge_cases[3]` ("the panel detects it by comparing `attemptNo`") is
  unreachable.

**Why the tests do not catch it.** Both
`reports that nothing changed when a regeneration settles without a new attempt`
(`approval-panel.test.tsx:762`) and
`reports a settled regeneration that completed before the first refetch` (`:894`)
render `ApprovalPanel` directly and simulate the refetch with
`rerender(<ApprovalPanel …/>)`, which **preserves** component state and refs.
`keeps an ask excluded when a regeneration replaces its outreach id` (`:812`)
never clicks Regenerate at all — it clicks the checkbox and then `rerender`s.
`requests-client.test.tsx` gained only two fixture lines (`:426-427`) and has no
regenerate coverage. The suite therefore pins the design intent, not the shipped
composition. The panel-suite header explicitly justifies rendering directly
("driving it through the fetch loop would test the loop instead") — that reasoning
held while every lane write was terminal and stops holding at #860.

Both of these are cheap to fix (e.g. give the regenerate settle path its own
non-`retry()` refresh, or lift the two pieces of state into `RequestsClient`), but
the fix is out of scope for this review.

### 3 — `stalled` is now reachable for a built batch, and its copy is wrong there

`useLatestBatch` now keeps polling a **built** batch while
`sendLane.regeneratingAskId !== null` (`RequestsClient.tsx:395-404`). The 5-minute
`POLL_CEILING_MS` bound is unchanged and fires from the deadline check at
`:365-374`, producing `{ kind: 'stalled', view }`.

`Screen`'s stalled arm (`:195-203`) is hard-coded to `mode="building"`, and
`GhostPipeline`'s own docstring states the premise this change invalidates:
"`stalled` is not a fourth screen: it is `building` after polling gave up at the
ceiling — the build is still running on the worker either way"
(`GhostPipeline.tsx:43-47`). That is no longer true. A regeneration that outlives
the ceiling (worker down, queue backlog, BullMQ retry backoff — the outbox row
stays `dispatched`, so `regeneratingAskId` stays non-null) now:

- replaces the whole approval lane, including every rendered message the owner
  was reading, with the ghost;
- tells the owner "Building your batch… / Still processing / The build keeps
  running on our side", which is false — the batch is built and approvable;
- removes the Approve control entirely for that page state.

Recoverable via "Check again" (`onCheckAgain={onRetry}`), so this is a degraded
state rather than a wedge — but it is not in `user_visible_behavior` and it is
not covered by any test.

### 4 — the Redis peek sits inside the read transaction

`readSendLane` is handed the `tx` opened by `readLatestBatch`
(`batch-view.ts:725-726`, `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`),
and `#860` adds an Upstash `MGET` at `:570-576` inside it.

The peek is explicitly advisory — the surrounding comment says so ("ADVISORY
presentation facts, not inputs to any gate … read AFTER the tenant-scoped
statements") — so it needs neither the snapshot nor the connection. Being inside
the transaction costs:

- an admission-gated Postgres connection (`src/lib/db/admission.ts`, #773) held
  across a network round trip to a different provider, on the hot path of
  `GET /api/dashboard/solicitation/batch`;
- during an Upstash brown-out, ≤ 3 s (`commandTimeout`, `redis-cache.ts:31`) of
  extra hold **per read**, while the Requests screen polls every 2 s per open tab
  for the duration of any regeneration — in-flight reads then accumulate faster
  than they drain.

CLAUDE.md's own gotcha ("The gate trades latency for never wedging") is the clause
this pulls against. `src/lib/past-replies/load-replies.ts` — the precedent the
intake names for this exact merge — does the peek outside any transaction
(`load-replies.ts:386-391`, after every statement, no `sql.begin`).

Fail-open semantics themselves are correct: an empty map means UNKNOWN,
`Object.fromEntries` drops nothing into the record, and the panel renders no
counter with the control enabled (`AskList.tsx:180-186`). Verified against
`renders no regenerate counter when the budget is unknown` — a present
`{used: 0}` does render, an absent entry does not.

### 5 — the per-ask daily cap is keyed on the un-canonicalised ask id

`isValidUuid` accepts upper case, `readRegenerateRequest`
(`regenerate/route.ts:39-49`) passes the body value through untouched, and neither
the route nor `requestAskRegeneration` canonicalises it — while the batch id in
the very same call *is* canonicalised, with a docstring explaining why
(`approval.ts:78-96`).

Downstream:

- `peekAskRegenBudgetBatch([input.askId])` builds `regen:ask:{ASKID}:{date}`
  (`tracker.ts:72`), misses, and reports `{used: 0, remaining: 3}` — a *known
  zero*, not unknown — so `budgetRemaining: 3` and the domain does not refuse.
- The worker's authoritative `checkAskRegenBudget(input.askId, outboxId)`
  (`tracker.ts:319-350`) builds the same upper-cased key and INCRs from 0.

So the stated invariant "Bounded at **3 per ask per day**" (CONTEXT.md
**Ask regeneration**) is bypassable by varying hex-letter case in the request
body. Every SQL predicate uses `::uuid`, so the crafted id still resolves to the
right ask.

Severity stays Low because the real spend bound is elsewhere and is
account-keyed: `enforceDashboardRegenRateLimit` (the hour layer, "30 × the 15 ¢
pessimistic reserve ≈ $4.50/hr") and the daily cost budget both still hold. It
is also a pre-existing shape in the review lane (`regenBudgetKey(reviewId)`,
`tracker.ts:58`), so a fix should probably canonicalise at both doors.

Second, cosmetic consequence of the same gap: `readRegeneratingAskId` returns the
payload's upper-cased ask id, so `regeneratingAskId === row.askId`
(`AskList.tsx:131`) is false and no row shows "Writing a new version…" — every
control is disabled with nothing saying which one is in flight.

### 6 — `not_regenerable` copy names a state it was not told

`RequestAskRegenerationResult`'s `not_regenerable` arm covers `approved`,
`veto_window`, `sending`, `halted`, `expired`, `closed` and `pending`
(`approval.ts:412-416`), and `toWire` faithfully puts `state` on the wire
(`regenerate/route.ts:62-64`). `LANE_REFUSAL_COPY` (`ApprovalPanel.tsx:346-347`)
ignores it and asserts one cause:

> "This batch has been approved, so its messages can no longer be changed. Stop
> the batch if you need to."

Reachable from a stale tab: the batch is halted by `admin_halt` or expires past
its 7-day window while the panel is open, the owner clicks Regenerate, and the
panel tells them their batch was approved and offers to stop an already-stopped
batch. The `state` needed to say the true thing is already in hand.

---

## Verified clean

Checked and found correct; recorded so a later reader does not re-derive them.

- **404-before-429 ordering, both halves.** Route: `enforceDashboardRegenRateLimit`
  is account-keyed (no ask leak), the peek only *reads*, and the refusal is the
  domain's (`regenerate/route.ts:81-96`). Domain: enqueue → `lockBatchForAction`
  (404) → state gate → locked ask read (404) → **budget last**
  (`approval.ts:487-528`). An over-budget foreign ask therefore answers 404, and
  the route test at `approval-routes.test.ts` pins it.
- **`already_in_flight` plain return.** `enqueueGenerateSolicitationAsks` is
  `INSERT … ON CONFLICT … DO NOTHING RETURNING id`
  (`job-outbox-helpers.ts:661-677`); on conflict it writes **nothing**, so the
  normal return commits an empty transaction. Correct — this is the one refusal
  that may legitimately not throw.
- **Fail-open budget semantics.** Absent map entry ⇒ absent record key ⇒ no
  counter, control enabled (`batch-view.ts:570-576`, `AskList.tsx:180-186`).
  Present-with-`used: 0` renders. Both halves pinned by
  `renders no regenerate counter when the budget is unknown`. The route's
  `budget?.remaining ?? null` uses `??`, so a real `0` is not coerced to `null`.
  The `budget_exhausted` arm's assert (`regenerate/route.ts:112-119`) is
  genuinely unreachable-unless-broken.
- **Byte-for-byte guarantee.** `isRegenerableBatchState` is `state === 'built'`
  and is applied at **both** gates: the non-transactional pre-check
  (`ask-generation.ts:1359-1363`) and the locked re-check under `FOR UPDATE` on
  the batch row (`ask-generation.ts:1414-1431`). The `delivery_status !==
  'rendered'` second layer survives beneath it. The live-DB race test
  (`ask-generation.integration.test.ts`, `keeps approved outreach bytes unchanged…`)
  runs `approveBatch` *inside* the LLM mock, so the locked re-check is the gate
  under test, and it asserts on bytes + `attempt_no` + absence of a `superseded`
  row. Real oracle.
- **Invariant #2.** The `job_outbox` row and the `ask_regeneration_requested`
  step are in one `sql.begin` (`approval.ts:466-548`); every refusal after the
  enqueue throws `RegenRequestAbort` so the row rolls back, and the live-DB
  rollback test asserts zero in-flight rows afterwards.
- **Invariant #8.** Every domain statement carries both tenant keys. The one
  unscoped read (`readRegeneratingAskId`) is D3-accepted and is enforced
  *negatively* by a test asserting the query text contains none of
  `solicitation_batches` / `account_id` / `business_id`.
- **Invariant #13.** No `NEXT_PUBLIC_*` added; `sendLane === null` remains the
  only channel, and `RequestsClient.tsx:398` spells the null check explicitly
  rather than `?.` (so a flag-off built batch does not poll to the ceiling).
- **Invariant #15.** `requestAskRegeneration(sql, …)`, `readRegeneratingAskId(db, …)`
  both take the client explicitly; `regenerate/route.ts` is the composition root.
- **Surface.** All 28 changed files fall inside `allowed_edit_surface` (with
  D2's approved `src/lib/agents/*` amendment, spent on exactly one line of
  `run-spine.ts`). No drift.
- **Non-goals.** No owner edit affordance (`queryByRole('textbox')` asserted
  null), no post-approval regeneration, no "regenerate all", no `worker/` change,
  no admin halt writer, no migration, no flag flip.
- **`tests_to_add`.** All 40 titles exist verbatim in the tree. Beyond the two
  called out in finding 2, spot-checking found the bodies to be real oracles —
  several are explicitly mutation-checked in the deviations file (D8, D11, D14).

---

## Low-confidence appendix

Not in the table — either below the bar or a judgement call rather than a defect.

- **`already_in_flight` precedes tenant validation** (`approval.ts:471-475`). A
  POST naming a *foreign* batch id that currently has a generation in flight
  answers 409 `already_in_flight`, where an unknown id answers 404 — a narrow
  existence oracle contradicting `edge_cases[7]`'s "indistinguishable from an
  unknown one". Unexploitable in practice (UUIDv7 batch ids are unguessable) and
  the enqueue-first ordering that causes it is deliberate and load-bearing;
  moving the check would reintroduce the deadlock. Recording it only so a future
  reader does not mistake it for an unnoticed hole.
- **`rolls back the regeneration outbox row when recording ask_regeneration_requested fails`**
  (`approval.integration.test.ts`) does not actually reach `recordStep` — the
  re-pointed `subject_id` makes `send_parent_run_id` null, so the raw
  missing-parent assertion (`approval.ts:530-535`) throws first. The rollback it
  proves is real; only the title is off by one throw site. D11 documents the
  fixture without noticing this.
- **A 409/429 refusal does not refetch** (`ApprovalPanel.tsx:519-522` returns after
  `setError`). If the ask went withheld in another tab, the owner reads
  "We cannot write a new version of this message" against a row the panel still
  shows as sendable. Pre-existing shape shared with approve/halt.
- **`regenerateAnnounce`'s non-`accepted` arm** (`ApprovalPanel.tsx:452-455`) is
  dead: 202 is the only 2xx the route emits. Harmless.
- **`_shared/scoped-batch-route.ts` header still says "three POST routes"** — known
  (D12), deferred to a sweep PR, not re-reported.
