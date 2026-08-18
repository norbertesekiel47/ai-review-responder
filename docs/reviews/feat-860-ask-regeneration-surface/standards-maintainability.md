# feat-860 — Standards & maintainability review

Branch: `feat-860-ask-regeneration-surface` · fork point `f28451ee` · 28 files, +5295/−150
Method: `/thermo-nuclear-code-quality-review` applied to the full diff, plus the repo's
`.claude/CLAUDE.md` invariants and working rules, `CONTEXT.md` glossary discipline, and the
`codebase-design` deep-module vocabulary. Read-only — nothing in the diff was modified.

Known-and-accepted items from the brief (`readRegeneratingAskId`'s absent tenant predicate D3,
the ask-keyed exclusion set with no pruning D14, `requestAskRegeneration`'s enqueue-before-validate
with `RegenRequestAbort`, `askRegenLimitResponse` naming D5, the `'batch' | 'ask'` log discriminator
D6, `scoped-batch-route.ts`'s stale header D12, and the `ASK_REGEN_LIMIT_MESSAGE` **string**) are
excluded and are not re-litigated below.

---

## Verdict

No architecture invariant is violated. No `any`, no silent catch, no bare string literal for a
topic, status or job name in production code (`QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` and the
byte-for-byte in-flight status tuple are both spelled correctly). Invariants #1, #2, #8, #12, #13
and #15 all hold. The tests are unusually good — mutation-checked oracles, negative assertions that
pin decisions rather than implementations, and a live-DB byte-finality race that is genuinely
deterministic.

Ten findings clear the 80% bar. One is a runtime-shaped structural regression (Redis I/O inside an
open Postgres transaction). Three are single-owner / duplicated-rule problems. Two are copy or
accessibility defects the owner would actually hit. Four are documentation facts the diff made
false.

---

## Findings

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | Medium-High | `src/lib/solicitation/batch-view.ts:570` | A Redis `MGET` is awaited inside an open `REPEATABLE READ, READ ONLY` Postgres transaction, holding a pooled connection and an admission slot across a network call. |
| 2 | Medium | `src/lib/solicitation/approval.ts:588` | ADR 0020's rule ("`built` is the only regenerable Batch state") has two production owners; the predicate that documents itself as the only one has no test covering the second. |
| 3 | Medium | `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:346` | `LANE_REFUSAL_COPY.not_regenerable` asserts "This batch has been approved" for three states in which it was not, and the correcting `state` is on the wire but discarded. |
| 4 | Medium | `src/lib/solicitation/approval.ts:623` | The `budget_exhausted` gate — the one refusal keyed on a caller-supplied number, sitting after the enqueue — has no test anywhere; the route suite only ever mocks the status. |
| 5 | Medium | `docs/directory.md:900` | The code map's `approval.ts` row still says "the **two** OWNER verbs" and states a lock order the new third verb's own docstring calls incomplete; `docs/directory.md:706` likewise still says "both … entrypoints". |
| 6 | Medium | `src/app/(authenticated)/dashboard/requests/AskList.tsx:179` | A static `aria-label` overrides the button's text, so the "Writing a new version…" in-flight state is invisible to assistive tech, and the visible label "Regenerate" is absent from the accessible name (WCAG 2.5.3, Level A). |
| 7 | Medium | `CONTEXT.md:72` | The branch coins **Ask regeneration** and then uses its `_Avoid_` terms in six places, including the glossary file itself and a comment that manufactures a carve-out the term does not grant. |
| 8 | Low | `docs/adr/0020-regeneration-refused-after-approval.md:34` | ADR 0020 names a `regenerate_solicitation_ask` topic that does not exist; the shipped design reuses `generate_solicitation_asks`, which is *why* the per-batch dedup works. |
| 9 | Low | `src/app/api/dashboard/solicitation/batch/regenerate/route.ts:78` | The regenerate route has no cross-origin test and no test that exercises the rate-limiter short-circuit — the two orchestration branches its siblings both pin. |
| 10 | Low | `src/lib/solicitation/__tests__/ask-generation.integration.test.ts:169` | `seedDispatchedOutboxRow`'s new comment gives a demonstrably false reason for its raw topic literal, and hides the real one (the in-flight partial unique index). |

---

## Detail

### 1 — Redis I/O inside an open Postgres transaction (Medium-High)

`src/lib/solicitation/batch-view.ts:570-576`

```ts
const regenBudgets = Object.fromEntries(
  await peekAskRegenBudgetBatch(
    attempts.filter((a) => a.deliveryStatus === 'rendered').map((a) => a.askId),
  ),
);
```

`readSendLane` is called at `batch-view.ts:679`, inside `readLatestBatch`'s
`sql.begin` (`:725`) whose first statement is
`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` (`:726`). So this `MGET` runs while a
Postgres transaction is open.

Bound on the hold: `getCacheRedis` sets `connectTimeout: 3_000` and `commandTimeout: 3_000`
(`src/lib/db/redis-cache.ts:25-31`). A degraded-but-up Upstash therefore pins a pooled connection —
and, per CLAUDE.md's "#773 admission chokepoint" gotcha, an admission slot on the wrapped `sql` —
for up to three seconds per call. `GET /api/dashboard/solicitation/batch` is polled every 2 s per
open tab while a batch is `building`, and this branch **widens** that to also poll while a
regeneration is in flight (`RequestsClient.tsx:397-401`). A cache latency spike becomes DB pool
pressure on the dashboard read path.

The peek is explicitly not part of the snapshot contract — the file's own comment says the third
statement and the Redis peek "are ADVISORY presentation facts, not inputs to any gate"
(`batch-view.ts:441-446`). And the precedent the code cites for the `Map → Record` seam,
`src/lib/past-replies/load-replies.ts:403`, performs the identical peek **outside any
transaction**. The send lane mirrored the shape and missed the placement.

Remedy: hoist the peek out of `sql.begin` — do the tenant-scoped reads in the transaction, resolve
the `askId` list from the returned attempts, then peek and merge into `sendLane`. Behavior
preserving, and it restores parity with the review lane.

### 2 — Two owners for ADR 0020's rule (Medium)

`src/lib/solicitation/ask-generation.ts:1242` exports:

```ts
export function isRegenerableBatchState(state: BatchState): boolean {
  return state === 'built';
}
```

whose docstring says, verbatim: *"Exported ONLY so the invariant test can assert the decision
directly … **No production caller outside this module.**"*

`src/lib/solicitation/approval.ts:588` is a production caller in another module, and it re-spells
the rule inline:

```ts
if (state !== 'built') {
  throw new RegenRequestAbort({ status: 'not_regenerable', state });
}
```

The property test at `src/lib/solicitation/__tests__/ask-generation.test.ts:1133-1156` asserts
`isRegenerableBatchState(state) === (state === 'built')` over an exhaustiveness-checked state list.
It proves the predicate and nothing about the request path.

Concrete failure: ADR 0020's own "Alternatives considered" section lists the conditions under which
this decision gets revisited (per-ask approval state, a #630 releaser that coordinates). The day
someone widens `isRegenerableBatchState`, the worker accepts the wider set and
`requestAskRegeneration` keeps refusing everything but `built` — the owner clicks Regenerate, gets a
409, and every test in the repo stays green. This is the `codebase-design` "two owners of one fact"
shape, and the fix is one import of a pure predicate (approval.ts already imports `deriveBatchState`
and `BatchState` from a sibling, so no new coupling direction is created).

Secondary, same shape and lower stakes: the `delivery_status !== 'rendered'` guard is duplicated at
`approval.ts:611` and `ask-generation.ts:1376`.

### 3 — `not_regenerable` copy is false in half its states (Medium)

`ApprovalPanel.tsx:346-347`:

```ts
not_regenerable:
  'This batch has been approved, so its messages can no longer be changed. Stop the batch if you need to.',
```

The union member's own docstring (`approval.ts:506-508`) enumerates what lands here: *"`approved`,
`veto_window` and `sending` land here, **and so do `halted` / `expired` / `closed`**."* For those
three, the sentence states a fact that is false, and then invites the owner to stop a batch that is
already stopped, expired or closed.

Reachability does not require a second tab. `panelMode` derives from the last fetched
`sendLane.batchState`, and the poll loop `stop()`s once a batch is `built` and not regenerating
(`RequestsClient.tsx:405`). A tab left open past `built_at + 7 days` is showing the `approvable`
panel over a server-side `expired` batch; clicking Regenerate returns 409 `not_regenerable` with
`state: 'expired'`, and the owner reads "This batch has been approved."

The correcting fact is already on the wire — `toWire` deliberately carries `state` for exactly this
arm (`regenerate/route.ts:59-61`) — and `postLaneAction` reads only `status` and `message`
(`ApprovalPanel.tsx:413-415`), so it is discarded. Either branch the copy on `state` (the panel
already has a total `HALT_BODY` record over `HaltReason` as precedent, `:198-208`) or drop the
approval claim and say only what is true of every arm.

### 4 — The budget gate is entirely untested (Medium)

`approval.ts:618-625` is the one refusal in `requestAskRegeneration` whose predicate is a
caller-supplied value, and it sits **after** the outbox INSERT in a function whose docstring spends
eight lines explaining that a post-enqueue refusal must throw rather than return
(`approval.ts:556-561`) — while the arm immediately above it, `already_in_flight` at `:578`,
legitimately *does* return. That is a genuinely easy line to get wrong.

Coverage today:

- `src/lib/solicitation/__tests__/approval.integration.test.ts` — ten call sites, every one passing
  `budgetRemaining: 3`, with an explicit comment that `null` "would mask a budget defect". Nothing
  passes `0`.
- `src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts:457` — mocks
  `requestAskRegeneration` to resolve `{ status: 'budget_exhausted' }`. It proves the route's
  status → 429 mapping, not that any input produces that status.

So: inverting the comparison to `>= 0`, dropping the `!== null` guard, or converting the `throw`
into a `return` all pass the whole suite. The last one is the expensive one — postgres.js commits
when the `sql.begin` callback resolves, so the outbox row survives and the worker spends money on a
regeneration the API just refused as over-budget. Two live-DB cases (`budgetRemaining: 0` →
`budget_exhausted` with `readInflightOutbox(...)` empty; `budgetRemaining: null` → `accepted`) close
it, and both fit the existing `describe` block's helpers.

### 5 — `docs/directory.md` rows are now false (Medium)

`docs/directory.md:900` — the `src/lib/solicitation/approval.ts` row:

> "**(#629)** The **two** OWNER verbs of the send lane … Lock order is batch → run (amendment B11),
> so every run-spine call happens last."

Both halves are now wrong. There are three verbs, and `requestAskRegeneration`'s own docstring says
the stated lock order is *incomplete*: *"B11's stated 'advisory first, then row locks' is INCOMPLETE
for any writer that owns an outbox attempt"* (`approval.ts:545-547`), with `job_outbox` prefixed
ahead of the chain. The directory row is the sentence a future author reaching for this module reads
first, and it now contradicts the module.

`docs/directory.md:706` — the `dashboard-regen-rate-limit.ts` row still reads "shared by **both**
authenticated 'regenerate an AI draft' entrypoints" and lists two exports. The module's own header
comment was corrected to "the **THREE** … entrypoints" in this same diff
(`dashboard-regen-rate-limit.ts:8-10`), and a third export `askRegenLimitResponse` was added. Doc
and code disagree inside one PR.

`ci:directory-map` checks row *presence*, not content, so nothing catches either. The working rule
is explicit: "grep the filename to clean every cross-reference in the same change." D12 shows the
team already applies this — the route rows were correctly updated; the library rows were missed.

(`docs/directory.md:897`, `batch-view.ts`, is also now incomplete — it describes the transaction and
does not mention Q6 or the Redis peek — but it states nothing false, so it is a lower-grade omission.)

### 6 — The regenerate control's state is invisible to assistive tech (Medium)

`AskList.tsx:174-182`:

```tsx
<button
  …
  aria-label={`Ask for a new version of the message to ${displayName(row)}`}
>
  {regenerating ? REGENERATING_LABEL : REGENERATE_LABEL}
</button>
```

`aria-label` wins over text content when computing the accessible name, and it is static. Two
consequences:

1. **The in-flight state is never announced.** The `REGENERATING_LABEL` swap ("Writing a new
   version…", `:59`) changes only the visible DOM text. A screen-reader user hears nothing, and the
   button simultaneously becomes `disabled` (`:178`), which removes it from several AT navigation
   modes. Combined with the settle effect (`ApprovalPanel.tsx:655-666`), which announces on the
   *failure* path only, an AT user gets a "Writing a new version." live-region sentence at 202 and
   then silence — including on success, when the new copy arrives with no announcement at all.
2. **WCAG 2.5.3 Label in Name (Level A) fails.** The visible label is "Regenerate"; the accessible
   name is "Ask for a new version of the message to Ana". The visible string does not appear in the
   accessible name, so a speech-input user saying "click Regenerate" cannot activate it.

The test that looks like it covers this does not: `approval-panel.test.tsx:757-759` uses
`toHaveTextContent`, which reads DOM text rather than the accessible name, so it passes while the
a11y contract fails. This is the "asserts implementation rather than behavior" shape.

Remedy that keeps both the glossary-safe wording and the a11y contract: put the visible word inside
the accessible name (`aria-label={\`Regenerate the message to ${name}\`}` reads as
`_Avoid_`-compliant only if "Regenerate" stays the domain word — it is), or drop `aria-label`, keep
the visible text as the name, and move the per-contact disambiguation to `aria-describedby` on the
row. Add `aria-live="polite"` or an `aria-busy` signal for the in-flight swap.

### 7 — The branch coins **Ask regeneration** and then breaks its own `_Avoid_` list (Medium)

`_Avoid_`: *edit, rewrite, redraft, retry, re-roll*. Excluding the accepted `ASK_REGEN_LIMIT_MESSAGE`
string, the diff ships six violations:

| file:line | text |
|---|---|
| `CONTEXT.md:72` | "The owner's post-approval recourse is the **Halt latch**, not a **rewrite**." — in the glossary file itself, in the entry immediately above the term. |
| `docs/adr/0020-…:96` | "Allowing a **rewrite** during it makes the guarantee…" |
| `ApprovalActions.tsx:39` | "while the owner waits on a **rewrite** is the lane's copy lying about which act is in progress" |
| `ApprovalPanel.tsx:284` | "a **re-roll** supersedes the row and inserts a replacement under a new id" |
| `dashboard-regen-rate-limit.ts:119-121` | "Owner-facing language says '**rewrite**' because that is what the control offers … exactly as `halt` reads as 'stop' on screen." |
| `approval-panel.test.tsx:865` | test title: "shows the daily **rewrite** limit when a regenerate POST is refused 429" |

The rate-limit comment is the one that will keep causing damage. It asserts a carve-out by analogy
to **Halt latch**'s single "stop" exception — but **Ask regeneration** grants no exception, and
`AskList.tsx:54-58` says so explicitly in the same branch: *"unlike the **Halt latch**'s single
'stop' carve-out that list has no owner-facing exception."* Two files in one PR give opposite
readings of the same rule, and the wrong one sits directly above the string the brief already
accepts. That comment is a written licence for the next author.

`ApprovalPanel.tsx:284` and `ApprovalActions.tsx:39` are new prose in new code and cost nothing to
fix. `CONTEXT.md:72` and the ADR are the glossary's own documents.

(`ask-generation.ts:10` also still says "the per-ask LLM **re-roll**" on a line this diff edited;
inherited from #628, but the branch touched it and coined the term.)

### 8 — ADR 0020 names a topic that does not exist (Low)

`docs/adr/0020-regeneration-refused-after-approval.md:33-35`:

> "#860 builds that entry point — the Requests panel's per-ask **Regenerate** control, the `POST`
> route, and the `regenerate_solicitation_ask` topic."

There is no such topic. `requestAskRegeneration` enqueues
`QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` with `ask_id` in the payload
(`job-outbox-helpers.ts:645-678`). Repo-wide, `regenerate_solicitation_ask` appears only as a
`requireAttempt` diagnostic label (`ask-generation.ts:1313`) and as a fabricated test fixture topic
(`ask-generation.integration.test.ts:661`).

This is load-bearing, not cosmetic: the *shared* topic is exactly why the `(topic, aggregate_id)`
partial unique index yields "at most one regeneration in flight per **batch**" and why "regenerate
all cannot exist as a fan-out" — the sentence `CONTEXT.md:74` gets right and the ADR contradicts. A
reader who believes the ADR will go looking for a `QUEUE_NAMES` entry, a worker route and a
migration that were never meant to exist.

### 9 — Two untested orchestration branches on the new route (Low)

`approval-routes.test.ts` pins a cross-origin 403 for approve (`:274`) and for halt (`:306`).
Regenerate has none. `docs/directory.md`'s halt row states the reason the halt test exists: *"halt is
as destructive as approval and must not be the one verb whose CSRF guard is unasserted."* Regenerate
is now that verb — and unlike approve and halt it causes an LLM spend.

Separately, `mockEnforceRegenLimit.mockResolvedValue(null)` in `beforeEach` (`:184`) is never
overridden, so `route.ts:78-79`:

```ts
const limited = await enforceDashboardRegenRateLimit(accountId);
if (limited) return limited;
```

never returns early in any test. The ordering that puts the per-owner limiter ahead of the peek and
the domain call — deliberate, and documented at the top of the route — is unasserted.

### 10 — A test comment with a false reason and an invented topic (Low)

`ask-generation.integration.test.ts:169-174` justifies its raw topic literal:

> "`topic` is a raw literal rather than a QUEUE_NAMES constant because the send-mode topics ship
> without one until their producers land (migration 091 §7, amendment B10)"

`QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` exists (`src/lib/shared/queue-names.ts:19`) and is imported
by the sibling live-DB suite in this same branch (`approval.integration.test.ts:26`). The default
parameter re-spells a constant the repo already owns, against the working rule "no string literals
for … job names — import the constant from its single authoritative TS file."

The comment also does not state the real reason the second call passes
`'regenerate_solicitation_ask'` (`:661`): the first seeded row is still `dispatched`, i.e. in-flight,
so `job_outbox_generate_solicitation_asks_inflight` would reject a second row with the same
`(topic, aggregate_id)`. Sidestepping the index with a fictitious topic means the fixture's outbox
row does not have the shape production writes — the very shape that makes the per-batch dedup work.
Completing the first row (or using the real topic on a fresh aggregate) would keep the fixture
honest; if the fictitious topic is genuinely the pragmatic choice, the comment should say *that*.

---

## Explicitly checked and clean

- **Invariant #1** — no `openai`/`bullmq`/`postgres`/generator import reaches `src/app/**`. The new
  route imports `sql` from `@/lib/db/server` as a composition root, which is the sanctioned shape.
- **Invariant #2** — the outbox row and the run step are written in one `sql.begin`, via the typed
  helper `enqueueGenerateSolicitationAsks`. No raw `INSERT INTO job_outbox` was added to production
  code. `batch-view.ts:407` spells the in-flight status tuple byte-for-byte and in order.
- **Invariant #8 / #15** — `requestAskRegeneration` takes `sql` and both tenant ids; every new
  `solicitation_*` statement carries `account_id` and `business_id`. `job_outbox` correctly does not
  (D3, accepted).
- **Invariant #12** — `regenerate/route.ts` is a genuine thin adapter: parse, two advisory gates, one
  domain call, one status switch. 137 lines, nearly half comment.
- **Invariant #13** — no `NEXT_PUBLIC_*` companion; the flag gate 404s ahead of auth and a test pins
  that no auth work and no Redis read happens with the flag off.
- **No `any`, no silent catch.** Both "no catch here, deliberately" sites
  (`batch-view.ts:561-568`, `load-replies.ts:396`) are justified against a function with a proven
  no-rejection contract, and `tracker.test.ts` now pins the synchronous-throw half of that contract.
- **`peekBudgetBatch` extraction (asked about explicitly)** — earned. Two real callers, a genuine
  varying axis (`keyFor`), and it deletes a full duplicate of the fail-open body. The `'batch' |
  'ask'` discriminator is a log label with a documented reason for its historical value, not a
  behavior switch.
- **`approval.ts` cohesion (asked about explicitly)** — still one coherent module at 657 lines, not a
  junk drawer. All three verbs share `canonicalBatchId`, `lockBatchForAction`, one lock-order
  analysis and one result-union shape; the module's stated interface ("transactional writers with an
  actor") holds for all three. Finding 2 is about a rule leaking *out* of `ask-generation.ts`, not
  about `approval.ts` accreting.
- **Test quality generally** — the mutation-checked oracles (D8, D11, D14), the negative D3
  assertions, and the `captureStatements` ordering probe are all real oracles. The one exception is
  finding 6's `toHaveTextContent`.

---

## Low-confidence appendix (not in the table)

Judgment calls I would not stake 80% on. Recorded so they are not rediscovered.

- **`ApprovalPanel.tsx` at 728 lines (+241) is doing four jobs.** It holds the redaction projection,
  a mode/copy state machine, a small HTTP client (`postLaneAction` / `toLaneStatus` / `refusalCopy` /
  `LaneOutcome`), a 14-key copy catalogue total over three server unions, and the component. With a
  third verb landed, `useLaneWrites` + the wire layer + `LANE_REFUSAL_COPY` are a plausible
  `lane-writes.ts`. It is under the 1000-line line, every section is banner-separated and each helper
  is small, so this is preference, not a defect — but it is the file to watch on verb four.
- **`ApprovalActions`' two-boolean interface (`busy` + `unavailable`).** The split is correct and
  well argued (D13): only `busy` licenses the "Approving…" label. But `blocked = busy || unavailable`
  invites a third boolean the moment a third non-own-write reason appears. A single
  `state: 'idle' | 'busy' | 'blocked'` would make that impossible to get wrong. Not worth changing
  today.
- **`RegenerateControl`'s `|| regenerating` is dead.** `AskList.tsx:178` disables on
  `disabled || exhausted || regenerating`, but the caller already folds
  `regeneratingAskId !== null` into `disabled` (`:144`), so `regenerating === true` implies
  `disabled === true`. Harmless defensive redundancy; arguably clearer than not.
- **A withheld replacement announces nothing.** If a regeneration succeeds but its replacement is
  `withheld`, the ask leaves `sendable`, the settle effect finds no row
  (`ApprovalPanel.tsx:659-665`) and says nothing — the owner's message silently disappears from the
  list. The reason surfaces in `BatchReport`, so this may be intentional; it reads as a gap.
- **`askRegenLimitResponse` has one caller.** "No abstractions for a single caller" would bite, except
  it is colocated with its sibling in the module that owns regen-limit responses and holds the copy
  constant. Fine as shipped.
- **The `fc.assert` over eight constants** (`ask-generation.test.ts:1149`) is a table test wearing
  property-test clothes — `fc.constantFrom` over a closed union runs the same eight cases 100 times.
  The exhaustiveness assertion above it (`:1145`) is the part doing the work. Harmless.
- **`ApprovalPanel.tsx:865`'s `limitMessage` duplicates the server string verbatim** rather than
  importing `ASK_REGEN_LIMIT_MESSAGE`. As a copy pin this is arguably correct (an accidental server
  copy change should fail the client test loudly), so I would not change it.
