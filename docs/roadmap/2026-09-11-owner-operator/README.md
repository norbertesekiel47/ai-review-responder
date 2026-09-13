# Owner Operator, version 1 (spec)

_Status: **RUNS A + B MERGED (#1270 `d8e3f334f` 2026-09-12; #1273 `34857b73b` 2026-09-13); migration 120 on staging and production; `OWNER_OPERATOR_ENABLED` off everywhere** (the turn pipeline, the voice-scope proposal, Apply, Decline, receipts and the Operator screen exist; T8 — Sentry rule 11, the staging flip, p50/p95, §12.1 — is the follow-up PR) · written 2026-09-11 · revised 2026-09-11 after design review (ten findings) and after the ADHD ideation pass (five gap fixes, two additions, two post-checkpoint items); see §15_
_Owner: Norbert (CEO/CTO) · Budget: named 60-hour exception, 30 committed, 30 conditional_
_Companions: [architecture.md](architecture.md) (durable commitments, framework posture) · [vision.md](vision.md) (stages beyond v1)_

This folder is the single home for the operator work. The forward roadmap
links here; the 90-day plan briefs link here. Update this page when a
decision changes, and date the change.

## 0. Decisions locked before writing

| Decision | Choice |
|---|---|
| Transport | Outbox plus polling. No new first-party ingress. |
| Placement | A dedicated Operator screen. Landing screen for new accounts and the demo. Dashboard stays reachable. |
| Apply granularity | One card per operation. No bundled transaction in v1. |
| Model calls | One call per turn. The model calls no tools in v1. |
| Approval | An explicit click on a server-stored proposal. Never free text. |
| Framework | None for v1. See architecture.md §3. |
| Budget | 60-hour ceiling as a named exception to the 20-hour default. 30 hours committed. Remaining 30 conditional on the §12 checkpoint. |
| Customer proof | One real owner from the COO roster, observed under the shared scorecard. Staging proves machinery only. |

## 1. Purpose and hypothesis

Owners still spend effort configuring, coordinating, correcting, and checking
work whose individual steps RepWorth already automates. Version 1 tests one
claim: **an owner can get the right review-reply workflow running, understand
its limits, and adjust it with less effort by talking than by using forms.**

The three-way contract every proposal card carries:

| Label before Apply | Label after success | Meaning |
|---|---|---|
| Proposed rule | Active rule | Behavior the engine enforces. |
| Fact to remember | Remembered fact | Context a named workflow reads. |

A fourth card kind, **Requested capability, no behavior changed**, has no
Apply button (§3.3). The owner never sees "I'll remember that" in place of an
honest answer about whether behavior changed.

## 2. Scope

### In v1

- The Operator screen with a persistent summary panel and three starter actions.
- One model call per turn that returns structured reply segments, zero or more proposals, questions, and unsupported requests.
- The v1 operation catalog (§4): three reads, seven proposable changes, unsupported-request capture, and the server-only Apply and Decline commands.
- Server-stored proposals with a lifecycle, a contract version, idempotent Apply, and deterministic receipts.
- Authorization at every boundary (§7), same-origin on every mutation route.
- Two shared transactional writers: voice fields (extracted from the route) and auto-approval policy (a transaction-aware entry point exported from the existing module).
- Turn recovery after refresh or navigation, including the lost-first-response case.
- Offboarding disposition for the four new tables.
- **Consequence line** on every scope, veto-window, and daily-cap card, computed server-side from the account's real review history (§3.5).
- **Asymmetric friction**: a card that widens autonomy makes the owner retype the scope in words; a card that narrows it is one click (§3.3).
- A defined rule for an owner pasting a review into the chat (§3.4).

### First in line after the checkpoint (funded from the conditional 30 hours, in this order)

1. **Undo from receipts** (§6.6). Every applied receipt offers Restore as a normal proposal through the same Apply path.
2. **Policy-refused card** (§3.6). "RepWorth will not do this", written to the existing Refusal ledger as a new lane.
3. `clear_location_override` as an eighth proposable operation, so an undo of a created override is reachable.

### Out of v1 (each needs its own justification)

Tool loops · free-text approval · MCP · multi-agent orchestration · channel
enrollment changes · solicitation auto-approval · weekday or hour scheduling ·
a new memory table · replacing the dashboard for everyone · Telegram/WhatsApp
conversation · auto-ingesting facts from the website or Google profile ·
named rule bundles ("Holiday rush") · rules with an end date · autonomy that
unlocks after clean Judge verdicts · a fabricated review in the tutorial.
The last four were considered in the ideation pass and rejected for v1:
bundles break one-card-one-operation, end dates need a scheduler, earned
autonomy is the vision's stage, and a fake review pollutes the inventory.

## 3. Owner experience

### 3.1 The screen

Route: `src/app/(authenticated)/dashboard/operator/page.tsx`, URL
`/dashboard/operator`. **Both halves of this line were corrected in Run B
(2026-09-12):** the route was written as a top-level
`src/app/(authenticated)/operator/page.tsx`, and it sits under `dashboard/` so
it rides `src/proxy.ts`'s existing owner-page branch (branch 7, `src/proxy.ts:366-383`
— login redirect, `role === 'owner'`, AAL2) with no change to the proxy; and
the visual system was written as "Island", which is wrong — the screen is
inside the authenticated shell, which already loads `_styles/tokens.css` +
`_styles/console.css` and wraps everything in `.rw-console`
(`src/app/(authenticated)/layout.tsx:32-33`, `:184`), so an Island surface
there would be a second visual system inside one shell. Visual system:
**Console (Harbor)**; see `repworth-brand-design`. Two regions:

- **Conversation** (main). Message list, composer, the current turn state.
- **Summary panel** (side on desktop, top on mobile). Three blocks from
  authoritative reads, each with a timestamp and reporting period: *Waiting
  for you* (from `getPendingApprovalCountsForAccount`), *Recently completed*
  (last five posted replies), *Current operating rules* (from
  `getAutoApprovalSettings` plus the voice config read, per account and per
  location).

Starter actions shown on an empty conversation: **Set up replies**, **Change
my tone**, **Show what needs me**. Each posts a fixed message.

The screen carries the owner's selected location (the existing location
selector). Every turn submission includes it (§5.1). New accounts land here
after the existing onboarding and Google connection complete. The chat does
not perform onboarding. If the connection is missing, the summary panel
shows the existing connect call to action and the agent says so.

### 3.2 A turn

1. The browser generates `conversationId` (uuid) for a new conversation and
   a `clientTurnKey` (uuid) for the message, then posts both with the text
   and the selected `locationId`.
2. The route returns `{ conversationId, turnId }` immediately.
3. The screen shows "Preparing your plan" with both ids in URL state.
4. The worker produces the reply. The screen polls the turn until it is
   `completed` or `failed`.
5. The reply renders as segments (§3.4) plus zero or more cards.
6. A refresh, navigation, or a lost response resumes polling the same turn.
   A resent message with the same `clientTurnKey` returns the same ids.

Latency is measured, not promised. Record p50 and p95 on staging at the
checkpoint. Do not tune the outbox poller for this feature before measuring.

### 3.3 Cards

Two card contracts, both rendered from stored rows, never from prose.

**Proposal card** (`agent_proposals` row): the label (§1), the operation in
plain words, the target (this location, or account default that affects N
locations), exact before and after of the full effective state (§6.1), what
work it affects (§8.4), the consequence line for scope, veto, and cap cards
(§3.5), any required confirmation, and two buttons: **Apply** and **Not
now** (Decline). After Apply the card shows the receipt (§6.5) and its new
label. A `stale` card shows why and a **Refresh plan** action that creates
a new turn from the original instruction.

The target named on the card is rendered from the turn's stored
`location_id` and the proposal's `scope`, never from the browser's current
location selector. If the selector has moved since the turn was accepted,
the card still names the stored location, and a small note says "prepared
for <location>".

**Asymmetric friction.** A card whose Apply would widen autonomy (the
module's exposure classification says `expansion`) has no plain Apply
button. The owner types the scope in words into a field on the card ("4 and
5 star", "5 star only", "all locations") and the server checks the typed
value equals the proposal's `after`. That typed value is the existing
`confirmationLevel` collection. A card that narrows autonomy or changes a
fact applies with one click. Expansion cards render last in the reply and
visually separated. There is no Apply-all.

**Requested-capability card** (`agent_unsupported_requests` row): the
normalized request, the sentence "RepWorth cannot do this yet. Nothing
changed.", and no button. The GET responses return the two kinds under
separate keys (`proposals`, `unsupported`).

### 3.4 Reply segments and status answers

The model does not return free prose. It returns an ordered list of
segments (§5.4): `text`, `status_ref`, `proposal_ref`, `question`. The
server renders `status_ref` segments from the stored snapshot (metric,
value, reporting period, timestamp); the model supplies only the metric
name. A `text` segment that contains a digit adjacent to a metric word
(reviews, replies, drafts, pending, posted, days, hours) or a completion
claim (applied, changed, updated, saved, done, now active) fails validation
(§5.5). Counts therefore always come from reads. "Show what needs me" and
"what happened this week" are answered this way.

**Owner pastes a review.** If the message contains what looks like review
text (a star rating pattern, a reviewer name, or more than 300 characters
of quoted prose), the route stores the message but the worker replaces the
pasted block with the marker `[review text removed]` before building the
snapshot, and the reply carries a fixed server-rendered segment: "I do not
read review text here. Open it in the Reviews list to draft a reply." No
fact is extracted from pasted text in v1. This keeps reviews outside the
model's context on the operator path, where they are untrusted input.

**Location named in the sentence.** The snapshot carries the account's
location list. When the owner's words name a location that differs from the
turn's stored `location_id`, the model emits a `scope_check` segment with
the named location's id and no proposals for that scope. The server renders
a chooser ("Did you mean the cafe? Switch and ask again"). The validator
rejects a turn that carries both a `scope_check` segment and a proposal
targeting the stored location.

### 3.5 Consequence line

Every proposal card for `set_auto_reply_scope`, `set_veto_window`, or
`set_daily_cap` carries one server-computed sentence, for example: "Under
this rule, 19 of your 42 reviews since 12 August would have been eligible
to auto-post. 23 would have waited for you." The daily-cap card adds "Your
busiest day had 6 reviews." The veto-window card adds a fixed phrase, not a
count: "Each auto-post waits 30 minutes for you first."

Mechanics: a pure function `simulateRule(reviews, dials)` in
`src/lib/agents/operator/consequence.ts` walks the account's or location's
reviews in date order over the last 30 days, using the publisher's own
threshold predicate and the publisher's day-bucket expression verbatim, and
returns eligible, held (below threshold or cap reached), and a by-day
histogram. The turn worker computes it from the same scoped read as the
snapshot and stamps it into the proposal. At Apply, the server recomputes
from the locked rows and writes the result into the receipt, so the receipt
can state "old rule: 19 of 42 eligible; new rule: 31 of 42". The model
schema has no field for it; the §3.4 validator already blocks model-emitted
counts. Imported reviews (never auto-eligible) are excluded. The word is
always "eligible", never "would have posted": the live gate also needs
moderation, triage, Judge availability, and an active connection.

### 3.6 Policy-refused card (post-checkpoint)

A third non-proposal card, distinct from "requested capability": "RepWorth
will not do this. Nothing changed." It covers a closed set of reasons:
inventing a business fact, incentivizing reviews, pressuring a reviewer to
edit or delete, replying to a competitor's reviews, exposing customer data,
disparaging a reviewer. The model emits a `refusal_ref` segment with one of
those codes; the server owns the wording and names the Google policy clause
or the RepWorth rule. Each refusal is written through the existing Refusal
ledger writer as a new lane in the fenced-completion transaction and
appears on the Restraint tab. Design note for the builder: split into a
location-scoped content lane and an account-wide policy lane so migration
116's `business_id` constraint is extended, not rewritten. Estimated 8 to
10 hours. Not in the first 30.

## 4. Operation catalog, v1

Module: `src/lib/agents/operator/catalog.ts`. Four kinds, separated by
TypeScript type so a write cannot be registered as immediately executable.
Runtime zod schemas validate model output and incoming requests regardless.

| Operation | Kind | Executes through (v1) | Notes |
|---|---|---|---|
| `read_operating_rules` | read | `getAutoApprovalSettings` (public), voice config read | Feeds context snapshot and summary panel. |
| `read_pending_work` | read | `getPendingApprovalCountsForAccount` + a count per star band | Scoped to account, per location. **Counts and star bands only.** No review text, no response text, no reviewer name ever enters the snapshot. |
| `read_recent_completed` | read | posted responses, last 7 days | Period stated in the answer. |
| `set_tone` | proposable | voice writer (`tone`) | Existing values only. |
| `set_products_services` | proposable | voice writer (`products_services`) | Fact to remember. Read by the prompt builder today. |
| `set_avoid_facts` | proposable | voice writer (`avoid_facts`) | Fact to remember. Read by the prompt builder today. |
| `set_highlight_facts` | proposable | voice writer (`highlight_facts`) | Fact to remember. **The current voice route neither reads nor accepts this column** (`src/app/api/settings/voice/route.ts` schema). v1 extends the shared writer and the route's read/accept schema; if that extension is cut (§13), this operation is deferred with it. |
| `set_auto_reply_scope` | proposable | auto-approval tx writer with `set_account_default` / `set_account_manual` / `set_location_override` / `set_location_manual` | Values: 4–5★, 5★ only, or off. Expansion requires the existing `confirmationLevel`; the card collects it. Readiness blocks only expansions; contractions and dial changes stay allowed (`settings.ts` `assertExpansionReady`). |
| `set_veto_window` | proposable | auto-approval tx writer with `set_account_veto_window` / `set_location_veto_window` | 15 or 30 minutes. |
| `set_daily_cap` | proposable | auto-approval tx writer with `set_account_daily_cap` / `set_location_daily_cap` | 1–50 or platform default. |
| `record_unsupported_request` | capture | `agent_unsupported_requests` rows | Normalized request text, context, account. Frequency alone does not decide the roadmap. |
| `apply_proposal` | command | `applyProposal` (§6.4) | **Not in the model-visible list.** |
| `decline_proposal` | command | `declineProposal` (§6.3) | **Not in the model-visible list.** |

**Effect semantics follow the domain module, not the dial name.** A
dial-only operation on a location that has no override row creates the
override: the threshold starts at manual (a contraction) and the other dial
is seeded from the account default (`settings.ts` `freshRowSeed`). The
proposal's before and after therefore always show the full effective state
of the target scope (threshold, veto window, daily cap, and whether the row
exists), not only the named dial. The card explains a created override in
one sentence.

Each proposable operation declares: input schema, plain-language describer,
target scope rule (account or location), effect-timing statement (§8.4),
contract version (§6.2), and the executor that takes `tx` and the
authorized actor context.

## 5. Turn pipeline

### 5.1 Routes (composition roots, orchestration only)

All POST routes are wrapped in `withSameOrigin()` exactly as the existing
voice and auto-approval routes are. `requireWritableOwner` performs
identity and subscription checks only; it does not validate Origin.

| Route | Does |
|---|---|
| `POST /api/operator/turns` | `withSameOrigin` → `requireWritableOwner`. Body `{ conversationId, clientTurnKey, locationId, text }`, all required. Validate `locationId` belongs to the account and is active. In one transaction: upsert `agent_conversations` (id from the client, `account_id`, `created_by_user_id`), insert `agent_turns` with `actor_user_id`, `location_id`, `sequence` (next in conversation), `status='accepted'`; insert the outbox row for topic `agent_turn` keyed on the turn ID via `enqueueAgentTurn`. Return `{ conversationId, turnId }`. Idempotency: unique `(account_id, client_turn_key)`; a repeat with the same payload returns the existing ids; a repeat with a different payload returns 409. |
| `GET /api/operator/turns/:id` | Owner read scoped by account. Returns status, reply segments (rendered), `proposals`, `unsupported`. |
| `GET /api/operator/conversation?id=` | Owner read scoped by account. Without `id`, returns the actor's most recent conversation for this account. Returns the transcript and the summary-panel reads with timestamps. |
| `POST /api/operator/proposals/:id/apply` | `withSameOrigin` → `requireWritableOwner`. Body `{ expectedVersionToken, confirmationLevel? }`. Calls `applyProposal`. Returns the receipt. Impersonated sessions are rejected exactly as `patchAutoApprovalSettings` rejects them today. |
| `POST /api/operator/proposals/:id/decline` | `withSameOrigin` → `requireWritableOwner`. Calls `declineProposal`. |

Registration: topic constant in `src/lib/shared/worker-types.ts`; queue
name in `src/lib/shared/queue-names.ts`; queue and `topicToQueue` entry in
`worker/queues.ts` (otherwise `OutboxPoller` routes the row to
`failUnknownTopic`); handler registered in `worker/index.ts`; typed helper
`enqueueAgentTurn` in `job-outbox-helpers.ts` (helper-owned topic from day
one, per `ci:outbox-seam`).

### 5.2 Worker job: claim, run, fenced completion

`worker/jobs/agent-turn/AgentTurnWorker.ts`, registered in `worker/index.ts`.

Turn states: `accepted → running → completed | failed`.

1. **Claim.** `UPDATE agent_turns SET status='running', attempt = attempt+1, attempt_token = <uuid>, claimed_at = NOW() WHERE id = $1 AND status IN ('accepted','running') AND (claimed_at IS NULL OR claimed_at < NOW() - lease)` returning the row. No row returned: another attempt holds the lease; exit without work. The lease is 120 seconds, above the model timeout.
2. **Predecessor check.** If the previous `sequence` in the conversation is not `completed` or `failed`, release the claim (`status='accepted'`, `attempt = attempt-1`) and requeue with backoff. This wait does not consume the job's retry budget; a predecessor stuck for more than 10 minutes fails this turn with `predecessor_stalled`.
3. **Authorize again.** Re-resolve `actor_user_id` and `account_id` from the DB: user exists and is not revoked, account subscription writable, account not in an offboarding state that blocks operational UI, `location_id` still active in the account. Any failure: `failed` with reason `unauthorized` or `account_offboarding`, and no context is loaded.
4. **Snapshot** (§5.3), built for the stored `location_id`.
5. **Model call** wrapped in `withCostGuard`, task `owner_operator` in `LLM_TASKS`. Reservation precedes the call. Every attempt is billed; a retry after a billed completion is a second billed attempt and is recorded as such. This is not exactly-once inference.
6. **Validate** (§5.4, §5.5).
7. **Fenced completion.** In one transaction: `UPDATE agent_turns SET status='completed', reply = $segments WHERE id = $1 AND attempt_token = $token` (zero rows: the lease was lost; discard and exit), insert proposals with `status='pending'`, `contract_version`, and `prepared_version_token`; supersede earlier `pending` proposals in the same conversation with the same operation and scope; insert unsupported requests; call `markOutboxCompletedIfOwned` for the outbox row in the same transaction.
8. **Failures.** Transient (provider timeout, `CostInfraUnavailableError`, DB transient): rethrow for BullMQ retry within the job's attempt budget; the lease expires or is released. Terminal (validation failed twice, budget exceeded, unauthorized): `failed` with a user-safe reason, fenced on `attempt_token`, and `markOutboxCompletedIfOwned`. The screen offers "try again", which creates a new turn.

The watchdog in `OutboxPoller` re-dispatches stale `dispatched` rows; the
claim in step 1 is what makes a re-dispatch safe.

### 5.3 Context snapshot

Server-built, bounded, no raw review text, no response text, no reviewer
names. Every read is scoped to the stored `account_id` and `location_id`
and runs after step 3:

- Last N turns of this conversation (N=10; text segments and proposal summaries, with any pasted review block already replaced by the §3.4 marker).
- Pending proposals with labels and states.
- Current operating rules for the account default and the target location, including whether a location override row exists.
- Allowed operations for this account (catalog filtered by tier; readiness attached so expansions can be described as blocked). Each with its describer and value domain.
- Scope: location list with ids and names, the target location, which scopes the actor may write.
- Status snapshot with metric values (counts per star band), reporting period, and timestamp.
- Business facts already stored (tone, products/services, avoid, highlight).
- Consequence inputs for scope, veto, and cap proposals (§3.5) are read here and stamped by the server; the model never sees the per-review rows.

A red-team fixture in the test suite injects instruction-shaped review
bodies into the reviews table for the fixture account and asserts the
rendered snapshot contains none of that text.

### 5.4 Model output schema

```
{
  segments: [
    { type: 'text', text: string } |
    { type: 'status_ref', metric: 'pending_count' | 'posted_7d' | 'drafts_waiting' } |
    { type: 'proposal_ref', index: number } |
    { type: 'question', text: string } |
    { type: 'scope_check', locationId: string }     // owner named a different location
  ],
  proposals: [{
    operation: CatalogOperationId,
    scope: { accountId, locationId? },
    input: <operation input schema>,
    rationale: string
  }],
  unsupported: [{ request: string, context: string }]
}
```

The schema has no fields for approval, confirmation, receipts, or numeric
counts. Those cannot be emitted.

### 5.5 Validation

Shape: zod. Semantic: every proposed operation is in the catalog and
allowed for this account; values are in domain; `scope` matches the turn's
account and either the stored `location_id` or the account default;
`proposal_ref.index` points at a returned proposal; `status_ref.metric` is a
snapshot metric; `scope_check.locationId` is in the snapshot's location list
and differs from the stored `location_id`, and no proposal in the same
output targets the stored location; no `text` segment matches the §3.4
count or completion patterns. A validation failure retries the model call once with the
failure reason appended; a second failure marks the turn `failed` with
`model_output_invalid`. Both test fixtures in §12.2 must fail here.

## 6. Proposals

### 6.1 Stored fields

`agent_proposals`: id, conversation_id, turn_id, account_id, actor_user_id,
location_id (nullable), operation, contract_version, input (jsonb),
before (jsonb, full effective state), after (jsonb, full effective state),
label_kind (`rule` | `fact`), prepared_version_token (jsonb),
requires_confirmation (bool), status, superseded_by, decided_by_user_id,
applied_at, receipt (jsonb), failure_reason, created_at, updated_at.

### 6.2 Two versions, kept apart

- **`contract_version`** is the operation's schema and effect semantics
  version, declared in the catalog and bumped on any change to an
  operation's input shape or effect. Apply rejects a proposal whose
  `contract_version` differs from the deployed catalog's, with reason
  `contract_changed`, before any lock or write.
- **`prepared_version_token`** is settings freshness. It records row
  identity and existence, not only a timestamp:
  - Voice scope: `{ businessId, updatedAt }`.
  - Auto-approval location scope: `{ locationRow: { id | 'absent', updatedAt? }, accountDefaultRow: { id | 'absent', updatedAt? } }`. The parent is included because a created override inherits its dials.
  - Auto-approval account scope: `{ accountDefaultRow: { id | 'absent', updatedAt? } }`.
  A token that records `'absent'` matches only if the row is still absent.

### 6.3 Lifecycle

`pending` → `applied` | `stale` | `rejected` | `failed` | `superseded`

- `stale`: the version token no longer matches at Apply. The card says so and offers Refresh plan.
- `rejected`: the owner declined (`declineProposal`, records `decided_by_user_id`), or Apply-time validation refused it (reason stored).
- `failed`: the mutation errored. Receipt records what is known.
- `superseded`: a later turn replaced it.

### 6.4 Apply protocol

`applyProposal(sql, { proposalId, actor, expectedVersionToken, confirmationLevel? })`
in `src/lib/agents/operator/apply.ts`.

Before the transaction: load the proposal by id and account; reject if the
`contract_version` is not current (`contract_changed`).

Inside `sql.begin`:

1. **Lock in the module's order.** Auto-approval scope: `lockAccount(tx, accountId)` first, exactly as `updatePolicyInTransaction` does, then `SELECT … FOR UPDATE` the proposal. Voice scope: `SELECT … FOR UPDATE` the `businesses` row, then the proposal. Locks are taken before any freshness read so no writer can slip between the check and the write.
2. **Ownership and state.** Proposal belongs to the actor's account; status is `pending`. A repeat Apply on an `applied` proposal returns the stored receipt and executes nothing.
3. **Revalidate** with the lock held: actor still writable, subscription writable, account not offboarding-blocked, tier still allows the operation, readiness for an expansion, and the current version token (computed now from the locked rows) equals both `prepared_version_token` and the client's `expectedVersionToken`. Any miss: `stale` or `rejected` with the reason, no mutation, transaction commits the state change only.
4. **Confirmation.** Auto-approval expansions use the existing `assertConfirmationProvided`; the server checks the `confirmationLevel` the card collected.
5. **Execute** through the operation's executor with `tx`: the voice writer, or `patchAutoApprovalSettingsInTransaction(tx, input)` (§10), which keeps the module's lock, exposure classification, archived-policy rule, readiness, confirmation, and `writeAccountAuditLog` behavior.
6. **Receipt.** Read the committed-to-be state back from the locked rows, write the receipt and `status='applied'` and `decided_by_user_id`. The stored `after` must equal what commits; if it does not (a seeded override differs from the prepared preview), the receipt shows the actual state and flags the difference.

A crash anywhere inside the transaction rolls back both mutation and
receipt. There is no committed mutation without a receipt.

### 6.5 Receipt

Deterministic, server-written: operation, scope, before, after (actual),
effective now (bool), what it affects (§8.4) with the actual count of drafts
that keep their previously granted veto window (read from the locked rows,
not a sentence), the consequence result under old and new dials (§3.5),
what remains blocked (readiness reasons, if any), applied_at, actor, the
verbatim `owner_text` of the turn that produced the proposal, and the turn
id as correlation id. The reply may reference the receipt through a
`proposal_ref`. Only the receipt establishes that something changed.

### 6.6 Undo from receipts (post-checkpoint)

Every `applied` receipt in the transcript offers **Restore**. It calls
`createRestoreProposal`, which maps the receipt's `before` back to a catalog
input through a per-operation `restoreInputFromState`, computes a fresh
version token from the current rows, and inserts a normal `pending`
proposal labeled "Restore: <describer of before>". Apply runs unchanged:
lock, revalidate, exposure classification (a restore that widens autonomy
needs the same typed confirmation), receipt. Undo of an undo falls out. The
"operating rules timeline" is the list of applied proposals in order. A
typed "put it back how it was" maps to a model-visible `restore_last`
operation whose executor is the same function on the most recent applied
receipt for the stated scope; the model never fabricates the restore input.

Known gap: a dial-only change that created a location override has
`before.locationRow = 'absent'`, and no v1 operation deletes an override.
`restoreInputFromState` returns null there and the card says "cannot be
restored automatically: the override did not exist before". Adding
`clear_location_override` (§2) closes it. Estimated 8 hours plus 3 for the
eighth operation. Not in the first 30.

## 7. Authorization at every boundary

Authenticate and authorize each protected request and context read.
Revalidate current permissions, scope, entitlements, and proposal
preconditions inside the transaction that applies the change. Earlier checks
never substitute for that final check.

| Boundary | Check |
|---|---|
| `POST turns` | `withSameOrigin`; `requireWritableOwner`; `locationId` active in the account; conversation belongs to the account. |
| Worker step 3 | Actor and account re-resolved from the DB; revoked or offboarding → `failed`, no snapshot. |
| `GET turns/:id`, `GET conversation` | Owner read scoped by account; proposal and unsupported rows filtered by account. |
| `POST apply`, `POST decline` | `withSameOrigin`; `requireWritableOwner`; impersonation rejected; §6.4 step 3 inside the transaction. |

Shared helpers keep the checks identical across boundaries. Every query is
scoped by `account_id`; `ci:tenant-scope` and `ci:rls-audit` run on this
change. The new tables get RLS policies matching `job_outbox` (migration 119
is the pattern).

## 8. Product rules (acceptance criteria, not engineer inference)

### 8.1 Which business changes

Every proposal stores account and, where applicable, location. The card
distinguishes "this location" from "account default, affects N locations".
Switching the selected location never retargets an existing proposal or a
turn already accepted.

### 8.2 Two messages

Turns process in order within a conversation. A resent message with the
same `clientTurnKey` returns the existing ids, including when the first
response was lost. A later correction that targets the same operation and
scope supersedes the earlier pending proposal; the earlier card shows
"replaced by a newer plan".

### 8.3 After one Apply

Sibling cards whose version token no longer matches become `stale`. The
interface says why and offers Refresh plan. Approved intent is never
rewritten silently.

### 8.4 When a change takes effect

| Operation | Affects |
|---|---|
| Tone, facts | Future drafts only. Existing drafts and pending approvals are not rewritten. The card states this. |
| Auto-reply scope, veto window, daily cap | Future eligible reviews. A draft already granted a veto window keeps it: the granted window is stored on the approval audit row and is immutable (`worker/jobs/publisher/veto-window-gate.ts`). The card states this, and the receipt states the actual number of such drafts at Apply time, read from the locked rows. |

## 9. Data model

Migration `120_owner_operator.sql` (follow `new-migration`):

- `agent_conversations` (id from client, account_id, created_by_user_id, created_at, last_turn_at).
- `agent_turns` (id, conversation_id, account_id, actor_user_id, location_id, client_turn_key, sequence, owner_text, reply (jsonb segments), status, attempt, attempt_token, claimed_at, failure_reason, created_at, completed_at; unique on (account_id, client_turn_key); unique on (conversation_id, sequence)).
- `agent_proposals` (§6.1).
- `agent_unsupported_requests` (id, account_id, turn_id, request, context, created_at).
- RLS: deny-all to anon and authenticated; service role only, same as `job_outbox`.
- Indexes: turns by (conversation_id, sequence); proposals by (conversation_id, status).

**Offboarding disposition.** All four tables are `hard_delete` with
`scopeEvidence: 'direct_account_id'` in
`src/lib/account-offboarding/table-disposition.ts`, because the parents
(`accounts`, `businesses`, `users`) are retained deidentified and cascades
cannot be relied on. The delete-data purge deletes them by `account_id`;
`purge-verification` asserts zero rows; the tenant inventory lists them.
An `agent_turn` job for an account that entered offboarding fails at worker
step 3 with `account_offboarding` and does not build a snapshot. The
existing disposition test that checks every account-linked table must pass
with the four new entries.

Audit: auto-approval changes through Apply write `account_audit_log` via
`writeAccountAuditLog` inside the module's writer, as the form path does
today. The run spine is not used for conversations or Apply in v1.

## 10. Files

New (each gets its `docs/directory/` row in the same PR, `ci:directory-map`):

| File | Role |
|---|---|
| `src/lib/agents/operator/catalog.ts` | Operation kinds, registry, describers, contract versions, executors. |
| `src/lib/agents/operator/schema.ts` | Model output zod schema; segment, proposal, receipt, version-token types. |
| `src/lib/agents/operator/context.ts` | Context snapshot builder (reads only). |
| `src/lib/agents/operator/render.ts` | Deterministic segment renderer, the §3.4 text validator, the pasted-review scrubber, and the `scope_check` chooser. |
| `src/lib/agents/operator/consequence.ts` | Pure `simulateRule(reviews, dials)` (§3.5); reuses the publisher's threshold predicate and day-bucket expression. |
| `src/lib/agents/operator/proposals.ts` | Proposal persistence, supersession, lifecycle, `declineProposal`. |
| `src/lib/agents/operator/apply.ts` | `applyProposal` (§6.4), version-token computation. |
| `src/lib/agents/operator/prompt.ts` | System prompt and snapshot rendering; version hash recorded on `api_costs`. |
| `src/lib/responses/voice-settings.ts` | Shared transactional writer for voice fields incl. `highlight_facts`, with row lock; the route calls it. |
| `worker/jobs/agent-turn/AgentTurnWorker.ts` | §5.2. |
| `src/app/api/operator/**/route.ts` | §5.1. |
| `src/app/(authenticated)/operator/**` | §3.1. |
| `supabase/migrations/120_owner_operator.sql` | §9. |

Changed:

- `src/lib/auto-approval/settings.ts`: export `patchAutoApprovalSettingsInTransaction(tx, input)` (the current private `updatePolicyInTransaction` plus the settings reload), keep `patchAutoApprovalSettings` as the thin `sql.begin` wrapper the route uses. Same locks, classification, confirmation, readiness, impersonation rejection, audit.
- `src/app/api/settings/voice/route.ts`: use the shared writer; accept and return `highlightFacts`.
- `src/lib/llm/tasks.ts` (+ `owner_operator`), `src/lib/llm/types.ts` (`LLMTaskId` union), `model-pinning.test.ts`.
- `src/lib/shared/worker-types.ts` (+ topic), `src/lib/shared/queue-names.ts` (+ queue), `worker/queues.ts` (+ queue and `topicToQueue` entry), `src/lib/shared/job-outbox-helpers.ts` (+ helper), `worker/index.ts` (register).
- `src/lib/account-offboarding/table-disposition.ts` (+ four entries) and its purge verification.

## 11. Invariants checklist

- #1 LLM call runs in the worker. Routes only orchestrate.
- #2 Turn insert and outbox row in one transaction, via the typed helper; outbox completion fenced with the turn's terminal transition.
- #3 Nothing posts. Auto-approval scope changes go through the existing gates.
- #13/#14 No new `NEXT_PUBLIC_*`; policy reads and writes stay server-owned. `OWNER_OPERATOR_ENABLED` is server-only, default off, read through `readFlag` by `ownerOperatorEnabled()` alone — the browser learns the state from the 404, and BOTH lanes read it (set it in Vercel AND Railway).
- #15 Every new module takes `sql`/`tx` explicitly. Only routes, the worker, and `worker/index.ts` import the singleton.
- Cost guard wraps the model call. Reservation precedes the call. Every attempt is accounted.
- Structured logging; no owner text in logs.
- Model IDs pinned in `LLM_TASKS`; `model-pinning.test.ts` extended.
- Account-status audit through `writeAccountAuditLog` only.

## 12. Acceptance

### 12.1 Checkpoint at 30 hours (staging)

All required to release the second 30 hours:

1. A signed-in owner sends a message, receives a stored proposal for a tone change, applies it, and sees an accurate receipt.
2. The next generated draft for that location reflects the new tone (observable through the existing pipeline).
3. Refresh during "Preparing your plan" resumes the same turn. A repeated Apply returns the original receipt. A resent message returns the same ids, including when the first response was lost.
4. A concurrent form write between proposal and Apply marks the proposal `stale`. A proposal from another account is rejected. A proposal whose `contract_version` is bumped is rejected with `contract_changed`.
5. Two simultaneous dispatches of the same turn produce one completed turn and one proposal set (claim test).
6. A turn submitted with a secondary location builds its snapshot for that location, and changing the browser selection before the worker runs does not change the target.
7. Missing or mismatched Origin is rejected on both POST routes before any enqueue or write.
8. The auto-approval Apply path is examined enough to estimate the remaining work, including the transaction-aware entry point, confirmation, readiness, and the created-override case; the estimate is written in this page.
9. One owner from the COO roster is named, with an observation window and enough eligible review activity to test delegation.
10. p50 and p95 turn latency recorded.

Missed checkpoint: pause expansion and re-scope. Do not spend the second 30
hours finishing the first slice by default.

### 12.2 Full v1

- Every §4 proposable operation applies with full-state before/after and receipt, including a dial-only operation that creates a location override (receipt shows the created row and the manual threshold).
- Consequence line: on a fixture account with 10 reviews, the scope card's eligible/held counts equal a hand count; imported reviews are excluded; the receipt carries old-rule and new-rule counts.
- Asymmetric friction: an expansion card has no plain Apply; a typed scope that does not equal the proposal's `after` is rejected; a contraction card applies in one click.
- Pasted review: a message containing a quoted review produces the scrubbed marker in the snapshot and the fixed reply segment; the red-team fixture asserts no injected review body reaches the prompt.
- Location named in the sentence: "turn off auto-reply for the cafe" while the salon is selected yields a `scope_check` chooser and no proposal; the card target always names the stored location even after the selector moves.
- Veto-window receipt shows the actual count of drafts keeping their old window, matching the rows in the approval audit table.
- Concurrency tests: form write versus Apply; two proposals on the same scope; first policy-row creation; changed account default under an inheriting location.
- §8 rules pass as tests. Decline records the actor.
- "Stop replying on weekends" yields a requested-capability card with no Apply and a stored unsupported request.
- Two validator fixtures fail the turn: an output that invents a count in text, and an output that claims a change was applied before any click.
- Summary panel counts match the dashboard's authoritative counts.
- Offboarding: delete-data purge removes all four tables' rows; purge verification passes; an in-flight turn for an offboarding account fails at step 3.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, plus `ci:tenant-scope`, `ci:rls-audit`, `ci:outbox-seam`, `ci:outbox-status`, `ci:directory-map` green.
- Browser evidence at 390px and 1440px, including the error paths (failed turn, stale card, rejected Apply) with backend assertions on the stored state.

### 12.3 Owner pilot (the customer proof)

Recorded in the COO customer record under the shared scorecard:

- The owner sets up one job by conversation; setup effort measured separately.
- Real eligible work completes under those settings.
- The owner changes one instruction; the next comparable work follows it.
- Measured: owner effort, founder intervention, failures, corrections, and the owner's stated wish to continue and pay.
- Insufficient review volume is recorded as an evidence limit, not as failure.

## 13. Budget and cuts

Provisional estimate for full v1: 70–85 hours after the review's additions
(transaction-aware policy writer, claim protocol, version tokens,
offboarding disposition, segment renderer) and the ideation additions
(consequence line about 8, asymmetric friction about 2, pasted-review
scrubber and `scope_check` about 3). Ceiling 60 for the first pass. The
budget therefore already assumes cuts.

| Item | Hours (provisional) | Status |
|---|---|---|
| First 30: voice slice, claim protocol, same-origin, version tokens, receipts | 30 | committed |
| Auto-approval cards with transaction-aware writer and confirmation | 12 | conditional |
| Consequence line | 8 | conditional, keep |
| Asymmetric friction | 2 | conditional, keep |
| Pasted-review scrubber, `scope_check`, veto-window count in receipt | 3 | conditional, keep |
| Summary panel, starter actions, highlight/avoid facts | 5 | first cuts |
| Undo from receipts + `clear_location_override` | 11 | after v1 ships, first in line |
| Policy-refused card and ledger lane | 8–10 | after v1 ships, second in line |

Cut order if the ceiling binds: summary-panel polish → starter actions →
`set_highlight_facts` (and its route extension) → `set_avoid_facts` →
daily cap card → veto window card. Never cut: reliable Apply with locking,
truthful receipts, authorization and same-origin at every boundary, the
claim protocol, offboarding disposition, no review text in the snapshot,
observable effect on the next draft, the consequence line on the scope
card.

MCP is not scheduled after v1. It needs a named external user and its own
scope.

## 14. Open questions

- Which pinned model for `owner_operator`: the reply-generation primary, or a stronger model for planning quality. Decide at the checkpoint from staging transcripts. **2026-09-11 (Run A):** registered at the reply-generation pair (`OPENAI_MODEL` primary, `ANTHROPIC_MODEL` fallback) with `maxTokens: 1200` and `temperature: 0.2` — 1200 because a reply is an ordered segment list plus up to five proposals with rationales, and 0.2 because a proposal is a contract, not prose. **This run pins the numbers only; the MODEL question stays open at the checkpoint.**
- Whether the summary panel reads should be one aggregated route or reuse the dashboard payload. **2026-09-12 (Run B): the "reuse" default is REFUTED and the question is closed.** The architecture pass (H1-D) measured the dashboard payload field by field: the rating band buckets ALL rated reviews where the Operator wants pending drafts by star (`readStarBands` is the right reader); the posted count is ABSENT (`totalReviewsHandled` is all-time, `recentReviewCount` a capped *received* sample — `readPosted7d` is the right reader); and the per-location DTO carries no location list. Importing the assembled DTOs would also drag in a 45-second Redis TTL cache plus ranking, velocity and briefs, and two of four fields would still be wrong. Run A's granular helpers — `getPendingApprovalCountsForAccount`, `readPosted7d`, `getAutoApprovalSettings`, `readVoiceConfig`, already wired into `getConversationForOwner` — are the source, and `SummaryPanel.tsx` is a pure renderer over them.
- Lease length, predecessor-stall limit and wait delay are provisional (plan decision L2, landed in `worker/jobs/agent-turn/constants.ts`); tune from staging p50/p95 at the checkpoint, not from a hunch. **Lease 180 s** — each provider call is bounded at 30 s and `runLlmTask` may attempt primary then fallback, so two providers × two validation attempts fit with headroom; above the model timeout by construction, which is what makes a stale claim mean "crashed", not "slow". **Predecessor stall 1200 s (20 min)** — above one outbox watchdog window (900 000 ms default), so a predecessor that merely needs re-dispatching gets rescued before this turn gives up on it. **Wait delay 10 s** between predecessor re-checks.
- **Operator speaks first.** An empty conversation could open with a server-rendered line from the summary reads ("You have 3 reviews waiting, 2 under 3 stars. Last week 9 replies posted. Keep handling 4 and 5 stars the same way?"), so the owner's first act is a yes or a correction. Zero model cost. Decide at the checkpoint from the pilot owner's first session.
- **Receipt retention after purge.** §9 hard-deletes receipts with the account. A regulator view argues settings-change receipts should survive under a separate retention clock. Decide with counsel before the pilot; default stays hard-delete.
- **7-day truth check.** A scheduled job could compare a receipt's predicted eligibility to the actual auto-post rate and record the gap. Cheap and honest; not in v1 unless the consequence line proves misleading on staging.
- **Run B open item — a turn stranded by outbox dispatch exhaustion** (review round 1, CA1). Five `OutboxPoller` dispatch failures terminalize the `job_outbox` row while the turn is still `accepted`: successors in the conversation fail `predecessor_stalled` after 20 min, but that turn itself never reaches a terminal status, so the screen polls something that will never answer. The reverse case is already closed — a stale attempt's still-`dispatched` row is completed by the next dispatch's terminal-turn branch (`readTerminalTurn` → `markOutboxCompletedIfOwned`), proven live by the claim-race case's third dispatch. The fix belongs in `OutboxPoller` (a turn-aware exhaustion hook, or a sweeper that fails `accepted` turns whose outbox row is terminal), which is outside Run A's surface. Run B's screen must at minimum show a timeout and offer "try again" rather than spinning.
- **Run B open item — the predecessor wait outlives the watchdog window** (review round 1, CA4). Two clocks disagree by design: `AGENT_TURN_PREDECESSOR_STALL_SECONDS` is 1200 s (20 min) while the outbox watchdog re-dispatches after 900 000 ms (15 min), so a turn waiting on a slow predecessor can be dispatched a second time mid-wait. Accepted as a tradeoff for Run A — a redundant dispatch is safe by construction (the **Turn claim** serialises; the loser exits without touching the outbox row) and at the default watchdog it happens at most once per wait. Removing it needs either a durable waiting state or sequence-aware dispatch, both of which change `OutboxPoller`. Revisit with the checkpoint's staging p50/p95, alongside the lease and stall numbers above.
- **Go-live alerting — the `agent_turn` lane's domain terminals emit structured logs only; its failure rows are watched** (review round 2, R9; corrected by the fresh red-team rounds 1 and 3, P1-4/P1-5/P2-2). `TURN_FAILURE_REASON` has seven members. Six are DOMAIN terminals the worker itself writes through a fenced status update, and they do not log uniformly: `predecessor_stalled`, `unauthorized` (the reauthorization arm and the vanished-voice-row arm), `account_offboarding` (the other outcome of that same reauthorization arm), `model_output_invalid` and `budget_exceeded` emit a `logger.warn` line; `operator_disabled` emits `logger.log` (info — an orderly flag-off skip, not an incident). The seventh, `exhausted`, is written by the failed-hook after BullMQ retry exhaustion, not by the worker. One more exit is NOT a terminal: a lease lost before completion emits `logger.warn` and resolves nothing — the attempt that owns the lease completes the turn and the outbox row. None of the six domain terminals calls Sentry, and that is ONE go-live decision — whether they get a Sentry rule row, and at what rate, given that `operator_disabled` is a flag-off skip and `budget_exceeded` is a per-account terminal — to be taken with the rest of Run A's alerting before the pilot, not path by path. What IS alerted today, after the fresh red-team round: (a) a `job_outbox` row for topic `agent_turn` that lands `failed` — by `OutboxPoller` dispatch exhaustion or by the watchdog terminalising a long-`dispatched` row — raises `outbox_failed:agent_turn` from `checkFailedOutboxByTopic` (the topic was missing from that closed allowlist; P1-2) and pages through runbook rule 1; (b) BullMQ retry exhaustion reaches Sentry through `worker/job-failure-sink.ts` tagged `subsystem:worker_job`, `queue:agent_turn`, with its own rule row in `docs/runbooks/beta-launch-alerting.md` (P1-3). The orphaned-lease case named in the intake's observability section is therefore alerted only on its TERMINAL half: a stuck `dispatched` row the watchdog re-pends produces one count-only log line in `runOutboxWatchdogRecovery` (`Watchdog recovered stale entries` with `recovered`, `failed` and `stale_dispatching` counts — no topic field, no Sentry event), and it stays that way by design — the re-dispatch is the recovery.
- **Go-live alerting for the six DOMAIN terminal reasons — settled 2026-09-12 (Run B, decision D6): structured logs only, no Sentry rule.** `operator_disabled` is an orderly flag-off skip and `budget_exceeded` is a per-account terminal; neither is an incident, and a rule that pages on both would train the operator to ignore the lane. The two paths that ARE alerted stay alerted: a `job_outbox` row for topic `agent_turn` landing `failed` raises `outbox_failed:agent_turn` through runbook rule 1, and BullMQ retry exhaustion reaches Sentry through `worker/job-failure-sink.ts` under runbook **rule 11** — BUILT 2026-09-13 in both Sentry projects (staging `3984512`, production `3984518`; `docs/runbooks/beta-launch-alerting.md` row 11), through the Sentry UI after the API had refused the build for want of an `alerts:write` token; the T8 staging flip gated on it. The distribution is read from the rows instead, on staging with the flag on: `SELECT failure_reason, count(*) FROM agent_turns WHERE created_at > now() - interval '7 days' GROUP BY 1`. **Revisit trigger: the §12.1 checkpoint.** If any domain reason is materially represented there, it earns its own rule then — with a real rate to set the threshold from, which is the thing this decision was missing.

## 15. Review log

- 2026-09-11, ADHD ideation pass (five frames, 30 ideas, three deepened; owner approved the recommendation): gap fixes folded in (no review or response text in the snapshot with a red-team fixture; `scope_check` when the sentence names another location; card target from the stored location; actual veto-window draft count in the receipt; pasted-review rule). Added to v1: consequence line (§3.5), asymmetric friction (§3.3). Added after the checkpoint, in order: undo from receipts (§6.6) with `clear_location_override`, policy-refused card (§3.6). Rejected for v1: rule bundles, end-dated rules, earned-autonomy unlocks, a fabricated tutorial review. Budget table added to §13; three open questions added to §14.
- 2026-09-11, design review (ten findings, all accepted): transaction-aware auto-approval writer; lock-before-check freshness with row-identity version tokens; actor and location persisted on the turn; client-generated conversation id and account-scoped turn key; claim and fenced completion with outbox ownership; same-origin on mutation routes; hard-delete offboarding disposition; contract version separate from freshness; structured reply segments with a validator; roadmap selection statements corrected. Smaller corrections: public `getAutoApprovalSettings`; `highlight_facts` route extension; seven proposable operations; audit via `writeAccountAuditLog`; requested-capability card contract and Decline endpoint; `pnpm build` in the gate.
- 2026-09-11, **Run A built** (`feat/owner-operator-run-a`): migration 120's four
  tables with deny-all RLS and the hard-delete offboarding disposition; the
  `agent_turn` outbox topic, queue and typed helper (plain INSERT — `job_outbox`
  has no generic in-flight index, 004/018 are per-topic); the shared voice
  writer with `highlight_facts` and the route extension; the catalog's three
  reads, four voice proposables and one capture; the model-output schema,
  validator and **Pasted-review scrub**; the `owner_operator` LLM task; the
  claim / predecessor / fenced-completion protocol and `AgentTurnWorker`; the
  POST turn route and the two owner reads; `OWNER_OPERATOR_ENABLED` with the
  ADR 0005 flag-on envelope at 12. NOT built, deliberately: the screen, Apply,
  Decline, receipts, the consequence line, asymmetric friction, the three
  auto-approval operations, and any executor — `requires_confirmation` is
  therefore always false in Run A because no registered operation widens
  autonomy. The plan was hardened over **three Codex rounds** (round 3 APPROVED
  with one untriaged note, carried into T5) and took **two surface amendments**:
  #1 put the pre-existing `src/app/api/settings/voice/__tests__/route.test.ts`
  into T2's lease, because extracting the writer moved the behaviour 8 of its
  cases pinned; #2 created `docs/directory/lib-owner-operator.md`, because both
  default `src/lib` directory pages were at the 3,000-word cap. Every deviation
  is in `docs/superpowers/plans/feat-owner-operator-run-a-deviations.md`.
- 2026-09-12, **Run B built** (`feat/owner-operator-run-b`): the **Version token**
  module and its single JSONB parse site; `applyProposal` — contract check before
  any lock, then one transaction that locks `businesses` then the proposal,
  revalidates actor / subscription / tier / ownership under those locks, compares
  the three tokens text to text, writes only the operation's own fields through
  the shared voice writer, reads the state back, writes the server-owned
  **Receipt**, and marks sibling pending Proposals on the location stale;
  `declineProposal` (actor only, idempotent); the two POST routes and their
  result-kind map; `?locationId=` and `connectionStatus` on the conversation
  read — an owner with no conversation yet receives the empty view with a
  summary scoped to that location, rather than a 404; ONE
  `hasImpersonationCookie`; `/api/operator` on the owner-API AAL2
  allowlist; and the Operator screen — Console (Harbor), URL-state polling with
  back-off and a 4-minute ceiling, per-reason failure wording, the All-locations
  chooser, the Proposal card with its Receipt and **Refresh plan**, the
  Requested-capability card, and the summary panel. The screen sits at
  `/dashboard/operator` (owner decision 2026-09-12) so it rides the existing
  owner-page proxy branch rather than needing a new one. NOT built, deliberately: the
  three auto-approval proposables, `patchAutoApprovalSettingsInTransaction`, the
  consequence line, asymmetric friction, undo from Receipts, and any production
  flag flip. §3.1's visual system was corrected from Island to Console; §14's
  dashboard-reuse default was refuted; the domain-terminal alerting question was
  closed as logs-only; rule 11 stays NOT BUILT until a scoped Sentry token
  exists (the red team's round-1 P0 caught the draft that said otherwise), and
  the staging flip gates on it. T8 (the staging
  flip, p50/p95, the constants tune and the §12.1 checkpoint report) is a
  follow-up PR — see `docs/superpowers/plans/feat-owner-operator-run-b-plan.md`.
  Two plan decisions were reversed by the owner before execution and are
  recorded in `docs/superpowers/plans/feat-owner-operator-run-b-deviations.md`:
  the page route (top-level → under `dashboard/`) and the nav-section test's
  home (a new file → the existing `active-nav.test.ts`).
- 2026-09-13, **Run B MERGED** (#1273, squash `34857b73b`) after a flag-off staging
  ride proved build and boot. Before the merge a fresh three-round red-team run
  covered the two post-review CI fixes (`fallow`, React Doctor) and closed CLEAR
  at `e11aeceda`: its P0 was the **Receipt**'s `before` being unmeasured (the only
  assertion was an absence-of-key proxy); three P1 oracle gaps (the gate order on
  a malformed id, the card repaint from the returned row, a late read across
  `finishTurn`) each earned a discriminating case. Open for T8: red-team RT-B8
  (the refetch on a second message in an adopted conversation is unmeasured),
  Sentry rule 11 (NOT BUILT), the staging flip, p50/p95, the constants tune,
  §12.1.
