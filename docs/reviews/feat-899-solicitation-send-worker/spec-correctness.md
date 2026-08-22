# Spec & correctness review — `feat-899-solicitation-send-worker`

Reviewer: spec & correctness (read-only). Fork point `9e60617c`. Contract read first:
`.feature/intake.json` (verified byte-identical to the branch copy at
`docs/superpowers/plans/feat-899-solicitation-send-worker-intake.json` for every field
checked below). Triage read second:
`docs/superpowers/plans/feat-899-solicitation-send-worker-deviations.md` (D0–D11).
Blast radius read third: `docs/reviews/feat-899-solicitation-send-worker/blast-radius.md`.

No tests, builds or linters were run.

---

## 0. Findings table (≥80% confidence only)

| Severity | file:line | Finding |
|---|---|---|
| Medium | `worker/jobs/solicitation-send/failed-hook.ts:173` | The exhaustion CAS admits `'sending'`, so on the final BullMQ attempt a row whose provider send SUCCEEDED but whose tx2 threw is written `failed`/`send_exhausted` with `provider_message_id` NULL and no `solicitation_sent` outcome — a delivered email recorded as failed. |
| Medium | `src/lib/solicitation/dispatch.ts:1301-1317, 1452-1457` | tx1's locked status triage branches only on `cancelled` and `sending`; any other non-`queued` status falls through into the full gate, and the `cas_lost` refusal **returns normally**, so tx1 COMMITS a burned unsubscribe-token row + an orphan `running` child run. |
| Medium | `src/lib/solicitation/dispatch.ts:1333-1344, 1537-1545` | Intake `edge_cases[1]` requires a flag-off defer to "record a spine step"; neither defer path records one (no child run is created at all), so a deferred dispatch attempt leaves no `agent_run_steps` evidence. Not triaged in D0–D11. |
| Low | `docs/directory.md:931` | The `dispatch.ts` row still ends "Today it implements the flag-off defer only; Tasks 2–7 fill in the evidence, the token mint, the provider call and the terminal transaction" — stale for the shipped file. |
| Low | `src/lib/solicitation/__tests__/send-retry.test.ts:124` | The "exactly one" half of the `tests_to_add` title `property: every provider error maps to exactly one retry class` is asserted tautologically; what the test actually proves is totality + determinism. |

---

## 1. Does the diff faithfully implement the intake?

### 1.1 `goal`

> Build the per-child Solicitation send worker: the Dispatch gate, the unsubscribe token mint,
> the Messaging adapter call, and the terminal transaction that CASes the Outreach row,
> terminalizes the Lazy child, emits `solicitation_sent`, completes the outbox row and calls
> `closeBatchIfSettled`.

**PASS.** Every clause is present and located where the goal puts it:

| Clause | Where |
|---|---|
| Dispatch gate | `applyDispatchGate` (`dispatch.ts:202-222`), evidence gathered by `gatherSlowGateEvidence` (`:466`) + `gatherFastGateEvidence` (`:594`) |
| Unsubscribe token mint | `mintUnsubscribeToken` (`dispatch.ts:751-773`) |
| Messaging adapter call | `sendWithBoundedRetry` → `getMessagingAdapter().send` (`dispatch.ts:954`) |
| Terminal transaction | `commitSendTerminal` (`dispatch.ts:1020-1101`): CAS `:1032`, child terminal `:1086-1093`, `solicitation_sent` `:1071-1078`, `markOutboxCompletedIfOwned` `:1095`, `closeBatchIfSettled` `:1096` — all in the caller's single `sql.begin` (`:1627`) |

### 1.2 `user_visible_behavior` — 8 entries

| # | Behaviour | Verdict | Evidence |
|---|---|---|---|
| 1 | Released row dispatched through `getMessagingAdapter()` and reaches a real recipient | PASS | `dispatch.ts:954`; the seam is imported at `:91` and no Resend client or `EmailAdapter` is named anywhere in the branch |
| 2 | Message carries a working per-ask one-click unsubscribe URL whose raw token exists only in memory and in the message | PASS | `buildUnsubscribeUrl` `:719-727` (fails closed on unset `NEXT_PUBLIC_APP_URL`), token minted by the shared `mintUnsubscribeRawToken` so the ingress admission gate accepts it; substituted in `assembleOutboundMessage` `:844-888`; proven by `dispatch.integration.test.ts:1359` |
| 3 | Suppressed recipient never contacted; row → `withheld`/`suppressed`; `solicitation_suppressed_at_dispatch` emitted | PASS | gate `:208`, `commitWithhold` `:1161-1208`; event key/props are the registered contract (`docs/analytics/events.md`), per D9 |
| 4 | No attested postal address, or footer no longer byte-matches ⇒ never contacted; `no_postal_address` / `postal_address_mismatch` | PASS | `:215-218`, `storedBodyCarriesPostalAddress` `:377-380`. Both reasons exist in the DB vocabulary (migration 110, added by #898) |
| 5 | Stored bytes failing current `ASK_LINT_VERSION` or re-moderation ⇒ never sent; `lint_failed` / `moderation_high` | PASS | `:219-220`; evidence from `gatherSlowGateEvidence` `:480-489` over the STORED snapshot |
| 6 | Flag off stops further sends immediately; in-flight `queued` rows left queued | PASS | pre-tx short-circuit `:1537-1545` and gate slot 2 `:207`; no domain write on either |
| 7 | Hard bounce ⇒ `failed`/`send_failed` with `bounced_at`, zero retries | PASS | `classifySendFailure` returns `terminal_bounce` → `sendWithBoundedRetry:958` returns on attempt 1; `commitSendTerminal:1030,1038` stamps `bounced_at` for that class only |
| 8 | Batch closes on its own once the last row terminalizes, because every terminal writer calls `closeBatchIfSettled` in its own transaction | PASS | three writers do: `commitWithhold:1212`, `commitSendTerminal:1096`, `failed-hook.ts:201` |

### 1.3 `invariants` — 13 entries

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 1 | #2 transactional outbox — terminal tx completes its own outbox row in the SAME tx; if it does not commit the watchdog still owns the work | **PASS** | `markOutboxCompletedIfOwned` is inside `commitSendTerminal` (`:1095`), inside `commitWithhold` (`:1211`), and inside tx1 for every no-op/defer arm (`:1297, :1305, :1315, :1338, :1405, :1456`). tx2 is one `sql.begin` (`:1627`) and a throw inside it commits nothing — proven by `dispatch.integration.test.ts:1471`, which aborts tx2 with a real Postgres error and asserts all five facts absent and the outbox row still `dispatched` |
| 2 | #5 raw token never in Postgres | **PASS** | only `hashUnsubscribeToken(rawToken)` is bound (`:757, :764`). No outbox payload is written by this lane. Logging uses `unsubscribeTokenLogPrefix` = `logPrefix(sha256(raw))`, verified in `unsubscribe.ts`. Two independent tests with negative controls: `dispatch.test.ts:465` (log scan) and `dispatch.integration.test.ts:1359` (every column of both tables) |
| 3 | #10 node:crypto + UUIDv7 | PASS | `randomInt` from `node:crypto` (`:74`); `uuidv7` from the repo-standard `uuid` (`:76`); the hash/nonce come from `unsubscribe.ts`, which uses `node:crypto` throughout. No `crypto-js` anywhere |
| 4 | #12 entry points orchestrate; retry classification in its own named module with focused tests | PASS | `worker/jobs/solicitation-send.ts` is 41 lines, one domain call. `src/lib/solicitation/send-retry.ts` is pure/total with `send-retry.test.ts` |
| 5 | #15 explicit DB client | PASS | `dispatch.ts` takes `sql: Sql` / `tx: TransactionSql`; no `@/lib/db/server` import in any file on the branch |
| 6 | Never hold a Postgres lock across a slow remote call | **PASS** | `gatherSlowGateEvidence` is awaited at `:1557`, `sql.begin` opens at `:1559`; the provider send is at `:1621`, between two committed transactions. `dispatch.test.ts:421` asserts the moderation round trip **resolved** before tx1's first statement, not merely was called first |
| 7 | Every provider call carries the outreach row id as its idempotency key | PASS | `EmailAdapter` derives it from `message.outreachId` (`src/lib/messaging/email-adapter.ts:58`); `sendWithBoundedRetry` hands the SAME object to every attempt (`:952-967`), asserted by identity (`toBe`) in `dispatch.test.ts:512` |
| 8 | `provider_message_id` persisted on every successful send | PASS *with one hole* — see Finding 1 | `commitSendTerminal:1037`; `dispatch.integration.test.ts:1441` uses two different ids so a constant cannot pass |
| 9 | `solicitation_sent` on the Lazy child with `unit_count = 1`, never on the parent | **PASS** | `recordOutcome(tx, { runId: input.childRunId, … unitCount: 1 })` (`:1071-1078`). `dispatch.integration.test.ts:1514` asserts both halves — present on the child, absent on the parent |
| 10 | `closeBatchIfSettled` has one owner and is called in the same transaction as every terminalization | PASS | one implementation in `outreach.ts`; three in-transaction call sites listed above |
| 11 | Byte-for-byte Owner approval over STORED bytes; the two placeholder swaps excluded; postal address part of the byte-match | PASS | `assembleOutboundMessage:845-847` is two `replaceAll`s over `input.storedBody` — no re-render, reflow or trim. `dispatch.test.ts:580` proves it by substituting BACK and asserting byte-equality with the stored body |
| 12 | The gate is per-CHILD and per-CONTACT; no account-level fact evaluated here | PASS | no subscription, cap or breaker read exists in `dispatch.ts`; the seven items are exactly B6's seven |
| 13 | `moderation_status` / `moderation_detail` stay render provenance | PASS | neither column appears in any statement in `dispatch.ts` or the failed hook (grep: one comment hit only) |

---

## 2. Drift outside `allowed_edit_surface` — 23 globs

**NONE.** All 30 changed paths map to a glob:

`CONTEXT.md` · `docs/directory.md` · `docs/reviews/**` (3) · `docs/superpowers/plans/**` (4) ·
`docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` ·
`src/lib/agents/run-spine.ts` · `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` ·
`src/lib/shared/queue-names.ts` · `src/lib/shared/worker-types.ts` ·
`src/lib/solicitation/__tests__/**` (5) · `src/lib/solicitation/ask-compliance-lint.ts` ·
`src/lib/solicitation/ask-generation.ts` · `src/lib/solicitation/dispatch.ts` ·
`src/lib/solicitation/send-retry.ts` · `worker/index.ts` · `worker/jobs/__tests__/**` (2) ·
`worker/jobs/solicitation-send.ts` · `worker/jobs/solicitation-send/**` · `worker/queues.ts`.

The two amendments D2 and D10 account for `ask-compliance-lint.ts` / `ask-generation.ts` and
`outcome-anchor-pairing.test.ts`. `worker/config/startup-assert.ts` and
`worker/__tests__/**` were in surface and left untouched — the plan (§365) decided
`assertSolicitationSendEnv` needs no change; noted in the appendix, not raised.

---

## 3. Behaviour not named in `user_visible_behavior`

Nothing unnamed and material. Three additions, all accounted for:

1. **Throw on a null / non-canonical `google_place_id`** (`dispatch.ts:695-707`). A whole batch
   fails loudly rather than sending a dead call to action. This is user-visible and is not in
   the eight entries — but it is **D11**, an explicit owner ruling with a follow-up ticket, so
   it is not raised as a new finding.
2. **`stampConsentSnapshot`** (`:646-661`) writes `consent_basis` / `consent_attestation_version` /
   `consent_row_id` on every attempt that reaches tx1. Owner-invisible provenance mandated by
   migration 091's own column comments ("stamped at dispatch by #630"). Appendix only.
3. **`concurrency: 1` + `assertSingleConcurrencyWorker`** on the new worker
   (`worker/index.ts:333-349`). Operational, not user-visible; justified against Resend's
   per-TEAM limit and the idempotency key's one-at-a-time assumption.

No scope creep in the other direction: none of the eleven `non_goals` is violated. There is no
release poller, no drip pacing, no cap decision, no `subscriptionGrantsFullAccess` read, no
Judge logic, no D12d sweep, no migration, no `enqueueSolicitationSend` helper, no per-send rate
governor, and `src/lib/messaging/**` is untouched. The `QUEUE_NAMES.SOLICITATION_SEND` constant
is the one item that looks like a non-goal breach and is D4's recorded REJECT — a worker cannot
be registered without its queue name, and the *helper* is correctly deferred.

---

## 4. `tests_to_add` — 34 titles

**All 34 present VERBATIM. Zero `it.todo` remain** (D7's two mitigations discharged). Located:

- `dispatch-gate.test.ts` — 2
- `send-retry.test.ts` — 3 of the 34 (+1 extension)
- `dispatch.test.ts` — 5 of the 34 (+1 D11 extension)
- `dispatch.integration.test.ts` — 22
- `worker/jobs/__tests__/solicitation-send-failed-hook.test.ts` — 2

### Do they assert their titles?

Spot-audited 18 of the 34, weighted toward the invariant-critical ones. The standard is
unusually high — several carry explicit **negative controls** so the assertion cannot pass
vacuously. Highlights:

- *"never logs the raw unsubscribe token or the recipient handle"* (`dispatch.test.ts:465`) —
  scans every captured log line for a shape-and-signature detector, and first proves the
  detector works on a freshly minted token. Also asserts the digest prefix WAS logged.
- *"substitutes the raw unsubscribe URL in memory and never writes it to Postgres"*
  (`dispatch.integration.test.ts:1359`) — reads **every column** of both tables and applies the
  same negative control.
- *"runs re-lint and re-moderation before tx1 opens…"* (`dispatch.test.ts:421`) — asserts the
  round trip **resolved** before tx1's first statement, which is the temporal claim; a call-order
  assertion alone would pass on a lock-held await.
- *"commits the terminal CAS… in one transaction"* (`:1471`) — aborts tx2 with a real Postgres
  error (not a temporary CHECK — correct, per the live-DB DDL rule) and asserts all five facts
  absent.
- *"emits solicitation_sent on the child run with unit_count 1, never on the Send batch parent"*
  (`:1514`) — asserts both halves, and explains why the parent half is the load-bearing one.
- *"does not cancel an in-flight sending child when a halt lands after the CAS"* (`:1814`) —
  fires the real `haltBatch` from inside the adapter stub, i.e. in the exact window, and seeds a
  `queued` sibling so "the sweep ran" is distinguishable from "the sweep did nothing".
- *"evaluates the seven Dispatch gate items in B6 order…"* (`dispatch-gate.test.ts:84`) — repairs
  the items one at a time and asserts the reported sequence equals `GATE_ORDER`; a single verdict
  could not prove ordering.
- *"does not terminalize, fail the child, or complete the outbox before the final BullMQ attempt"*
  (`solicitation-send-failed-hook.test.ts:207`) — the 2-of-3 case, which is precisely the case the
  catch-block `isTerminalAttempt` form would get wrong.

**One weak assertion** — `send-retry.test.ts:124`. `SEND_FAILURE_CLASSES.filter(c => c === verdict)`
over a three-distinct-element array is always length 1, so the "exactly one" half of the title is
tautological. Totality (`:118`) and determinism (`:126`) are genuinely asserted, and the
discriminated return type already guarantees exactly-one — but the assertion as written proves
nothing. Finding 5.

---

## 5. `edge_cases` — 10 entries

| # | Edge case | Verdict |
|---|---|---|
| 1 | Retry finds the row already `sending`: **resume — re-issue the provider call with the same idempotency key, then run tx2** | **CHANGED BY D3, correctly.** The code refuses to re-send (`:1523-1530`, `:1309-1317`) because the raw token cannot be rebuilt in a fresh process. The intake text as written is unimplementable under invariant #5; the owner re-decided it as decision 9. Recorded, not raised. |
| 2 | Flag off between release and dispatch: defer, leave `queued`, complete the outbox row, **record a spine step**, do not send, do not throw | **PARTIAL — Finding 3.** Defer, queued-preservation, outbox completion and no-throw all hold (`:1537-1545`, `:1333-1344`). The spine step is not written on either defer path, and no child run is created to hold one. |
| 3 | Batch halted before the child runs ⇒ finds `cancelled`, no-ops, completes its outbox row | PASS (`:1301-1307`; test `:1212`) |
| 4 | `OPENAI_MODERATION_ENABLED=false` treated identically to a provider error; never sent | PASS — `moderationClean` requires `providerStatus === 'clean' && !flagged` (`:488`), the deliberate inverse of the reply lane's fail-open. Test `dispatch.test.ts:388` |
| 5 | Dispatch retry after the token insert: mint idempotent on `outreach_id`, body byte-stable | PASS — `ON CONFLICT (outreach_id) WHERE outreach_id IS NOT NULL` copied byte-for-byte from migration 096 (`:768`). Test `:1335` |
| 6 | Provider 4xx invalid-recipient / hard bounce: terminal, zero retries, `failed` + `send_failed` + `bounced_at` | PASS (`send-retry.ts:163-169`, `dispatch.ts:1030,1038`; tests `:1542`, `send-retry.test.ts:60`) |
| 7 | Provider 5xx / timeout / rate limit (incl. Resend 429) retryable with bounded jittered backoff | PASS (`send-retry.ts:70,152-160`; `sendRetryDelayMs` equal-jitter `:908-915`) |
| 8 | Retry exhaustion: colocated `'failed'` hook writes `failed` / `send_exhausted` and calls `closeBatchIfSettled` | PASS as written — **but see Finding 1** for the `sending` arm |
| 9 | Two concurrent terminal writers: `closeBatchIfSettled` CASes `send_closed_at` on NULL, second writes nothing | PASS — verified in `outreach.ts`; test `:1720` calls it a fourth time and asserts `already_closed` plus exactly one `send_batch_closed` step |
| 10 | A gate withhold still counts as a dispatch attempt: child created, steps recorded, terminalized in the same tx, no `solicitation_sent` | PASS (`commitWithhold:1154-1217`) |

---

## 6. Blast radius

### 6.1 The four additive files — confirmed additive

Read the full diff of each. No existing symbol changed shape:

- `src/lib/shared/worker-types.ts` (126 importers) — one new exported interface appended.
- `worker/index.ts` (94) — one import pair, one `Worker` construction, one `assertSingleConcurrencyWorker`
  call, one `'failed'` listener, one `workersByQueue` entry. No existing registration touched.
- `src/lib/shared/queue-names.ts` (73) — one new key. It **must byte-match** migration 091's
  `job_outbox_solicitation_send_inflight` predicate; verified: `091:543` is `WHERE topic = 'solicitation_send'`
  and the constant is `'solicitation_send'`.
- `src/lib/agents/run-spine.ts` (53) — two new `STEP_PERSONA` keys and one new exported read-only
  function. `STEP_PERSONA` is `satisfies Record<string, …>`, so widening it changes no existing
  member's type. `findActiveSolicitationSendBatchRun` takes no row lock, which is correct for this
  lane's batch→run order.

`worker/queues.ts` also took one new `Queue` + one `topicToQueue` entry, and correctly uses
`defaultJobOptions` (3 attempts) rather than `llmJobOptions` — this lane makes no LLM call.

### 6.2 `src/lib/solicitation/ask-generation.ts` — the semantic-risk file

**The refactor is behaviour-preserving. I checked value-by-value rather than by signature.**

`assembleInterpolation` previously returned three fields; it now returns only `inputs`, and the
lint's two lists are derived from that same object by `lintInputFromSnapshot`
(`ask-compliance-lint.ts:246-263`). The mapping is:

| Old list member (`ask-generation.ts` pre-diff) | New source | Identical? |
|---|---|---|
| `firstName` | `snapshot.contact_first_name` | yes — `inputs.contact_first_name = firstName` on the same construction (`:365`) |
| `ctx.businessName` | `snapshot.business_name` | yes (`:366`) |
| `bucket` | `snapshot.days_since_visit_bucket` | yes (`:367`) |
| `vertical` | `snapshot.vertical` | yes (`:368`) |
| `...(visitNote !== null ? [visitNote] : [])` | `...(snapshot.visit_note !== null ? [snapshot.visit_note] : [])` | yes — `inputs.visit_note = visitNote` (`:369`) |
| `subjectDisallowedValues: visitNote !== null ? [visitNote] : []` | same predicate over `snapshot.visit_note` | yes |

The object literal is built immediately above the old return in the same function from the same
locals, so the two derivations are provably the same values. `lintAsk`'s input at
`ask-generation.ts:570` is therefore byte-identical to what it was.

**`AssembledChild` is module-private** (`interface AssembledChild`, not exported), and
`assembleInterpolation` is likewise unexported — so the two dropped fields have **no external
caller**. I grepped the six importers of `ask-generation.ts`: the only exported surface they use
is unchanged (`OutboxHandle` is now additionally type-imported by `dispatch.ts`, which is a new
consumer, not a changed contract).

`ask-compliance-lint.ts` (7 importers) gained one export plus one **type-only** import of
`AskInterpolationInputs` from `ask-prompt-policy.ts`. The type-only form is load-bearing:
`ask-prompt-policy.ts` already value-imports `NoteDisposition` from `ask-compliance-lint.ts`, so
a value import either way round would be a runtime cycle. Correct as written.

One residual, appendix-level: `buildAskPrompt` gates the note on
`note_disposition === 'admitted' && visit_note !== null`, while `lintInputFromSnapshot` gates on
`visit_note !== null` alone. They agree today because `assembleInterpolation` nulls the note
unless admissible, but the two now express the same rule differently in two files.

---

## 7. The named "must verify" list

| Question | Answer |
|---|---|
| **Invariant #5** — raw token never in Postgres / an outbox payload / a log line | **Holds.** Only `hashUnsubscribeToken(raw)` is bound. This lane writes no outbox payload. The only token value logged is `logPrefix(sha256(raw))`. Two tests with negative controls. |
| **Invariant #2** — terminal tx completes its own outbox row in the same tx | **Holds.** Every arm completes inside its transaction; tx2 is atomic and proven so by an abort test. |
| **`provider_message_id` on every successful send** | Holds on the success path. One narrow hole — Finding 1: send succeeds, tx2 throws, and the FINAL BullMQ attempt is the one that sent ⇒ the hook writes `failed`/`send_exhausted` and the id is lost. |
| **`solicitation_sent` on the CHILD at `unit_count = 1`** | **Holds**, both halves asserted. |
| **Could a real customer receive two emails?** | **No path found.** Traced all five: (a) **BullMQ retry** — pre-tx `sending` short-circuit `:1523` plus the race-tight repeat under `FOR UPDATE` `:1309`; (b) **outbox watchdog re-pend** — same two guards; a re-pend that arrives while the previous attempt is still *above* tx1 wins the ownership CAS, and the older attempt then aborts at `lockDispatchedOutboxAttemptIfOwned`, which is tx1's FIRST statement `:1267`; (c) **in-process retry** — the same `message` object, same `outreachId` idempotency key, asserted by object identity; (d) **mint conflict** — `DO NOTHING … RETURNING` yields no row ⇒ `token_conflict` ⇒ no send `:1392-1407`; (e) **fresh process after a crash** — refuses structurally because the hash cannot give the raw token back. `concurrency: 1` on the worker removes intra-process concurrency as well. |
| **Could a real customer receive an email they should never have received?** | **No path found for the five named facts.** *Suppression*: `suppressionMatchSql` is composed, never re-spelled, and the global-wins ordering comes with it; a null handle cannot fail this open because `consent` is a later terminal item and a null handle also has no consent row. *Consent*: `solicitation_consent` has no revocation column (revocation lives in the Suppression ledger, which is checked first), so the row+version test is complete. *Halt*: `deriveBatchState` puts `halted_at` first, and the send-open set excludes `halted`, `closed`, `veto_window`, `expired`, `built`, `pending`; the send window is checked separately so a stale drip cannot send on day four. *Master flag*: checked twice — once above tx1 and once as gate item 2 under the lock. *Moderation*: fail-CLOSED — `OPENAI_MODERATION_ENABLED=false` and a provider error are both `moderationClean: false`. |

---

## 8. Findings in detail

### Finding 1 — Medium. The exhaustion hook can record a delivered email as `failed`

`worker/jobs/solicitation-send/failed-hook.ts:173`

```
AND delivery_status IN ('queued', 'sending')
```

Reachable sequence, with `attempts: 3` (`worker/queues.ts:38`):

1. Attempts 1 and 2 throw **above** tx1 — e.g. `moderateResponse` (`dispatch.ts:484`) rejects on a
   network blip; it is awaited with no local catch, so the handler throws and BullMQ retries.
2. Attempt 3 passes the gate, CASes the row to `sending`, and the provider **accepts the message**.
3. tx2 (`:1627`) throws on a transient Postgres error. `dispatchOutreach` propagates.
4. BullMQ emits `'failed'` with `attemptsMade === 3 === max`, so `isSendAttemptExhausted` returns
   true and the hook runs. The row is `sending`, so the CAS above matches.

Result: `delivery_status = 'failed'`, `disposition_reason = 'send_exhausted'`,
`provider_message_id` NULL, `bounced_at` NULL, the child completed `failed`, no `solicitation_sent`
outcome, and the batch joined and closed. A real recipient has the email; the ledger says the send
failed and carries no join key for a later bounce or complaint.

A second, shorter route to the same state: tx2 throws on attempt 1, and attempts 2 and 3 then throw
inside `completeOutboxNoop` while the database is still degraded.

This contradicts the design's own principle. `dispatch.ts` refuses to write ANY terminal verdict
about a row whose message may already have reached a person — that is the whole of decision 9 and
the reason `in_flight_elsewhere` exists (`:1229-1230`, `:1310-1314`) — and D12d created
`unknown` / `send_indeterminate` precisely for "we do not know whether this was sent". Migration
091 admits that pair (`091:317`). The hook picks `failed` instead.

The intake's `edge_cases[8]` sanctions `failed`/`send_exhausted` for exhaustion, so the *reason* is
contractual; what is not contractual is applying it to the `sending` arm, which is exactly the
population D12d owns. The narrowest fix is to drop `'sending'` from the CAS and let #900's sweep
terminalize it — but that decision belongs to whoever owns the D12d boundary, so it is reported
rather than prescribed.

### Finding 2 — Medium. `cas_lost` commits a burned token and an orphan child run

`src/lib/solicitation/dispatch.ts:1301-1317` (the triage) and `:1452-1457` (the refusal).

tx1 reads the Outreach row `FOR UPDATE` and branches on exactly two statuses — `cancelled`
(`:1301`) and `sending` (`:1309`). Every other non-`queued` status (`rendered`, `withheld`,
`failed`, `unknown`) falls through into the full Dispatch gate. When the gate then PASSES, tx1
performs, in order:

- `mintUnsubscribeToken` — INSERTs a token row (`:1388`)
- `startLazyChild` — creates a NEW `solicitation_ask` run (`:1409`)
- stamps `agent_run_id` on the Outreach row (`:1411-1418`)
- `recordStep('dispatch_gate_evaluated', { outcome: 'send' })` (`:1421-1429`)
- the CAS, which is the FIRST statement that requires `delivery_status = 'queued'` (`:1449`)

On `claimed.count === 0` the function completes the outbox attempt and **returns normally**
(`:1456-1457`). A normal return from the `sql.begin` callback COMMITS in postgres.js, so all four
writes above survive:

- The token row is committed with its raw value gone. Any future dispatch of that Outreach row now
  hits `ON CONFLICT … DO NOTHING` ⇒ `token_conflict` ⇒ permanent refusal to send. The row is
  **permanently unsendable** with no operator signal beyond one `warn` line.
- The child run is left `running` and is never terminalized — nothing in the branch calls
  `completeRun`.
- A `dispatch_gate_evaluated` / `outcome: 'send'` step is recorded for a dispatch that was refused.

This is the precise hazard the sibling branch's own comment forbids (`:1400-1404`): *"A conflict
here must leave no run behind — creating one, stamping `agent_run_id` over a terminal row's and
recording a step would be three writes about work this invocation is refusing to do."* The
`cas_lost` branch performs all three, plus the token.

The comment at `:1437-1440` calls the branch unreachable "while this transaction holds the row's
`FOR UPDATE`". That is true only for `queued`; it does not cover the other four statuses the triage
lets through. Reachability today is low — #900 is the only intended producer and will CAS
`rendered → queued` before enqueueing — but the branch exists because the author anticipated the
case, and its handling is unsafe. Throwing (so tx1 rolls back) would be inert and correct; the
outbox row would then be reclaimed by the watchdog.

The same fall-through has a smaller sibling: `commitWithhold`'s UPDATE (`:1161-1170`) carries **no
status predicate**, so on a withhold verdict a `rendered` or already-`failed` row is rewritten to
`withheld`. The `sent` case is caught by migration 091's
`(delivery_status = 'sent') = (sent_at IS NOT NULL)` CHECK — at the cost of three failed BullMQ
attempts and a Sentry issue.

### Finding 3 — Medium. The flag-off defer records no spine step

`src/lib/solicitation/dispatch.ts:1333-1344` (in-gate defer) and `:1537-1545` (pre-tx defer).

Intake `edge_cases[1]`, verbatim:

> SOLICITATION_SEND_ENABLED flips off between release and dispatch: defer — leave the row queued,
> complete the outbox row, **record a spine step**, do not send and do not throw.

Four of the five clauses hold. No spine step is written on either defer path, and no **Lazy child**
is created to carry one, so `agent_run_steps` holds no evidence that the attempt was evaluated. The
same is true of the `batch_open` defer.

The intake's own `observability` section leans on this: *"`agent_run_steps` rows for the gate verdict
and the send result on the Lazy child … the value ledger that proves sends happened."* For a
deferred attempt the only artifact is a `logger.log` line.

The plan (`docs/superpowers/plans/2026-08-21-899-solicitation-send-worker.md:163-171`) already
dropped the clause — the gate table's `send_flag` row says only "`defer` (decision 5)" — so the
divergence was introduced at plan time and carried into the code. It is **not** among D0–D11.

Whether a step is worth a child run for a no-decision is a legitimate design call (the code argues
at `:1334-1337` that a defer writes no domain state at all, which is a coherent position). But the
intake asked for it, the deviations file does not record dropping it, and the observability entry
depends on it — so it is reported as an unmet contract clause, not as a bug.

### Finding 4 — Low. Stale `docs/directory.md` row

`docs/directory.md:931` ends:

> Today it implements the flag-off defer only; Tasks 2–7 fill in the evidence, the token mint, the
> provider call and the terminal transaction.

The row was written at Task 1 and never updated. `dispatch.ts` is 1,658 lines and implements all of
it. `ci:directory-map` only enforces row presence/absence, so this passes CI. Per CLAUDE.md the
directory is the code map a new reader consults first; a row that describes the module as a stub is
worse than no row. Same file, same row, one sentence to delete.

### Finding 5 — Low. A tautological assertion in a promised property test

`src/lib/solicitation/__tests__/send-retry.test.ts:124`

```ts
expect(SEND_FAILURE_CLASSES.filter((cls) => cls === verdict)).toHaveLength(1);
```

`SEND_FAILURE_CLASSES` is a three-element array of distinct literals (`:25`), so filtering it for
equality with any one member is always length 1 regardless of what `classifySendFailure` returned.
The `tests_to_add` title promises *"every provider error maps to **exactly one** retry class"*; what
`:118` and `:126` actually prove is totality and determinism, both of which are real and valuable.
Exactly-one is already guaranteed by the union return type, so the honest options are to delete the
line or to replace it with a mutual-exclusivity check over independent predicates.

---

## Appendix — low-confidence observations (NOT findings)

These did not meet the confidence bar for the table.

1. **No boot gate for `NEXT_PUBLIC_APP_URL`.** `assertSolicitationSendEnv`
   (`worker/config/startup-assert.ts`) requires four solicitation env vars but not
   `NEXT_PUBLIC_APP_URL`, which `buildUnsubscribeUrl` (`dispatch.ts:719`) throws on. With the flag
   on and that var unset, every dispatch burns three BullMQ attempts and terminalizes
   `failed`/`send_exhausted`. The throw is inside tx1 so nothing partial commits, and the plan
   (§365, §637) explicitly decided fail-at-runtime mirroring the ingress. `startup-assert.ts` was
   in surface and deliberately untouched. Recorded, not raised.
2. **`lintInputFromSnapshot` vs `buildAskPrompt` note predicate.** One gates on `visit_note !== null`,
   the other on `note_disposition === 'admitted' && visit_note !== null`. Equivalent today.
3. **`stampConsentSnapshot` writes on the withhold path too.** Deliberate and documented
   (`:641-645`); mentioned only because it is a domain write not named in `user_visible_behavior`.
4. **`sendWithBoundedRetry`'s unreachable tail return** (`:972`) is dead by construction; the
   comment says so. Harmless.
5. **`gatherSlowGateEvidence` computes both items unconditionally**, so a lint failure still pays for
   a moderation round trip. Justified in the docstring (the record must not lie about a check nobody
   ran; the endpoint is free). Latency cost only.
6. **A `sending` row left by a crash keeps a `running` child run forever.** Asserted as intended by
   `dispatch.integration.test.ts:1395`. It is D3's accepted cost, but it means
   `agent_runs_one_active_per_subject` holds an indefinitely-running row per stranded ask until
   #900's sweep exists. Worth confirming when #900 lands.
7. **`worker/__tests__/**` was in surface and unused.** No boot-registration test was added for the
   new worker; `worker/index.ts`'s registration is covered indirectly by the concurrency assert.

---

## Verdict

The branch is a faithful, high-quality implementation of the intake. All 13 invariants hold in the
code (not merely in the comments), all 34 promised tests exist verbatim with real assertions and
several with negative controls, there is zero surface drift, and no path was found by which a
customer receives two emails or an email they should not receive.

Three items warrant a decision before merge: the exhaustion hook's `sending` arm (Finding 1), the
`cas_lost` commit (Finding 2), and the missing defer spine step (Finding 3). None of the three
blocks the merge on its own — `SOLICITATION_SEND_ENABLED` is off everywhere and there is no
producer until #900 — but Findings 1 and 2 both become live the moment #900 ships, and Finding 3 is
an unrecorded contract gap.
