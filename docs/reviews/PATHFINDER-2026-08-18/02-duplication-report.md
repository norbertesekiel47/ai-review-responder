# Pathfinder 2026-08-18 — duplication report

Two axes. Within-feature below; cross-feature appended after it.

Every claim cites ≥2 verified `file:line` locations. **Specialization is not duplication** —
findings that look alike but serve different trust models or data sources are recorded as
LEAVE, with the reasoning, so the next pass does not re-raise them.

---

# Part 1 — Within-feature

## W1. The "cancellable set" has **six** production spellings and no named owner — F1 + F2

**Locations** (Phase 1 found four; this pass found two more):

| Spelling | Site | Role |
|---|---|---|
| SQL WRITE | `approval.ts:494` | `latchHalt` cancel |
| SQL WRITE | `approval.ts:1126` | `withdrawAsk` CAS guard |
| SQL READ | `batch-view.ts:948` | `cancellableCount` |
| TS server | `approval.ts:1010-1011` | `classifyWithdrawal` |
| **TS client** | **`ApprovalPanel.tsx:973`** | `useArmedWithdrawal`'s `live` subset — **new** |
| **TS client** | **`AskList.tsx:306`** | gates whether the row gets a withdraw control — **new** |

Named owner exists for the **complement** only: `outreach.ts:136-146`
`TERMINAL_DELIVERY_STATUSES` / `isTerminalDeliveryStatus` — and it is **module-private**
(`:113-116` says so; the only consumer is `outreach.ts:245`).

**Verdict: CONSOLIDATE the three TypeScript spellings. LEAVE the three SQL spellings literal.**

The SQL literals are deliberately un-parameterized. `approval.ts:1119-1120`: *"The status
literals are PARAMETERS so the query-shape pin can assert them by value; the IN list stays
literal, as in `haltBatch`."* Two query-text pins depend on that spelling
(`approval.test.ts:302`, `:570`). Parameterizing them is a net loss.

The TS side has no such constraint and the drift risk is **asymmetric and live**:
`AskList.tsx:306` decides *whether a control is offered*, `ApprovalPanel.tsx:973` decides
*whether an arming survives a refetch* — both mirror a server decision they cannot import.
`approval.ts:931-935` already documents this class and admits *"no test ties that mirror to
this list."*

**The owner**: a dependency-free leaf, `src/lib/solicitation/delivery-status.ts` —
`CANCELLABLE_DELIVERY_STATUSES` + `isCancellableDeliveryStatus`. It **must not** live in
`outreach.ts` (runtime-imports `@/lib/agents/run-spine` at `:28`) or `approval.ts`; both
client files import from `@/lib/solicitation/*` **type-only today**, which is what invariant
#1 permits.

**Do not** derive the cancellable set as the complement of `TERMINAL_DELIVERY_STATUSES`.
`approval.ts:1146` (`+'sending'`) is the actual complement and is a *different question*;
folding them makes one constant answer three.

## W2. "Did the close settle the batch?" — four spellings, **two different forms**, no owner — F1

**Locations**: `halt/route.ts:45`, `withdraw/route.ts:43`, `admin/…/halt/route.ts:91` — all
three `closed: result.close.status !== 'not_settled'`; plus `approval.ts:404`
`close: close.status === 'not_settled' ? null : close` and its consumer
`approve/route.ts:60` `closed: result.close !== null`. Union owner: `outreach.ts:201`, `:359`.

**Verdict: CONSOLIDATE.** Not flagged by Phase 1.

One fact, four sites, two forms — **and the two forms already produced a documented defect**.
F2's chart found `ApprovalPanel.tsx:562-563` asserting *"approve, halt and regenerate do not
send them"*, which is **false for `closed`** precisely because approve and halt compute it by
two different routes and nobody reconciled them. Same shape as W1, with a live documentation
casualty attached.

**The owner**: `batchDidClose(close: CloseBatchIfSettledResult): boolean` in `outreach.ts`,
beside the union it discriminates. Optional second step with a real deletion: drop
`approval.ts:404`'s ternary so `ApproveBatchResult.close` is non-nullable like the other
three — then all four read identically and the wrong comment becomes trivially fixable. That
step changes a public domain union, so it is a choice, not a cleanup.

## W3. `HaltableState` is a hand-copy of `isWithdrawableState` — F1 + F2

`approval.ts:939-941` (`'veto_window' | 'approved' | 'sending'`) vs
`ApprovalPanel.tsx:144-146` `type HaltableState = Extract<SendLaneView['batchState'], …>`,
consumed at `:177`, `:232-233`, `:257`, `:318`. Third partial spelling in prose at
`AskList.tsx:30-32`.

**Verdict: CONSOLIDATE, together with W1** — same owner, same placement constraint.

`approval.ts:931-938` names this duplication and accepts it with a sound reason (client
component; `approval.ts` runtime-imports server modules) and an honest cost. **The reason
justifies not importing `approval.ts`; it does not justify having no shared owner.**

**Do not** collapse it with the halt guard list (W4) — halt is legal in `built`/`expired` too.

## W4. Five verbs × the block shape in one 1,178-line file — F1 — **REFUTED**

**Verdict: LEAVE (legitimate specialization).** Phase 1's hypothesis does not survive reading.

What actually repeats is **three lines per verb** (`canonicalBatchId`, `sql.begin`,
`lockBatchForAction` + null arm) — already extracted at `:144` — plus a **two-line verbatim
copy** of the halt guard list between `:597,600` and `:684,685`.

The bodies share nothing else: `approveBatch` runs a readiness anti-join and a
validate-then-mutate exclusion block; `requestAskRegeneration` throws every refusal because
it enqueues *before* the lock; `withdrawAsk` resolves a lateral current-attempt. Even the
null-lock arm diverges four-to-one, and `:120-131` explains that folding it *"would silently
start the regeneration this helper just refused."* `:657-663` records the 2-line halt guard
was deliberately unified across arms; extracting two lines would cost more than it saves.

## W5. `── The write ──` — counts confirmed, and it is **not** a duplication finding — F2

Section is `:434-851` = **418 lines**. Per-verb ≈ **68**. Shared ≈ **350**. All three
single-consumer members confirmed exactly as Phase 1 reported.

**Verdict: LEAVE (not a duplication).** The four writes are already single-owner; nothing
repeats. The file-size problem is a different axis and belongs to issue #886, not here.

**What any extraction must preserve — put this in the ticket or it will regress:**

1. `LaneStatus:444-448` is a **union of the four Result unions** and `LANE_REFUSAL_COPY:505`
   is `Record<LaneStatus, …>`. **Totality is the guard.** Splitting per verb turns four
   compile errors into four silent fallbacks to `GENERIC_REFUSAL:645`.
2. `perform:782-809` differs per verb in exactly `(path, requestBody, announce, refresh)`.
   An extraction that adds a fifth axis has re-introduced the verb switch it removed.
3. `LaneRefresh` is the **parent's render mechanism**, not a verb outcome —
   `RequestsClient.tsx:213/:242/:251` produce values with no verb behind them. Typing it
   per-verb makes those three unspellable.
4. `refused` never refetches (`:794`); `unconfirmed` always leaves the panel (`:802-804`).
   Collapsing them loses the honest-uncertainty contract at `:576-583`.
5. The three single-consumer members must **stay in the shared half** — pushing
   `RefusedState`/`NOT_REGENERABLE_COPY` into a regenerate-only module breaks
   `refusalCopy:647-658`, the one settle path all four use.
6. **`ApprovalPanel.tsx:562-563` is wrong** (W2). An extraction that trusts it will drop a
   field two routes populate.

## W6. Four `toWire` projections + status→HTTP switches — F1 — **LEAVE**

`approve/route.ts:41-68`, `halt/route.ts:31-52`, `regenerate/route.ts:37-53`,
`withdraw/route.ts:32-50`, `admin/…/halt/route.ts:82-97`.

**Verdict: LEAVE (legitimate specialization)** — except the `closed` line, which is W2.

The hand-written whitelist **is** the safety property, stated identically in all five files:
*"a field added to the domain union later cannot silently start shipping: it has to be named
here first"* (`approve/route.ts:104-109`). A generic projector keyed on status restores
exactly the accident it exists to prevent — `close` carries `parentRunId`, an internal
`agent_runs` UUID that ADR 0012 bans from the Requests surface. It would also need a
parameter meaning "this is actually a different result union" — the `held-draft.ts:17-30`
failure mode. **Reject.**

## W7. Purge tombstone: **seven duplicated sentinel literals** between writer and verifier — F9

| Literal | Writer | Verifier |
|---|---|---|
| `'Deleted location'` | `purge-stages.ts:657` | `purge-verification.ts:113` |
| `'professional and friendly'` | `:661` | `:120` |
| `'Deleted owner'` | `:667` | `:121` |
| `'deleted-' \|\| id::text \|\| '@repworth.invalid'` | `:668`, `:649` | `:122`, `:162` |
| `'[]'::jsonb` | `:672` | `:144` |
| `'Deleted account'` | `:696` | `:97` |
| `'Deleted user'` | `:648` | `:161` |

**Verdict: CONSOLIDATE the seven sentinels. LEAVE the two column lists as two lists.**

Writer and verifier must agree **by construction** — that is the entire point of a purge
verifier — and today they agree only because two humans typed the same string. F9 already
found the drift this shape produces (`tracked_keywords` operator mismatch, and a comment
claiming a kind has one member when it has two). A shared constant would not have caught the
operator bug, but it removes the class of *"the verifier passes because it asserts a
different string than the writer wrote."*

The **column lists** stay two lists: a SET clause and an OR-chain over different predicate
kinds. A single declarative table is F9's seed-10 proposal — a design change, not a
de-duplication.

**Do not** point the `tone` sentinel at `prompt-builder.ts:31` `DEFAULT_TONE`. That constant
is a prompt fallback; F9's authority is the schema default at `001_initial_schema.sql:71`.
**Same value, different fact.**

## W8. `recordFailure`'s post-commit log drops `business_id` — F4 — a bug, not a refactor

`solicitation-lane.ts:298`, `:328`, `:356`, `:368` all log `business_id`. The `recordFailure`
block at `:390-396` logs `outreach_id` + `account_id` + `has_reason` only.

**Verdict: LEAVE the five log blocks unabstracted — but fix the drift.** One of five silently
missing a correlation key is a one-line fix. Report as a bug.

## Refuted candidates

- **F5, "duplicated gate/response logic across three entry points"** — **refuted; the core is
  genuinely single-owner.** `redeemUnsubscribeToken` owns its own `db.begin` (`:387`) and
  both writers call it once. The only repeated call is the two-line pre-DB gate, and its two
  consequences **must** differ: 503 `{error:'unavailable'}` vs a 303 to the neutral page. The
  success tests differ deliberately too — `worker/ingress/unsubscribe.ts:124-140` is 17 lines
  of argument for why they must not be one predicate. Unifying needs a parameter meaning
  "which indistinguishability contract am I under". **LEAVE.**
- **F8, "duplication between the SQL and JS lexers"** — **refuted; genuinely different
  grammars.** `lexSql:78-190` handles doubled-quote escaping, `E''` backslash escaping,
  dollar-quoting, and **nested** `/* */` with a depth counter. `JsLexicalScanner:1489-1727`
  handles regex literals with character classes, template `${}` recursion with an expression
  stack, and **non-nested** `/* */` — correct for JS, wrong for Postgres. The one shared
  primitive, `maskCharacters:57-61`, **is already extracted** and used by both. Seed 7's
  split remains available for file size; **there is no duplication to remove.**
- **`AskList.tsx`'s three list variants** — the repeated `<li>` frame is ~4 lines × 3, and
  `AskList.tsx:26-44` gives the reason: *"the read-only list is structurally unable to offer
  a control, and it must stay that way."* A shared row component reintroduces the flag.
  **LEAVE.**
- **`HALT_BODY` vs `HALT_REASON_LABELS`** — both `Record<HaltReason, string>` over one
  imported union, both exhaustive by construction, sharing not one string. Owner second
  person vs operator third person = different trust models. **LEAVE.**

## Within-feature gaps

(a) `fallow`'s duplicate detector was not run; the sweep beyond Phase 1's candidates was
manual and biased toward F1/F2/F9, so a duplication inside F3's `SuppressionsClient`, F6's
CSS or F7 could be unfound. (b) Test files read only where they pin a candidate. (c) W2's
second step was not checked against `approve/route.ts`'s tests. (d) Not verified that a new
leaf under `src/lib/solicitation/` passes `ci:directory-map` without other edits.

---

# Part 2 — Cross-feature

## X1. The cancellable set — **the codebase's own extraction trigger has fired** — F1 ↔ F2/F3

The consumer of the read is confirmed **verbatim**: `SolicitationBatchPanel.tsx:403` renders
*"It cancels the {cancellableCount} rendered and queued message(s) only"*, with `:379-380`
adding the tile hint. The sentence states the consequence of the button beside it.

**The decisive evidence is `CONTEXT.md:75` (Ask withdrawal, LOCKED):**

> *"the duplicated `delivery_status IN ('rendered','queued')` predicate is a deliberate drift
> watch, and a **THIRD caller is the signal to extract** rather than a second (recorded at
> the #872 branch review)."*

**Three SQL callers exist today.** The precondition the codebase set for itself has fired.

**Verdict: ACCIDENTAL (unify), by the codebase's own written trigger.**

Both sides *are* independently pinned — `approval.test.ts:302` and `:570` assert the literal
IN list; `batch-view.integration.test.ts:829` pins `cancellableCount === 2` against a full
7-status seed. **So a one-sided widening still passes the other's suite**: widen the latch
only, and the panel understates the consequence with no test failing. **The coupling is prose
on three sides and mechanical on none.**

## X2. The two `Record<HaltReason,string>` tables — LEGITIMATE copy, **DISAGREEMENT in the guard** — F2 ↔ F3

**The copy: LEGITIMATE.** Different audiences, stated in both docstrings
(`ApprovalPanel.tsx:270-276`, `SolicitationBatchPanel.tsx:42-46`), zero shared strings. The
two files do not even agree on the *mechanism* for state-keyed copy — `haltableBody` is a
`switch` at `ApprovalPanel.tsx:257`, `NON_ACTIONABLE_COPY` is a `Record` at
`SolicitationBatchPanel.tsx:73` — and both are correct. Nothing to consolidate.

**The guard: DISAGREEMENT (live defect, low severity).** The same union is read defensively
on one side and bare on the other:

- `ApprovalPanel.tsx:294-297` — `Object.hasOwn(HALT_BODY, reason) ? … : UNKNOWN_HALT_BODY`,
  with `:288-290` giving the reason: *"The read model ASSERTS `halt_reason` against its CHECK
  rather than re-validating it, so a value from outside the union is possible in principle."*
- `SolicitationBatchPanel.tsx:369` — `HALT_REASON_LABELS[summary.haltReason]`, **unguarded**,
  rendering `undefined` into the sentence for an unknown reason.

**The same file uses the guard idiom twice** (`:130`, `:138`), and its
`NOT_HALTABLE_FALLBACK:110-112` explicitly reasons about *"a server deployed ahead of the
browser"* — the exact scenario it does not cover for `haltReason`. Unreachable today because
of the DB CHECK (`batch-view.ts:138-142`), so this is a **posture divergence**, not an
exploitable bug.

## X3. `recordSuppression`'s two callers — LEGITIMATE — **and both are unreachable in production** — F4 ↔ F5

The divergent `null` readings are confirmed and stated at both sites. Everything else shared
was censused: the three suppression types, the table, and **nothing else**. No shared
transaction helper, no shared handle normalizer — one owner (`handles.ts:12`) with three
documented "already normalized" trust hops. Clean.

**The caveat neither chart states jointly, and it reframes both features:**

> **Both callers are unreachable in production.** `getMessagingAdapter` has no production
> caller, so `provider_message_id` is **never written** (non-test `rg`: only reads at
> `solicitation-lane.ts:80`), so `loadAttribution` can never match. And
> `mintUnsubscribeRawToken` (`unsubscribe.ts:67`) has **zero non-test callers**, with **no
> `INSERT INTO solicitation_unsubscribe_tokens` anywhere in `src` or `worker`**.

**F4 and F5 are the two halves of one loop whose connector (#630) does not exist.** Every
"two callers, both correct" claim in this pass is currently proven **by tests only**.

## X4. The purge's suppression-writer contract names its own callers as nonexistent — F9 ↔ F4 ↔ F5

`purge-stages.ts:781-795` ends: *"**Unreachable today (recordSuppression has zero production
callers, G6); #644/#645/#627 own honouring it when they land the first ones.**"* Those
tickets landed without amending it. No back-link exists in either writer's file.

**Verdict: DISAGREEMENT (stale premise on a live contract).** Both obligations hold today —
but **structurally, not by observation of the rule**: the token row's `account_id` is
scrubbed at `purge-stages.ts:358-364` before finalize, and `solicitation_outreach` is
cascade-deleted with `contact_csv_uploads` (`:296-310`). **Neither writer knows it is
honouring the rule.**

**Adjacent, unflagged**: because the attribution row is deleted, a suppression-bearing Resend
event for a purged account takes `throwUnmatched` → 503 → **Resend retries forever**, and the
recipient's **global** opt-out — the one thing the purge deliberately preserves
(`:325-328`) — is never written. Unreachable today for X3's reason.

## X5. The ABBA lock-order argument is documented on ONE side — F1 ↔ F9

`approval.ts:35-41` states it (echoed in `outreach.ts:169-181`, `batch-builder.ts`). The
purge side documents **only** the advisory-key order against batch construction
(`purge-stages.ts:270-273`); its `agent_outcomes`/`agent_runs` DELETEs at `:396-402` carry an
**FK-ordering** rationale and **no lock-order note at all**. `rg` over both offboarding roots
finds no mention of `approval.ts`, `recordStep`, or a batch→run order.

**Verdict: ACCIDENTAL (asymmetric documentation, not code).** The sequence *is* batch-then-run
today — but it holds inside a list whose ordering comments are all about foreign keys, in a
file already reordered for FK reasons twice. **A reviewer moving `agent_runs` earlier would
satisfy every comment in the file and invert the order three other files depend on.** One
sentence at `:396`, not a refactor.

## X6. The purge/unsubscribe race — the two descriptions AGREE

No contradiction. One-sided depth: `purge-stages.ts:333-337` describes only the **post-purge**
case; the **concurrent** case and the ordering constraint that makes it safe exist only in
`unsubscribe.ts:346-352` and `:400-403`. Serialization is reasoned, not tested.

## X7. The `useReducer` shape — INTRA-admin, and the cross-feature layer is a vocabulary split

Exact shape ×2 confirmed (`SolicitationBatchPanel.tsx:198-236`, `PastDueExtensionPanel.tsx:23-63`
— identical six non-setter actions and identical reducer arms).

**New cross-feature check**: `rg 'submitStart'` returns **8** files — the 5 admin ones plus
`StartLocationClient.tsx:66-68`, `BusinessWizardClient.tsx:69-71`, and
`LeadIntakeForm.tsx:143-145` (F7). Every non-admin instance spells the terminal action
differently: `submitDone` (admin) vs `submitEnd` vs `setSubmitting` vs none.

**Verdict**: the exact shape is **intra-admin** and, with F3 split, belongs to the
admin-console feature — not a Pathfinder cross-feature finding. The cross-feature layer is a
**four-way vocabulary split for "the submit finished"** — a convention gap, not duplication.
**#880's "extract the shared hook, migrate all five" understates the blocking design decision**
(F3's `success: boolean` vs `message: string|null`).

## X8. Seed 9's "reviewed vs never-in-scope" marker exists in exactly ONE place — F8 ↔ F2/F3/F7

`rg 'tenant-tables|TENANT_TABLES' src worker` → **one hit**:
`batch-view.ts:389-400` — *"`job_outbox` is absent from `scripts/ci/tenant-tables.ts`, so a
statement referencing only that table is not audited … Do NOT 'fix' this by joining
`solicitation_batches` to make it look scoped."*

**Same shape, no marker, in features F8 did not sample**: `suppressions-service.ts:110`
(`LEFT JOIN users` — F8's category (ii), unsampled) and `lead-intake/route.ts:256-286`
(`owner_leads`, absent from `TENANT_TABLES`, F7).

**Verdict: ACCIDENTAL.** The convention that would close seed 9 **already exists**, was
written once by one author, and is not a convention. **It is also the cheapest available fix
and needs no bridge-vocabulary work.**

## X9. NEW BUG — a 2-wide DB fan-out in the one admin service both #505 and #773 pins missed

`src/lib/admin/suppressions-service.ts:72`:

```ts
const [rows, corrections] = await Promise.all([sql`…`, sql`…`]);
```

Reached from `admin/suppressions/lookup/route.ts:24` on the singleton `sql` (Vercel,
`DB_POOL_MAX=3`).

**What it contradicts** — `src/lib/db/admission.ts:26-31`: *"Bounding per-request fan-out is
NOT sufficient and this module is **not a substitute for it** … so `/api/admin/flagged`
wedged with a fan-out of **TWO** against a pool of **THREE**."* The sibling route carries the
opposite instruction in code: `admin/costs/route.ts:20-26` — *"SEQUENTIAL — do NOT
re-introduce a `Promise.all` here (#505)"*.

**Why it survived**: the guard is four hand-written pins with **enumerated import lists** —
`admin/__tests__/pool-fanout-sequential.test.ts:33-38` (3 subjects),
`admin-read-single-inflight.test.ts:30-34` (5), plus dashboard and locations.
**`lookupSuppressions` is in none.** No `ci:*` script checks fan-out. The code predates #773
(`ec115089`, 2026-08-04; admission landed `120c76f7`, 2026-08-13) and #882 edited the file
in-window without the sweep reaching it.

**Verdict: ACCIDENTAL (fix).** Severity is bounded by admission (cap == pool ⇒ queue, not
pipeline), so this is latency and contention, not the old permanent wedge — but
`admission.ts`'s own doctrine says per-request fan-out must still be bounded, and **the same
feature gets it right in its other half** (`readAdminBatchSummary`, one statement).

## X10. NEW (meta) — four independent guards, one blind spot: **the guard's scope is an enumeration**

| Guard | Enumeration | Something outside it |
|---|---|---|
| `ci:tenant-scope` | `TENANT_TABLES` (43) | 4 tenant-column tables, unreviewed (seed 9) |
| `ci:admin-aal2` | file-text level, not verb level | prior pass C1 |
| `design-scope-purity` | hard-coded directory list | `auth-island.css:5-15`, **fonts already diverged** |
| #505/#773 fan-out pins | 9 imported subjects | `lookupSuppressions` (X9) |

**A green run of any of these four proves "no finding among the things I was pointed at."** In
three of the four, something outside the enumeration is already wrong or unreviewed. This is
the class behind three of this pass's findings and two of the prior pass's.

## X11. The `Object.hasOwn(TABLE, value)` idiom, 5 copies — LEGITIMATE

`ApprovalPanel.tsx:295, :544, :553` · `SolicitationBatchPanel.tsx:130, :138`. Three lines each;
the tables they guard are the real content. **The finding is not the five copies — it is the
sixth site that omits it (X2).**

## Additions to the DO-NOT-UNIFY register

| Pair | Why it stays two | Evidence |
|---|---|---|
| `HALT_BODY` / `HALT_REASON_LABELS` | Owner 2nd-person vs operator 3rd-person over one union; zero shared strings; both exhaustive by importing `HaltReason` | `ApprovalPanel.tsx:270-292` · `SolicitationBatchPanel.tsx:42-53` |
| `recordSuppression`'s two `null` readings | "Is this handle suppressed?" vs "did Resend's list diverge from ours?" — a pre-existing row answers them oppositely | `unsubscribe.ts:409-410` · `solicitation-lane.ts:197-199` |
| `readLatestBatch` / `readAdminBatchSummary` | Content leak (D9) + a 4-key ordering contract with two named staging defects behind it | `batch-view.ts:840-851`, `:891-927` |
| F1's uniform **404** vs F5's uniform **503** | Same goal (indistinguishability), different correct status: F5 needs a *retryable* code because a token minted after the snapshot must stay recoverable | `admin/…/halt/route.ts:20-24` · `unsubscribe.ts:232-237` |
| `latchHalt` shared by both halt arms, **not** by `withdrawAsk` | The latch makes the two halt ARMS one write (CAS `halted_at`); withdrawal touches neither | `CONTEXT.md:75` (LOCKED) · `approval.ts:468`, `:1023-1032` |
| One `normalizeEmail` owner with three "already normalized" hops | Re-normalizing at each hop hides a bad upstream write instead of surfacing it | `handles.ts:12` · `contacts-csv.ts:159` · `contacts-repo.ts:61` · `suppression.ts:50` |
| The SQL spellings of the cancellable set (W1) | Query-shape pins assert the IN list **by value**; parameterizing loses two tests for nothing | `approval.ts:1119-1120` · `approval.test.ts:302`, `:570` |

## Cross-feature gaps

(1) No suite was run — X9's pin-coverage claim is from import lists, not a mutation
experiment. (2) X4's "structurally safe today" is reasoned from stage ordering and cascade
comments; migrations 086/088/091/096 were not read. (3) F8's residual `users` risk is
unchanged — two unsampled sites added, ~21 not swept. (4) F6/F7 were searched only for
cross-feature overlap; no independent duplication pass over the design-system or marketing
surfaces. (5) X5 and X8 rest on **absence** evidence — a note phrased without the searched
keywords would be missed.
