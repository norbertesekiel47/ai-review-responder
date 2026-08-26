# Spec & correctness review — `fix-967-post-purge-global-optout`

Reviewed: `git diff origin/main...HEAD` (3 commits) in
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-967-post-purge-global-optout`.
Read-only review. Nothing was fixed.

Inputs read in the prescribed order: `.feature/intake.json` →
`docs/reviews/fix-967-post-purge-global-optout/blast-radius.md` → `CONTEXT.md`
(**Solicitation lane**, **Suppression ledger**, **Suppression scope**,
**Normalized handle**) → `.claude/CLAUDE.md`.

`pnpm typecheck` is clean at HEAD.

---

## Findings

| Severity | File:line | Finding |
|---|---|---|
| HIGH | `worker/ingress/resend/solicitation-lane.ts:240` | The new `logger.warn` is the intake's designated detector for the open #965 investigation, but nothing observes it — and the change deliberately removes the one pager that did fire for this class. |
| MEDIUM | `worker/ingress/resend/solicitation-lane.ts:240` | The fallback logs "global opt-out written" from INSIDE `sql.begin`, breaking the post-commit-logging pattern this same file establishes at `:288–299`; a COMMIT failure emits `ledger_row_written: true` for a rolled-back row. |
| MEDIUM | `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:587` | The D9 amendment claims the `MIN(sent_at)` + `failed_at IS NULL` anchor "is the Reply lane's shipped semantic … so both lanes still agree". `worker/jobs/publisher/veto-window-gate.ts` has no `failed_at` predicate at all. |
| MEDIUM | `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts:934` | No fallback case feeds an un-normalized address, so nothing pins that `extractSoleRecipient` normalizes — the intake invariant naming `normalizeEmail` as the single owner is untested on the new path. |
| LOW | `worker/ingress/resend/solicitation-lane.ts:150` | `readRecipients` filters non-string/blank members BEFORE cardinality is measured, so a two-member `to` with one non-string reads as "exactly one" and writes the global row instead of throwing. |
| LOW | `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts:1237` | Two of the four `user_visible_behavior` bullets (`status='processed'`, the `ArchivalPoller` sweep) are unpinned — every new case bypasses `handleResendWebhook`. |
| LOW | `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts:272` | The `purgeContactChain` JSDoc is attached to `captureThrow`; `purgeContactChain` at `:298` is undocumented. |
| LOW | `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts:451` | `afterEach`/`afterAll` now issue an unscoped `DELETE … OR account_id IS NULL`, and `readUnattributedLedger` (`:261`) reads unscoped. Safe only because of `fileParallelism: false`. |
| LOW | `docs/superpowers/plans/fix-967-post-purge-global-optout-intake.json` | New file outside the six paths in `allowed_edit_surface`. |

---

## A. Correctness

### A1 — HIGH: the fallback's warn is the intake's own detector for #965, and nothing consumes it

`worker/ingress/resend/solicitation-lane.ts:240–248` emits:

```
logger.warn({ msg: 'solicitation webhook matched no outreach row — global opt-out written from the signed payload', … })
```

Intake `observability[0]` makes this line load-bearing:

> "A sustained rate means outreach rows are disappearing under live sends — the
> #965 class — so this line is also the detector for that open investigation."

That claim does not hold as built:

- `src/lib/shared/logger.ts` emits `warn` to `console.warn` only (one JSON line
  per call). There is no Sentry sink — `worker/sentry.ts` configures no console
  integration (grep for `integrations`/`captureConsole` returns nothing).
- No `HealthAlertPoller` check counts these. The eleven checks in
  `worker/background/pollers/health-alert/checks.ts` are `checkFailedOutboxByTopic`,
  `checkOldestPendingOutbox`, `checkStaleDispatching`, `checkOpenFlaggedResponses`,
  `checkZeroDeliveryNotifications`, `checkOwnerUnreachable`, `checkBacklogDepth`,
  `checkFailedInboundEvents`, `checkStalledSendBatches`,
  `checkSolicitationSendBreaker`, `checkWedgedClientRead`. None reads
  `solicitation_suppressions` at all, let alone null-account global rows.
- The one signal that DID fire is removed by this change on purpose.
  `checkFailedInboundEvents` (`checks.ts:277`) keys on `status = 'failed'`;
  intake `user_visible_behavior[2]` lists its silencing as a benefit.

Why this matters more than "one lost log alert": **#965 is not hypothetical or
rare.** `docs/runbooks/evidence/2026-08-24-solicitation-send-mode-staging-flip.md:353–364`
records it as a confirmed, reproduced, still-unfixed defect — a CSV re-upload
REPLACES `solicitation_contacts` rows and cascades their asks and outreach away
("batches A and A2 now have **zero children**"). Re-uploading a list is normal
owner behaviour, so the unattributed branch is a routine path, not the
purge/CAS-loss tail the design doc frames it as.

Concrete failure scenario:

1. Owner re-uploads their contact CSV mid-campaign (#965 cascade fires).
2. Every subsequent bounce/complaint for the previous batch's sends is
   unattributable.
3. The lane writes a permanent, no-expiry, cross-tenant `scope='global'`,
   `account_id NULL` opt-out and returns 200.
4. `solicitation_outreach.bounced_at` / `complained_at` are never stamped.
5. Nothing pages. Before this change, step 3 was a 503 and
   `checkFailedInboundEvents` raised an `error`-level finding within
   `failedWindowS`.

The ledger row itself is correct and the ticket's compliance goal is met — this
is a loss of signal, not of data, which is why it is HIGH and not BLOCKER. But
the intake's stated mitigation is a log line that reaches Railway stdout and
stops there, on the one code path a known-active bug drives.

### A2 — MEDIUM: the fallback logs inside the transaction, breaking this file's own pattern

`withAttribution`'s docstring (`solicitation-lane.ts:288–299`) is explicit that
the `Committed | null` return exists so logging happens after commit:

> "RETURNS a Committed value only on a COMMITTED write … That return value is
> what makes post-commit logging possible."

Every attributed path honours it — `recordBounce:458`, `recordComplaint:491`,
`recordProviderSuppressed:511`, `recordFailure:564` all log after
`withAttribution` resolves. `suppressWithoutAttribution` does not: its
`logger.warn` at `:240` runs inside the `sql.begin` callback, immediately after
the `recordSuppression` INSERT and before COMMIT.

Failure scenario: the INSERT succeeds, the log line is emitted with
`ledger_row_written: true`, and the COMMIT then fails (connection reset,
`statement_timeout` on COMMIT, admission-gate/PgBouncer connection loss — a live
class per the `#773 admission chokepoint` note). `sql.begin` rejects, the lane
throws, `worker/ingress/resend.ts:166` marks the event failed and returns 503,
and the operator's log claims a compliance opt-out was written for a row that was
rolled back. The lane's `ledger_row_written` field is documented at `:245–246` as
distinguishing "written" from "first-write-wins no-op" — it silently gains a
third, unrepresented meaning ("rolled back").

Note the rollback behaviour on the `extractSoleRecipient` throw path is
otherwise correct: the throw precedes any write, propagates out of the `begin`
callback, rolls back, and lands as a 503 through `resend.ts:164–176`. Verified.

### A3 — LOW: `readRecipients` changes cardinality before it is measured

`solicitation-lane.ts:150–152`:

```ts
return to.filter(
  (value): value is string => typeof value === 'string' && value.trim().length > 0,
);
```

`extractSoleRecipient:159–163` then states the rule as "EXACTLY ONE ADDRESS, OR
THROW … any other cardinality means the payload is not ours", and the intake
edge case reads "`data.to` carries two or more addresses → throw". But the filter
runs first, so `to: ["a@x.test", {email: "b@y.test"}]` or `to: ["a@x.test", null]`
measures as one recipient and writes the permanent global opt-out.

Harm is bounded — the surviving address IS a genuine recipient of that message,
so no third party is suppressed — which is why this is LOW rather than higher.
But the trigger is precisely a provider payload-shape change, the class the
"defensive read" exists to survive, and on that trigger the guard silently does
the opposite of what its docstring promises. `RECOGNISED_SOFT_BOUNCE_TYPES`
(`:389`) documents this exact reasoning for the sibling case ("did the provider
hand us a type we understand *at all*?"); the same question is not asked here.

### A4 — Verified correct (no finding)

Recorded because each was an explicit probe:

- **`recordSuppression` with `accountId: null`.** `analytics_events.account_id`
  is `UUID REFERENCES accounts(id) ON DELETE SET NULL` — nullable
  (`supabase/migrations/046_analytics_events.sql:27`). `enqueueAnalyticsEvent`
  falls back to `distinctId: row.id`. No constraint violation, no rollback.
  `solicitation_suppressions` has no `account_id NOT NULL` CHECK for global rows
  (`096_solicitation_suppressions.sql:76–86` — the pairing CHECK is
  one-directional) and has no `business_id` column, so G12 does not apply.
- **`suppressionMatchSql` honours the row.** Its global arm has no `account_id`
  predicate (`src/lib/solicitation/suppression.ts:86–89`), so a null-account
  global row suppresses the handle for every tenant. The opt-out is honoured —
  the ticket's core claim holds.
- **Purge verification is unaffected.** `src/lib/account-offboarding/purge-verification.ts:672–683`
  flags `scope='account' AND account_id = <acct>` or `scope='global' AND
  created_by_user_id IN (users of acct)`. A fallback row (global, null account,
  null creator) matches neither.
- **Idempotency.** Two different `provider_message_id`s for one handle →
  `ON CONFLICT (channel, normalized_handle) WHERE scope='global' DO NOTHING`,
  first-write-wins, `written === null` on the second. A redelivered svix id never
  reaches the lane (`claimInboundEvent` → `'duplicate'` → 200,
  `resend.ts:144–157`). A later ATTRIBUTED event for the same handle no-ops
  against the null-account row, so provenance is not retro-added — correct.
- **Redaction.** Both new throws (`:182–184`, `:188`) carry only a count and the
  `emailId`. The new warn carries `event`, `provider_message_id`, `source`,
  `ledger_row_written`. No address reaches a log line, an `Error.message`, or
  `inbound_events.error_message`. Verified by reading every new `logger.*` and
  `throw` in the diff.
- **The `to`-as-string path is fail-closed.** `"a@x.test, b@y.test"` (space) and
  `"a@x.test,b@y.test"` (two `@`) both fail `EMAIL_PLAUSIBLE`
  (`src/lib/solicitation/handles.ts:9`) → `null` → throw. No wrong single address
  from either.
- **The ArchivalPoller claim holds.** `worker/background/pollers/ArchivalPoller.ts:72–84`
  sweeps `inbound_events WHERE status = 'processed' AND processed_at < NOW() -
  INTERVAL '30 days'`, and `markInboundEventProcessed`
  (`worker/ingress/shared.ts:57–63`) sets both columns on the ack path
  (`resend.ts:163`). Intake `user_visible_behavior[3]` is accurate.
- **No retired-throw dependents.** `worker/ingress/__tests__/resend-solicitation-routing.test.ts`
  contains no `unmatched` / `rejects.toThrow` / `503` reference. The only other
  files naming the behaviour are `CONTEXT.md`, `purge-stages.ts`, the lane and
  its own suite — all updated in this diff. The three tests that DID depend on it
  (`:1130`, `:1237`, `:1306`) were each rewritten with a payload that carries no
  recipient, so they fail for the new reason rather than passing for the wrong one.
- **Tenant-scope audit is unaffected.** `scripts/ci/tenant-scope-allowlist.ts`
  keys on `file` + `table` + `sqlSnippet` (`:1032–1064`), not line numbers, and
  the lane's five SQL statements are byte-identical to `origin/main`.
- **Invariants.** #15: the lane still takes `sql: Sql` and never imports
  `@/lib/db/server`. #6: ingress unchanged. #2: no `job_outbox` surface is
  touched; `recordSuppression`'s analytics insert is durable in the same tx by
  §9.3 design. #8: the global scope is ecosystem-authored per the
  **Suppression scope** glossary entry, which explicitly legitimises it.

---

## B. Drift

### B1 — LOW: one changed path outside `allowed_edit_surface`

Changed paths vs the six declared:

| Path | Declared |
|---|---|
| `worker/ingress/resend/solicitation-lane.ts` | yes |
| `worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts` | yes |
| `worker/jobs/account-offboarding/purge-stages.ts` | yes |
| `CONTEXT.md` | yes |
| `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` | yes |
| `.claude/reference/arch-review-log.md` | yes |
| `docs/superpowers/plans/fix-967-post-purge-global-optout-intake.json` | **no** |

The last is the harness's intake copy, so this is bookkeeping rather than scope
creep — but it is a changed path the contract does not name.

### B2 — `tests_to_add`: all nine titles present verbatim

| Intake title | Line |
|---|---|
| an unattributed suppression-bearing event writes a global suppression row from the signed payload recipient and acks | `:934` |
| the payload-recipient fallback writes the global suppression row with a null account id | `:953` |
| a repeat unattributed suppression-bearing event for the same recipient writes at most one ledger row | `:970` |
| the solicitation lane never normalizes the provider-echoed recipient address when it has its own contact row | `:903` |
| an unattributed suppression-bearing event with no recipient address in the payload throws | `:990` |
| an unattributed suppression-bearing event carrying more than one recipient address throws | `:998` |
| an unattributed suppression-bearing event whose recipient address is unparseable throws | `:1017` |
| an unattributed soft bounce still warns and acks without writing a ledger row | `:1033` |
| the payload-recipient fallback never logs the recipient address | `:1054` |

### B3 — `edge_cases`: all nine handled; two unpinned

Every entry is implemented. Two have no test:

- "the seconds-wide race … the outreach `bounced_at`/`complained_at` stamp is
  NOT written" — the retitled `:1237` case exercises the never-committed id but
  asserts nothing about an outreach row (there is none to assert on).
- "A CAS-lost send … never persists `provider_message_id` at all" — same shape,
  same absence. Both are the same code path as the purged case, which IS pinned,
  so this is a documentation gap rather than a coverage hole.

### B4 — `user_visible_behavior`: two of four unpinned (see C5)

### B5 — no undeclared behaviour

I found no behaviour change in the diff that is not named in
`user_visible_behavior` or `edge_cases`. Notably, the §6.2 provider-suppressed
divergence warn (`:533`) is skipped on the unattributed path — but
`suppressWithoutAttribution` emits its own warn there, so no signal is silently
dropped, and the §6.2 line's specific claim ("Resend's team-wide list has
diverged from ours") would be unverifiable without attribution anyway.

---

## C. Test strength

### C1 — MEDIUM: normalization on the fallback path is not pinned

Every case that reaches `extractSoleRecipient` successfully feeds an address that
is ALREADY in normalized form:

- `:934`, `:953`, `:970`, `:1033`, `:1054` all use `seeded.handle`, which
  `seedOutreach` builds as `` `customer-${contactId}@example.test` `` (`:126`) —
  `randomUUID()` is lowercase hex, so the string is its own `normalizeEmail`
  output.
- `:1237` uses `'never-committed@example.test'` — likewise.

Consequence: replace `normalizeEmail(recipients[0]!)` at `:186` with any
plausibility-check-only helper that keeps the `null` throw (e.g.
`EMAIL_PLAUSIBLE.test(x) ? x : null`), and all nine cases stay green. Case `:1017`
catches total removal of the guard, but not the loss of lowercasing/trimming.

The failure that escapes is exactly the one `:165–173` says the code exists to
prevent: a payload echoing `Customer@Example.TEST` mints a ledger key that
`suppressionMatchSql` — comparing against `solicitation_contacts.email`, already
normalized — can never match, so the opt-out is written and honoured nowhere.
It is also the intake invariant "normalizeEmail … stays the single owner of email
normalization; the lane never re-spells it".

One case with a mixed-case `to` closes it. `:903` already owns the mixed-case
fixture (`'  SOMEONE.Else+tag@Example.TEST '`) — for the attributed path.

### C2 — Cases pinned by the behaviour they claim

- `:953` (null account id) — reads `account_id` off the row directly. Strong.
- `:970` (at most one row) — two DIFFERENT provider ids for one handle, so the
  ingress dedup key genuinely cannot help; only the ledger's `ON CONFLICT` can
  produce the asserted result. Strong. It is pinned by a collaborator
  (`recordSuppression`), but that collaborator IS the invariant under test
  ("recordSuppression stays the single chokepoint").
- `:1033` (soft bounce) — asserts the absence of a ledger row AND the presence of
  the `nothing written` warn, so it cannot pass by the fallback silently
  succeeding. Strong.
- `:1054` (redaction) — asserts the write happened, the fallback warn fired, and
  neither the full handle nor its local part appears in any captured line.
  `captureConsole` (`:319`) spies on `log`, `warn` and `error`, so the assertion
  covers all three sinks. Strong; the local-part assertion is the detail that
  makes it real.
- `:998`, `:1017` — use `captureThrow` rather than `rejects.toThrow` specifically
  to assert what the message must NOT contain. Strong.

### C3 — Cases with a soft edge

- `:934` (the headline case) asserts scope/channel/source/handle but not
  `account_id`. `:953` covers that separately, so the pair is complete; the
  headline case alone is weaker than its title implies.
- `:990`, `:998`, `:1017` seed nothing, so they exercise "no row was ever
  written" rather than "the purge deleted the row". Equivalent at the code level
  (`loadAttribution` returns `null` either way) — worth knowing, not a defect.

### C4 — LOW: `readUnattributedLedger` and the cleanup are unscoped

`readUnattributedLedger` (`:261–270`) reads `WHERE account_id IS NULL` across the
whole table, and `afterEach` (`:451`, `:458`) / `afterAll` (`:479`) now DELETE
`WHERE account_id = <acct> OR account_id IS NULL`. The docstring defends the
read ("the suite holds the cross-process live-DB advisory lock, so no concurrent
writer exists").

That is true today for a reason the comment does not name:
`vitest.config.ts:101` sets `fileParallelism: false` on the `integration`
project, and `groupOrder` keeps the parallel project from overlapping it. The
fragility is ordering, not concurrency: `recordAdminManualSuppression`
(`src/lib/admin/suppressions-service.ts:180`) writes exactly the shape this
predicate matches — `scope: 'global'`, `accountId: null`, `source:
'admin_manual'`. Any suite that leaves one behind and runs BEFORE this one turns
`:995`, `:1014`, `:1030` and `:1050` red for a reason none of those cases is
about; and this suite's `afterAll` deletes such a row on its way out. Neither
direction is a correctness bug in production code — LOW.

### C5 — LOW: the ack's `status='processed'` is asserted nowhere

All nine new cases call `handleSolicitationResendEvent` directly. The suite's two
ingress-level cases (`:1130` 503-retry, `:1183` duplicate svix id) drive the real
`handleResendWebhook`, and `:1130` asserts `inbound_events.status` after the
failure. There is no ack-side twin, so intake `user_visible_behavior[2]`
("lands `status='processed'`") and `[3]` (the `ArchivalPoller` sweep) rest on
inspection alone. I verified both hold in code (`resend.ts:163`,
`shared.ts:57–63`, `ArchivalPoller.ts:72–84`), but the suite already has the
scaffolding for the assertion and does not make it.

### C6 — LOW: a misattached JSDoc

`:272–279` is the `purgeContactChain` docstring ("The account purge's cascade,
reproduced at the step that matters (#967)"). A second docstring (`:280–286`,
for `captureThrow`) follows it, then `captureThrow` is declared at `:287`. So the
first block documents `captureThrow`, and `purgeContactChain` at `:298` — the
fixture that actually carries the #967 assumption, including its FK-drift guard —
is undocumented.

---

## D. Doc truth

### D1 — `CONTEXT.md` **Solicitation lane** rewrite — accurate

Checked clause by clause against the code:

| Claim | Verdict |
|---|---|
| suppression-bearing events "write the recipient's global opt-out from the SIGNED payload and ack" | `:337–338` — matches |
| soft bounces and `email.failed` "warn and ack" | `recordBounce:435` (`isHard ? … : {kind:'ignore'}`), `recordFailure:551` — matches |
| "an account purge deletes the `solicitation_contacts` row `loadAttribution` joins" | `purge-stages.ts` cascade; `loadAttribution:85–92` INNER JOINs `solicitation_contacts` — matches |
| "a send whose terminal CAS lost never persisted a `provider_message_id` at all" | consistent with `dispatch.ts` `commitSendTerminal` — matches |
| "normalizes the echoed recipient through the one owner (`normalizeEmail`) and writes `accountId: null`" | `:186`, `:236` — matches |
| "Exactly one address in `to`, or throw" | `:181` — matches as written, but see A3 for the filter that runs first |
| "the ledger row is still right but the outreach `bounced_at`/`complained_at` stamp is lost" | the unmatched branch returns before `apply` — matches |
| "bounded only by `ArchivalPoller`'s 30-day sweep of `processed` rows" | `ArchivalPoller.ts:72–84` — matches |
| "Never normalize the echo while attribution exists" | `data` is read only inside the `!attribution` branch — matches |
| coined-in footnote updated to "unmatched-attribution rule re-anchored at #967" | present |

The only clause I would qualify is "Exactly one address in `to`, or throw", which
is what the code intends but not quite what it does (A3).

### D2 — `purge-stages.ts` KNOWN GAP → CLOSED — accurate

`:832–844`. Both consequences it names for the retained count are true:
`finalizePurgeInTransaction`'s count (`:845–849`) filters `scope='global' AND
account_id = <acct>`, so a null-account row is invisible to it, and the row is
written by a later webhook, outside that transaction. The "CLOSED" claim itself
is correct for the recipient class it names — the lane now writes the global row
for a post-purge suppression-bearing event.

### D3 — MEDIUM: the D9 amendment misstates the Reply lane

`docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md:581–591`.

Verified against `anchorVetoDeadlines` (`src/lib/solicitation/auto-approval.ts`):
the CAS at `:608–626` computes `MIN(nd.sent_at)` over
`template = 'solicitation_veto_notice' AND sent_at IS NOT NULL AND failed_at IS
NULL`. The amendment describes that correctly, and the accompanying code comment
at `:599–607` says the same thing. The `MIN(sent_at)`-not-`delivered_at` claim,
the Telegram rationale and the fail-closed sentence are all accurate.

What is wrong is `:587–590`:

> "This is the Reply lane's shipped semantic
> (`worker/jobs/publisher/veto-window-gate.ts`), so both lanes still agree; the
> `failed_at` arm is what keeps a provider-accepted-then-bounced notice from
> starting a clock the owner never saw."

`worker/jobs/publisher/veto-window-gate.ts:82–91` is:

```sql
SELECT MIN(nd.sent_at) AS first_sent, NOW() AS db_now
FROM notification_deliveries nd
WHERE nd.response_id = ${responseId}
  AND nd.business_id = ${businessId}
  AND nd.template = 'pending_post_notice'
  AND nd.sent_at IS NOT NULL
```

`grep -n failed_at worker/jobs/publisher/veto-window-gate.ts` returns nothing.
The two lanes agree on `MIN(sent_at)`; the `failed_at IS NULL` arm exists only in
the solicitation lane. The sentence as written tells a future reader that the
Reply lane already excludes failed notices, which it does not — and it does so in
the same breath that explains why that arm is load-bearing. Either the sentence
should name the divergence, or the Reply lane is missing the arm; the doc as
written asserts neither.

### D4 — `.claude/reference/arch-review-log.md` row — consistent

The 2026-08-26 row restates D1/D2's content plus the estimate correction. Nothing
in it contradicts the code. Not independently verified beyond the claims already
checked above.

---

## Appendix — low confidence / "would be nicer"

Not claimed at ≥80%; recorded so the next reader does not re-derive them.

1. **Does Resend's `email.suppressed` payload carry `to`?** I could not verify
   the provider's payload shape for this event from the repo or from pinned
   docs. `email.bounced` and `email.complained` demonstrably do. If
   `email.suppressed` does not, the `provider_suppressed` arm of the fallback
   always throws → 503 → retry until the 300s svix window 401s it. That is not a
   regression (it threw before too), but one third of the fix would be inert and
   the `checkFailedInboundEvents` silencing would be partial. A staging capture
   of one real `email.suppressed` payload would settle it.

2. **Display-name forms slip through `normalizeEmail`.** `Foo<foo@bar.test>`
   (no whitespace, one `@`, a dot after the `@`) passes `EMAIL_PLAUSIBLE` and
   normalizes to `foo<foo@bar.test>` — an unmatchable ledger key. Resend echoes
   bare addresses in `to`, so I do not believe this is reachable; noting it
   because the fallback is the first place a provider-echoed address becomes a
   ledger key rather than being compared to a stored one.

3. **The Send-breaker under-count is narrower than the docs imply.** The
   accepted-cost text (lane `:211–219`, `CONTEXT.md`, the arch-review row) says
   the breaker "undercounts one bounce". For the #965 and post-purge cases the
   outreach row is GONE, so the breaker's denominator (`sent_at` in window) drops
   with the numerator and the ratio is roughly preserved. The genuine fail-open
   is only the #630 race, where the row exists with `sent_at` set and no
   `provider_message_id`. Not a defect — the docs are conservative in the right
   direction — but the framing overstates a governor risk that is smaller than it
   reads.

4. **`suppressWithoutAttribution` could stamp the outreach row when one exists
   without a `provider_message_id`.** In the #630 race the row IS findable by
   `(account, batch, contact)` and the stamp could be recovered. This was an
   explicit owner decision to accept the loss, so it is out of scope — recorded
   only because the accepted-cost text does not say the alternative was
   considered.

5. **`isRecord` returns true for arrays** (`:61–63`, inherited verbatim from
   `bounce-classifier.ts:31–33`). `readRecipients` on an array-valued `data`
   would read `data.to` as `undefined` and return `[]` → throw. Fail-closed, and
   pre-existing.
