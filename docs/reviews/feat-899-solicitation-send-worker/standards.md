# Standards & maintainability review — `feat-899-solicitation-send-worker`

**Route taken:** invoked the repo's `thermo-nuclear-code-quality-review` skill; it loaded and I
applied its criteria directly (it is a review *rubric*, not a delegating skill). No fallback to
`code-review` was needed.

**Scope:** `git diff 9e60617c...HEAD -- src worker` (20 files, +5,677 / −35 in that scope; 30
files, +7,806 / −37 across the whole branch). Read-only. No test, build, lint or gate command was
run — the gate is already green at 23 checks including `diff-coverage`.

**Read first:** `.claude/CLAUDE.md`, `CONTEXT.md` (the ten locked terms named in the brief),
`docs/superpowers/plans/feat-899-solicitation-send-worker-deviations.md` (D0–D11).

---

## Headline

This is genuinely good work. `applyDispatchGate` **is** a pure function and **is** the single
owner of amendment B6's order — the order appears nowhere else in the branch, the two evidence
records are the only inputs, and nothing in `runDispatchTx` re-spells a predicate the gate owns.
The gate/orchestrator split is real depth, not ceremony. Invariant #15 holds (`sql`/`tx` are
explicit parameters; no `@/lib/db/server` import anywhere in the lane). Invariant #12 holds — the
worker boot file is 41 lines and does exactly one thing. There is no `any`, no silent catch that
isn't a sanctioned observability swallow, and the one outbound provider call is bounded by
`sendEmail`'s 10s `Promise.race` timeout plus a three-attempt equal-jitter ladder.

The `send-retry.ts` classifier is the strongest single file on the branch: pure, total over
`unknown`, and its narrowest class (`terminal_bounce`) is correctly a conjunction because it is
the only one that stamps `bounced_at`.

**The one real defect is a missing status predicate.** tx1 short-circuits on `cancelled` and
`sending` and nothing else, so any other non-`queued` status walks the entire gate and commits
writes it should not. Everything below is downstream of that, plus three
documentation-accuracy failures and two duplication items.

---

## Findings

### F1 — HIGH · `src/lib/solicitation/dispatch.ts:1301`, `:1309`, `:1163`, `:1449`

**tx1 guards only `cancelled` and `sending`. Every other non-`queued` status falls through the
whole gate and commits writes.**

`runDispatchTx` reads the Outreach row `FOR UPDATE` (line 1286) and then branches on exactly two
statuses:

```
1301:  if (outreach.delivery_status === 'cancelled') { … return; }
1309:  if (outreach.delivery_status === 'sending')   { … return; }
```

`rendered`, `withheld`, `sent`, `failed` and `unknown` all continue. The `queued` predicate does
not appear until the very last statement of tx1, at line 1449. By then the transaction has
already committed, in order:

| Line | Write |
|---|---|
| 1346 | `stampConsentSnapshot` — overwrites a terminal row's consent triple |
| 1163 | `commitWithhold`'s `UPDATE … SET delivery_status = 'withheld'` — **no status predicate at all** |
| 1387 | `mintUnsubscribeToken` — a committed token row keyed on `outreach_id` |
| 1404 | `startLazyChild` + `agent_run_id` overwrite |
| 1417 | a `dispatch_gate_evaluated` step on the spine |

Two concrete failure shapes, both silent against migration 091's CHECKs:

1. **A `rendered` row is terminalized.** If the gate fails (say a suppression landed), line 1163
   writes `withheld` over a row that was never released. 091's status↔reason arm accepts
   `rendered → withheld`, and its status↔timestamp arm is vacuous with `sent_at` NULL, so the DB
   does not object. An ask the owner never approved for release dies quietly, and
   `closeBatchIfSettled` then joins the batch on the strength of it.

2. **A `rendered` row is permanently wedged.** If the gate *passes*, line 1387 commits a token
   row for that `outreach_id`, then the CAS at 1449 fails and returns `cas_lost` — but the
   transaction still commits. When #900 later releases that row for real, `mintUnsubscribeToken`
   hits `ON CONFLICT … DO NOTHING`, returns `null`, and the dispatch refuses as
   `in_flight_elsewhere` / `token_conflict` **forever**. There is no path back: the hash cannot
   yield the raw token, and by design nothing re-mints.

The `sent` arm is the safe one only by accident — `(delivery_status = 'sent') = (sent_at IS NOT
NULL)` makes the `withheld` overwrite throw. That is the database catching a bug the module
should not be able to express.

**The author already knew the predicate was load-bearing.** The sibling exhaustion hook
constrains its own terminal write exactly right:

`worker/jobs/solicitation-send/failed-hook.ts:157` —
`AND delivery_status IN ('queued', 'sending')`

and its comment explains at length why `rendered` is deliberately excluded ("that row was never
dispatched, and 091's status/timestamp CHECK would then record a dispatch that never happened").
The success path has no equivalent.

**Not covered by tests.** `dispatch.integration.test.ts` seeds `cancelled` (line 1227) and
`sending` (1401) and asserts the two short-circuits. No case seeds a `rendered` or terminal row
and dispatches it, so the gap is invisible to the suite.

**Fix, and it is small:** one branch beside the two that exist, refusing anything that is not
`queued`, before `gatherFastGateEvidence` runs. That also collapses F2 and removes the
`cas_lost` detector's only realistic trigger.

**Reachability caveat, stated honestly:** #900 (the producer) is not built, and today nothing
enqueues `solicitation_send`. This is a latent defect, not a live one. It is still a HIGH: B10's
whole rationale for shipping the consumer first is that the consumer must be safe against
whatever the producer sends it, and the fix costs three lines.

---

### F2 — MEDIUM · `src/lib/solicitation/dispatch.ts:1437`

**A load-bearing comment asserts an invariant the code does not have — and contradicts the
comment 16 lines below it.**

```
1437:  // Zero rows means another writer owns this dispatch. Unreachable while this
1438:  // transaction holds the row's `FOR UPDATE` — the status was read under it a
1439:  // few statements ago — so the guard is belt and braces, and it is what makes
1440:  // the stamp and the status move as one act rather than as two.
```

The `FOR UPDATE` rules out a *concurrent* change. It says nothing about the status having been
non-`queued` on arrival, which is exactly F1's case — and the status "read under it a few
statements ago" was never compared against `queued`. So the branch is not "belt and braces"; it
is the only thing standing between a `rendered` row and a committed token.

The comment at 1453 gets it right and disagrees with 1437:

```
1453:  // Its own detector rather than the `sending` one: all this observed is
1454:  // "the row was no longer `queued`" …
```

Two comments about the same branch, one claiming it cannot fire and one describing what it
observes when it does. Per the brief's own standard — a header describing a state the code has
left is worse than no header — 1437 should go when F1 is fixed, or be rewritten to name the real
guarantee.

---

### F3 — MEDIUM · `docs/directory.md:931`

**The `dispatch.ts` code-map row still describes the branch's Task-1 state.**

The row this branch added ends:

> Today it implements the flag-off defer only; Tasks 2–7 fill in the evidence, the token mint,
> the provider call and the terminal transaction.

None of that is true of the merged module — the evidence, the mint, the provider call and both
transactions are all there. `ci:directory-map` enforces only that a row *exists* for every
production file and that no row is orphaned; it cannot see staleness, so nothing catches this.

This matters more than a normal stale comment because CLAUDE.md makes `docs/directory.md` the
mandatory first read before adding any file ("Default is 'no new file' — check `docs/directory.md`
first"). The first thing the next author reads about the branch's largest module is a description
of a module that no longer exists.

CLAUDE.md's own rule is the one being broken: *"When deleting a doc or ticking a checklist item,
fix its audit tick and grep the filename to clean every cross-reference in the same change."*

---

### F4 — MEDIUM · `src/lib/solicitation/dispatch.ts:663`

**Glossary violation: a locked term reused for a different act.**

```
663: // ── The send handoff: token mint + message assembly ──────────────────────────
```

**Send handoff** is LOCKED (`CONTEXT.md:77`) and means one specific thing: the
`enqueueGenerateSolicitationAsks` call at the end of `constructBatch` in
`src/lib/solicitation/batch-builder.ts` — the single point where a Solicitation batch becomes
send-mode work, and the place a *whole location* is withheld for a missing Attested postal
address. It is a batch-builder-time act.

The section it now labels is dispatch-time token minting and envelope assembly for one contact —
a different act, in a different module, at a different point in the lifecycle. The term's own
_Avoid_ list is about protecting it from being confused with the gate ("dispatch gate (that last
is #630's, a different thing)"); this header runs the confusion in the opposite direction.

It is a section divider, so the blast radius is small — but the whole point of a locked term is
that grepping it finds one concept. Rename to something like `// ── Token mint + message
assembly ──`.

**Two near-misses I checked and cleared:** `isRetryableTransportFailure` /"transport rejection"
in `send-retry.ts` uses "transport" for the network layer, not as a name for the **Messaging
adapter** — and `messaging-adapter.ts` itself already says "the ReviewPublisher transport-method
precedent", so the usage predates this branch. `"sender-identification line"` at dispatch.ts:367
is CAN-SPAM vocabulary for the §7.2 footer block, not a rename of the adapter. Neither is a
finding.

---

### F5 — MEDIUM · `src/lib/solicitation/dispatch.ts:1046`

**When tx2's terminal CAS matches no row, `provider_message_id` is dropped on the floor while the
send is still recorded.**

```
1046:  if (terminalized.count === 0) {  … logger.warn(…)  }
1054:  if (sent) { recordStep('ask_sent'); recordOutcome('solicitation_sent'); }
```

The `UPDATE` at 1032 is the *only* writer of `provider_message_id`, and it is gated on
`delivery_status = 'sending'`. When another writer (#900's D12d `unknown` sweep) got there first,
the id is never persisted anywhere — yet the `solicitation_sent` outcome and the child's
`completed` terminal still commit, so the spine records a send whose join key does not exist.

Both locked terms say this is not allowed:

- **Messaging adapter** (`CONTEXT.md:79`): *"the returned `providerMessageId` is persisted in the
  SAME transaction that CASes the row terminal (so a send can never be recorded without its join
  key) … a caller that discards it makes every later feedback event unattributable."*
- **Solicitation lane** (`CONTEXT.md:81`): unmatched suppression-bearing events (permanent bounce,
  complaint, `email.suppressed`) *"**throw → 503 → Resend retries**, closing the window before
  #630 commits `provider_message_id`."* That design assumes the window always closes. On this
  path it never does, so a hard bounce for that message 503s until Resend gives up and the
  suppression is never recorded — the CAN-SPAM-adjacent direction.

The module's own docstring (line 1015) even states the rule it then breaks: *"`provider_message_id`
is not optional on the sent arm."*

**Fix:** persist the id unconditionally. Either drop `provider_message_id` out of the CAS into a
second `UPDATE … WHERE id = …` with no status predicate (the column is write-once and no other
writer touches it), or add it to the CAS's `count === 0` branch. One statement.

Same caveat as F1: D12d is #900's and does not exist yet, so this is latent. The fix is cheaper
than the follow-up ticket would be.

---

### F6 — LOW · `worker/jobs/solicitation-send/failed-hook.ts:40`

**`boundedErrorClass` is now the fifth hand-rolled copy of the same nine-line function.**

| File | Line |
|---|---|
| `worker/jobs/solicitation-batch/failed-hook-shared.ts` | 36 (already `export`ed) |
| `worker/job-failure-sink.ts` | 59 |
| `worker/jobs/judge/failed-hook.ts` | 39 |
| `worker/jobs/csv-ingest/failed-hook.ts` | 94 |
| `worker/jobs/solicitation-send/failed-hook.ts` | 40 (new) |

The new copy's docstring justifies itself by quoting `failed-hook-shared.ts`'s "Deliberately NOT
generalized past this folder". That reasoning was defensible at copy two; at copy five the
regex bound (`{0,99}`) and the `'UnknownError'` fallback are a de-facto shared contract
maintained in five places, which is textbook shotgun surgery. It also sits awkwardly against this
domain's own recorded rule, from the **Ask withdrawal** entry in `CONTEXT.md:75`: *"a THIRD caller
is the signal to extract rather than a second."*

Not a blocker for this branch — the copy is correct and the precedent is pre-existing — but it
belongs on the same follow-up list as D8's relocation, and arguably in the same ticket: both are
"a provider-agnostic helper is living in a folder that claims to own it."

---

### F7 — LOW · `src/lib/solicitation/dispatch.ts:394`

**`completeOutboxNoop` is a verbatim second copy of `src/lib/solicitation/ask-generation.ts:791`
— same name, same body, same directory.**

```ts
async function completeOutboxNoop(sql: Sql, outboxId: string, attempt: number): Promise<void> {
  await sql.begin(async (tx) => { await markOutboxCompletedIfOwned(tx, outboxId, attempt); });
}
```

The docstring says "Shape copied from `ask-generation.ts`'s `completeOutboxNoop`", which is honest
but is a description of the problem. Unlike F6 the two copies are in the *same folder*, so the
"deliberately not generalized past this folder" argument does not even apply — this is exactly the
case CLAUDE.md's "no near-duplicate dependencies" and "no abstractions for a single caller"
(now two callers) point at. Three lines, one export, one import.

---

## Verified clean — things I checked and found correct

Recorded so a later reviewer does not re-derive them.

| Standard | Result |
|---|---|
| No `any` (JSONB carve-out aside) | Clean. Zero occurrences in the four new production files. `interpolation_inputs` is typed `unknown` and narrowed through the sanctioned parse site `parseOutreachInterpolationInputs` (dispatch.ts:269, :473) — the allowlist route, not a re-spelled guard. |
| No silent catches | Clean. Two catches: `sendWithBoundedRetry` (dispatch.ts:956) classifies and logs; `logFailureSafely` (failed-hook.ts:70) is the sanctioned observability swallow with the reason stated. |
| Invariant #15 — explicit `sql`/`tx` | Clean. `dispatchOutreach(sql, …)`, every helper takes `tx: TransactionSql`, no `@/lib/db/server` import in the lane. Composition roots are `worker/jobs/solicitation-send.ts` and the `'failed'` listener in `worker/index.ts:351`, both registered in `index.ts`. |
| Invariant #12 — entry points orchestrate | Clean, and unusually well. `worker/jobs/solicitation-send.ts` is 41 lines: extract handle, one call. `handleSolicitationSendFailed` maps errors and delegates the coupled transaction to `commitSendExhaustion`. |
| Invariant #2 — transactional outbox | Clean. No enqueue in the lane; the one durable analytics write goes through `enqueueAnalyticsEvent` inside tx1 (dispatch.ts:1195). |
| Invariant #5 — no raw tokens stored/logged | Clean, and defended in three places. Only `hashUnsubscribeToken`'s output reaches Postgres; the only logged form is `unsubscribeTokenLogPrefix` (dispatch.ts:1595), and the `sending`-resume path explicitly refuses to log a prefix it does not hold (dispatch.ts:1515–1522). |
| Explicit timeout + bounded jittered retries on the provider call | Clean. `sendEmail` bounds Resend at 10s (`EMAIL_SEND_TIMEOUT_MS`, default `10_000`) via `Promise.race`; `sendWithBoundedRetry` adds 3 attempts with equal jitter (200ms base, 2s ceiling) using `node:crypto`'s `randomInt`. Only `retryable` is retried, and the same `OutboundMessage` object is reused so the idempotency key and body are identical by construction. |
| Invariant #10 — node native crypto | Clean. `randomInt` from `node:crypto`; `uuidv7` is the repo-standard UUIDv7 source. |
| `ON CONFLICT` byte-match | Clean. `ON CONFLICT (outreach_id) WHERE outreach_id IS NOT NULL` (dispatch.ts:1379) matches migration 096's `solicitation_unsubscribe_tokens_outreach_uniq`. |
| Lock order | Clean and consistent across all three transactions: advisory batch lock is the first statement in tx1 (dispatch.ts:1273), tx2 (`commitSendTerminal`, :1026) and the exhaustion hook (:134), matching `acquireSolicitationBatchLock`'s ABBA contract against the offboarding purge. |
| No lock held across the ~10s moderation call | Clean, and this is the design's sharpest move. `gatherSlowGateEvidence` runs above tx1 (dispatch.ts:1560); B6's *order* is preserved because only the gathering moved — `applyDispatchGate` still applies lint/moderation at slots 8 and 9, so a suppressed contact still reports `suppressed`, not `lint_failed`. |
| Live-DB suite conventions | Clean. `dispatch.integration.test.ts` carries the `.integration.test.ts` name and executes no run-time DDL. |
| `assertSingleConcurrencyWorker` | Correctly applied (`worker/index.ts:349`) and correctly justified — the guard rejects an *undefined* concurrency, so a future edit dropping `concurrency: 1` fails boot rather than double-sending against Resend's per-TEAM limit. |
| `llmJobOptions` vs `defaultJobOptions` | Correct. `worker/queues.ts:86` uses `defaultJobOptions` with the reason stated: no LLM call, so extra attempts only widen the re-send window. |
| D7's `it.todo` mitigation | **Discharged.** Zero `it.todo` remain; the two grep hits are comments in the suite headers asserting that fact. |
| `lintInputFromSnapshot` refactor (the branch's one semantic-risk file) | Behaviour-preserving. The old `assembleInterpolation` built `interpolationValues` from `firstName / ctx.businessName / bucket / vertical`; the new function reads `contact_first_name / business_name / days_since_visit_bucket / vertical` off the same `inputs` object those four values populate one statement earlier (`ask-generation.ts:365–371`). All four are non-nullable on `AskInterpolationInputs`. The `visit_note` condition is identical in both. |

---

## Challenges to the triaged deviations — none

I re-read all twelve entries and disagree with no verdict.

**D8** (the `stripe-error-inspect.ts` import) is correctly accepted. I re-verified the premise
rather than taking it: `src/lib/payments/stripe-error-inspect.ts` has zero imports, and the eight
codes are OS socket codes (`ECONNABORTED`, `ECONNREFUSED`, `ECONNRESET`, `EAI_AGAIN`, `ENETDOWN`,
`ENETRESET`, `ENETUNREACH`, `ETIMEDOUT`) with nothing Stripe-specific about them. Copying them
would be the drift that file's header exists to prevent. The relocation follow-up is the right
disposition. F6 above is the same *shape* of problem in `worker/` and should probably ride the
same ticket.

**D0** (2.5× the line estimate, lane re-confirmed) is correctly accepted. The size is not itself a
finding: `dispatch.ts` at 1,658 lines sits beside `ask-generation.ts` at 1,699 and
`ask-compliance-lint.ts` at 859 in the same folder, the file is sectioned with dividers, and every
long block is comment rather than control flow. Applying the skill's 1k-line rule mechanically
here would be measuring a different codebase. My decomposition observation is in the appendix as
an opinion, not a finding.

**D11** (throw on a missing/hex-CID place id) is correct as decided, and `buildReviewLink` is
placed correctly — *before* the mint (dispatch.ts:1385), so a business that cannot build its call
to action never burns a token row it could not use.

---

## Low-confidence appendix — observations, not findings

None of these meets the ≥80% bar; they are recorded so they are not re-discovered.

1. **`send_flag` is checked twice and the pre-check inverts B6's order.**
   `dispatchOutreach:1536` returns early when `!solicitationSendEnabled()`, and
   `gatherFastGateEvidence:606` reads the same flag again as gate item 2. Because `readFlag` hits
   `process.env` fresh each call (`src/lib/config/flags.ts:22`), the second read *can* differ, so
   the gate arm is not dead code — but in production it never will. The observable consequence of
   the inversion is one log line: a flag-off row reports `send_flag` before `batch_open`, where B6
   orders `batch_open` first. Both are defers with identical domain effect (nothing written,
   outbox completed), so no domain state can distinguish them. Decision 5 documents the pre-check
   deliberately. Not a finding, but if F1's status guard lands, the pre-check could move below it
   and the duplication would be worth revisiting.

2. **"Two doors" vs. the actual export surface.** The module header (dispatch.ts:4–9) says the
   module has two doors, `applyDispatchGate` and `dispatchOutreach`. It also exports
   `assembleOutboundMessage`, `OutboundMessageInput`, `DispatchGateItem`,
   `OutreachWithheldReason`, `SlowGateEvidence`, `FastGateEvidence`, `DispatchGateVerdict` and
   `DispatchOutreachInput`. `assembleOutboundMessage`'s only non-test consumer is the same file
   (`dispatch.test.ts:113` is the sole external reference), so it is exported for testability. The
   two gate types are named in `CONTEXT.md`'s Dispatch gate entry, so their export is sanctioned;
   `assembleOutboundMessage`'s is not. Very minor — the header could say "two doors plus one pure
   assembler exported for its own test."

3. **A possible decomposition, offered as opinion.** `buildReviewLink` + `buildUnsubscribeUrl` +
   `anchor` + `assembleOutboundMessage` + the two placeholder constants (dispatch.ts:663–890) are
   a cohesive, DB-free, clock-free "envelope assembly" unit with one caller and its own test
   surface. Lifting them to `src/lib/solicitation/outbound-message.ts` would take ~230 lines out of
   the file and make the boundary between "what the owner approved" and "what goes on the wire"
   a module edge rather than a section divider. Likewise `sendWithBoundedRetry` + `sendRetryDelayMs`
   + `sleep` + the three tuning constants (~90 lines) is a natural neighbour for `send-retry.ts`,
   which already owns the classification half of the same concern. I am **not** raising either as
   a finding: the file is well-organised, `CONTEXT.md` explicitly names `dispatch.ts` as the home
   of both doors, and D0 already re-confirmed the lane at the real size. Worth a conversation at
   the next change to this file, not a blocker on this one.

4. **"resume" as internal vocabulary.** The **Halt latch** _Avoid_ list bans `pause`, `stop`,
   `cancel batch`, `resume` in "identifiers, comments, docs, run-step and reason values".
   dispatch.ts uses "resume" three times in comments (lines 29, 281, 1226) — but always about a
   fresh *process* resuming a dispatch, never about un-halting a batch, and no identifier is
   named `resume`. I read the ban as scoped to the latch's own subject, so I am not raising it.
   Flagging only because a future grep-based audit will hit these three lines.

5. **`commitSendTerminal` records `solicitation_sent` when the CAS lost.** Separate from F5's
   join-key point: the outcome row and the `ask_sent` step still commit against a row another
   writer called `unknown`. The comment argues this is right ("the message really did reach the
   provider"), and I agree — the spine records work *performed*. Noted only because it means
   `solicitation_sent` outcome counts and `delivery_status = 'sent'` row counts can legitimately
   disagree by the size of the D12d race, which whoever builds the batch receipt should know.

---

## Approval bar

Against the skill's own bar: no structural regression, no unjustified file-size explosion, no
spaghetti growth, no boundary leak, no cast/optionality churn, and no unnecessary abstraction —
the deep-module claim holds up under inspection.

**F1 should be fixed before merge** (three lines, and it removes F2 with it). F5 is one statement
and closes a contract `CONTEXT.md` states twice. F3 and F4 are documentation edits. F6 and F7 are
follow-up tickets, best filed alongside D8's relocation.
