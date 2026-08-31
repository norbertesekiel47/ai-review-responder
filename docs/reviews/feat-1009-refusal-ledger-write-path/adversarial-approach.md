# Adversarial approach review — `feat/1009-refusal-ledger-write-path`

Review axis: **APPROACH only** — design shape, ownership, failure posture, and
operational assumptions. This report deliberately does not duplicate the
spec/correctness or standards/maintainability axes.

Reviewed from the fixed fork point with:

```text
git diff 0494297a0de3a9131fae1e6f2f641eb487ae7a58...05e52e3ff1738538b900f9fe6ec13a3df12abff7
```

Required context read before forming findings: `.feature/intake.json`, plan §1
and §5b/§5c/§5d (plus the failure/flag/caller sections needed to evaluate the
questions), all eighteen accepted deviations, immutable migration 116, and the
four locked Refusal-ledger terms in `CONTEXT.md`.

## Findings

Only approach-level findings held at **≥80% confidence** appear here.

| severity | file:line-or-area | one-line finding |
|---|---|---|
| high | `src/lib/refusals/write.ts:83-110` | The generic cross-product input leaves C1–C5-invalid states expressible at eleven callers even though such a mistake aborts the primary deciding transaction. |
| high | `src/lib/refusals/write.ts:117-179` | The only ledger-gap signal latches on synchronous Sentry capture, but the installed SDK returns before delivery and swallows transport failures, so the claimed cooldown retry and “successful capture” guarantee do not exist in production. |

### A-01 — The helper should own one statement, but its public input should not expose the full invalid cross-product

`WriteRefusalEventInput` independently accepts `businessId`, `refusalSource`,
`refusalCode`, `allRefusalCodes`, `refusalCategory`, `subjectType`, and
`subjectId`. The comments describe C1–C5, but the type permits, among many
others, a subject-bearing `autonomy_suspended`, a coded `held_draft`, a
locationless non-suspension, and a `policy_gate_held` row without its code set.
The first caller demonstrates the resulting burden: it must correctly assemble
nine fields whose legal combinations are explained across roughly thirty lines
of call-site commentary (`src/lib/auto-approval/suspension.ts:317-347`). Ten more
callers are planned.

The plan's reason for rejecting a discriminated union conflates two different
authorities. Migration 116 must remain the storage authority and must retain all
five CHECKs, because TypeScript cannot protect SQL written by another process or
an operational query. That does not require the TypeScript API to accept states
known to be illegal. The application already duplicates these relationships at
every object literal; a union or lane-specific builder would centralize that
knowledge once rather than distribute it eleven times. This does **not** contest
#1001's decision that one helper owns the whole INSERT or its byte-for-byte
partial-index predicate.

The consequence is architectural, not cosmetic. `write.ts:27-41` deliberately
propagates a CHECK failure, and the live-DB failure test proves that such a
mistake rolls back the suspension policy, audit row, and both notice outbox
rows. The current API therefore makes an avoidable compile-time modeling gap a
primary-action availability risk.

**Action:** revisit the locked plan's rejected-union decision before adding the
next ten callers. Keep one private whole-statement writer and all database
CHECKs, but expose either (a) a discriminated input union whose arms encode the
lane/subject/code/nullability shape, or (b) lane-specific constructors/builders
that return a private storage input. Category maps and the database constraints
can keep their existing owners; the API only needs to make each caller's legal
shape explicit.

### A-02 — The Sentry cooldown retries a test double behavior, not real delivery

The implementation calls `Sentry.captureMessage`, sets `warned = true` as soon
as that synchronous call returns, and schedules a retry only if that call
throws (`write.ts:161-179`). The tests model a network failure by making
`captureMessage` throw synchronously (`write.test.ts:218-231,266-304`). The
installed `@sentry/node` 10.55.0 implementation has different semantics:

- `@sentry/core/build/cjs/scope.js:503-521` returns an event id immediately;
  it even returns an id when no client is configured.
- `@sentry/core/build/cjs/client.js:161-173` places event processing into an
  internal promise buffer and immediately returns the event id.
- `client.js:334-345` sends the envelope asynchronously.
- `client.js:406-417` catches a rejected transport send internally and returns
  an empty result rather than throwing back through `captureMessage`.

Therefore a DSN/transport/network failure can occur after this code has declared
the warning successful and permanently set the process latch. The five-minute
cooldown only handles unusual synchronous SDK/programming failures; it does not
retry the delivery failure that the three plan-review rounds were trying to
survive. The structured log provides a second transport, but it is emitted only
on the same first attempt and is not an implemented reconciliation mechanism.
The intake's proposed count comparison exists only as prose: repository search
finds no production query, poller, runbook, or alert that executes it. A later
`false → true → false` episode in the same process is also silent because the
latch never resets when the flag becomes enabled.

This matters more than an ordinary telemetry defect because the contract calls
this warning the **only** evidence of a ledger gap, while some future lanes are
not reconstructible by design. Once missing, their rows cannot be recovered by
the ledger or by the no-backfill policy.

**Action:** replace “capture returned” as the success criterion with an
operationally durable design before more lanes adopt the helper. At minimum,
provide an ongoing current-state signal while the flag is off and a per-lane
counter of skipped writes; operationalize reconciliation for the lanes that do
have an independent durable fact. If Sentry remains one transport, do not claim
delivery retry from `captureMessage` without an acknowledged SDK hook/flush
result, and make disabled episodes—not process lifetime—the rate-limit unit.

## Map-level questions

These challenge decisions owned by map #994 or its already-closed tickets and
are intentionally **not** standard findings in the table.

### M-01 — Should a ledger writer bug be allowed to prevent a safety action?

The current rule makes refusal integrity atomic with the action, so a CHECK
violation prevents an autonomy suspension (`src/lib/refusals/write.ts:27-41`;
`src/lib/auto-approval/suspension.ts:317-347`). The kill switch is reactive: it
helps only after an operator receives the incident, diagnoses it, and flips the
flag. In the Governor path, the bad account remains unsuspended and is revisited
on a later scheduler cycle; in the Judge path, the worker retries and can
terminally fail. This trades availability of a safety control for completeness
of an owner-facing historical ledger.

That trade may be deliberate, but the actual code makes its blast radius
concrete enough to merit a map-level recheck before the remaining lanes land.
An alternative worth evaluating is atomically recording a durable refusal
*intent* (with the decision timestamp) beside the primary action and projecting
it to the constrained ledger through a retryable path. That preserves evidence
of the decision without allowing a projection/schema mismatch to veto the
safety action. If same-transaction ledger insertion remains locked, the map
should explicitly accept the maximum time a safety action may remain undone
while waiting for operator mitigation.

### M-02 — Will one global kill switch remain acceptable once seven lanes are live?

Checking the switch inside the helper is the correct placement for the present
guarantee: no caller can forget it, and the current single lane has no legitimate
opt-out. The future failure domain is different. A malformed writer in one lane
would force operators to choose between leaving that lane's primary actions
broken and disabling healthy ledger writes in all six other lanes. Because the
helper already receives `refusalSource`, adding lane-aware quarantine later is
not structurally difficult, but the decision should be made before operators
need it during an incident—not after all callers depend on global-only
semantics. This is a map-level scope question, not a recommendation to let call
sites bypass the central switch.

## Independent judgments on the remaining challenged axes

### Vocabulary split

No ≥80%-confidence finding. The shipped module is coherent today: it owns the
three storage vocabularies and the version, then adds exactly the one map with a
production caller. The remaining maps are intended to enter the same module as
their lanes ship, so this is incremental completion of one module rather than
six separate half-modules. Shipping unused maps now would create dead code and
front-run the tickets that own those lane decisions.

### First write site

No ≥80%-confidence finding. `autonomy_suspended` is the least representative
lane for the partial unique index because its subject is always NULL, but the
helper's live-DB suite directly exercises both a duplicate non-null subject and
the NULL-subject behavior through the exact production INSERT. Choosing the
quiet lane lowers rollout risk without leaving the central SQL mechanic wholly
untested. The selection is also owned upstream by closed ticket #1004, so any
objection would be map-level rather than a standard branch finding.

### Scheduler Sentry sink

No ≥80%-confidence finding. The asymmetry is real, but the boundary-specific
placement is sound: BullMQ failures belong to the terminal worker sink, while a
failure deliberately swallowed by a scheduler's per-candidate containment must
be reported at that containment boundary. Moving capture into
`suspendAccountAutonomy` would either double-report the BullMQ caller or force a
shared domain helper to understand two execution frameworks. The scheduler
patch also correctly covers non-ledger failures swallowed by the same catch.
Finding A-02 applies to Sentry delivery generally, but it does not make this
boundary choice wrong.

## Low-confidence appendix

### LC-01 — Production proving value of the first lane is limited (confidence: ~65%)

The only production caller in this slice can never exercise the helper's partial
unique-index conflict path because `subject_id` is NULL. The live-DB helper test
is strong enough that this is not an actionable finding, but the next
subject-bearing lane should carry explicit staging evidence of a duplicate
decision reaching `DO NOTHING` without poisoning its real deciding transaction.
That would test the integration conditions this intentionally quiet first lane
cannot provide.

