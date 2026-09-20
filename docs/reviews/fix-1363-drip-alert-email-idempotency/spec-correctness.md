# Review — SPEC & CORRECTNESS axis · `fix/1363-drip-alert-email-idempotency`

Fixed fork: `10377aa9bc8db7be9f7af1fdd2c5418ba81fabe9` → `1b9fe88defa385bcab743817002ee967e54fe727`.
Read-only review. No repository file was edited.

Contract read: intake JSON, plan, deviations (D1–D7, all ACCEPT), blast-radius,
`.claude/CLAUDE.md`, `.claude/rules/worker-layout.md`, both finding checklists.

Verification actually run in this worktree:

| Command | Result |
|---|---|
| `pnpm ci:weakened-checks` | `passed (no finding)` — zero FAIL rows, zero REVIEW rows |
| `pnpm vitest run` on the four changed suites | 4 files, **72 passed** |
| `pnpm ci:directory-map` | passed (631 files, no stale rows) |

---

## 1. Weakened checks — mandatory section

`pnpm ci:weakened-checks` printed **no REVIEW rows at all**, so there is no row to
adjudicate. I confirmed that independently against the diff, because a silent
"no finding" is itself the thing worth checking:

- **No test file deleted.** `git diff --stat` shows four test files, all `+` only
  except two `revokeMode: 'orphaned_only'` → `'never'` string swaps in existing
  assertions (`worker/jobs/__tests__/OnboardingDripWorker.test.ts:334,337`,
  `worker/jobs/__tests__/EngagementAlertWorker.test.ts:494-497`). Those swaps
  track a deliberate behaviour change, not a relaxed assertion — the assertion
  is just as strict, on the new value.
- **No suite lost `expect(` calls.** All four test files gained assertions
  (+95, +98, +179, +155 lines).
- **No suppression comment, no `.skip`/`.only`, no `DIFF_COVERAGE_MIN` change,
  no quality-config change, no stub/TODO in production code.**

**Can the new tests pass while the promised behaviour is wrong?** I mutation-reasoned
each load-bearing assertion:

| Promised behaviour | Mutant | Dies? |
|---|---|---|
| `'never'` skips the revoke | rewrite `revokeMode === 'orphaned_only'` as `revokeMode !== 'always'` | **Yes** — `create-link.test.ts:29` (`updateCalls()` would become 1, because the harness returns `undefined` for the unqueued probe ⇒ `shouldRevoke = true`) |
| `'never'` skips the probe | add a probe before the branch | **Yes** — `create-link.test.ts:35-38` |
| `'never'` is not the default | change `params.revokeMode ?? 'orphaned_only'` to `?? 'never'` | **Yes** — `create-link.test.ts:85-102` |
| The replay guard requires a key | drop `&& params.idempotencyKey` | **Yes** — `internal.test.ts:251-257` |
| The sentinel wire format | change `IDEMPOTENT_REPLAY_PREFIX` | **Yes** — the tests assert the literal, not the constant (deliberate, and correct: the operator SQL depends on the wire format) |
| The drip key is domain-scoped | re-scope the drip key to `outboxId` | **Yes** — `OnboardingDripWorker.test.ts:822-850` compares the two attempts' keys for equality |
| The satisfaction branch stays mark-before-send | move `markOutboxCompleted` after the send | **Yes** — `EngagementAlertWorker.test.ts:698` asserts `callOrder` |

That is a genuinely mutation-resistant set. The three replay tests are pins
rather than drivers (D3 says so honestly), and they earn their place.

**Trust-boundary negative tests.** `src/lib/approval/create-link.ts` is the only
file crossing one (invariant #5 / the `approval-security` skill).
- *Raw token never persisted* — covered (`create-link.test.ts:41-59`: 64-char
  hash, hash ≠ raw, raw in no `values` and no `text` of any call).
- *Replayed / stale input* — `revokeMode: 'never'` does not touch consumption,
  expiry or revocation of an existing link; `locks.ts:48,168` still reject a
  revoked link and `locks.ts:92,107` (`revokeSiblings` / `revokeOpenLinksForResponse`)
  are untouched, so the docstring claim "Regenerate still revokes every outstanding
  link and does not come here" holds.
- *Wrong tenant / missing authorization* — not applicable at this seam:
  `createApprovalLink` is a worker-internal mint with no caller-supplied identity;
  authorization lives at `/approve/[token]`, which this branch does not touch.

**Compromises the review record does not already name.** Four, all written up
below as F2, F3, F4, F5. The record names the 24-hour key expiry (intake
`edge_cases[3]`, arch-review-log "Named residual") and the extra live link
(bounded, though with the wrong bound). It does not name: the loss of Resend
message-id attribution on a replay, the behaviour change inherited by three
pre-existing keyed callers, the true link-accumulation bound, or the fact that
the `orphaned_only` probe is response-scoped rather than sender-scoped.

---

## 2. The five load-bearing claims I was asked to verify

**(1) Drip key scope — the stale-claim takeover reason is TRUE, and the mixed
shape is defensible.** I verified the second-outbox-row path end to end rather
than accepting D1: `OnboardingDripScheduler.ts:166-177` excludes a pair only when
`onboarding_drip_log` has `sent_at IS NOT NULL OR skipped_at IS NOT NULL`, or
when a **non-`failed`** outbox row exists. A claimed-but-unsent row satisfies
neither exclusion, so once the first outbox row terminalizes to `failed`, the
scheduler mints a **second** row for the same pair; that row's handler hits the
`ON CONFLICT DO NOTHING` at `OnboardingDripWorker.ts:214-219` and then takes the
claim over at `:227-237` (`sent_at IS NULL AND claimed_at < NOW() - 15 min`).
Two rows, two ids — an outbox-scoped key genuinely could not dedupe them.
`(business_id, drip_type)` mirrors the `onboarding_drip_log` UNIQUE constraint
and does. The mixed shape creates no key collision (distinct prefixes across all
nine keyed send sites) and no functional defect I could find; see F5 for the one
inaccurate sentence it produced in the glossary.

**(2) Synthetic message id downstream — this DOES break a reader.** See **F2**.
`worker/ingress/resend.ts:203`, `:209` and `:233` all key on
`external_message_id = ${emailId}`. `NotificationFailoverPoller` writes
`external_message_id` (`:195`) but never reads it, and the Twilio path is
channel-scoped to non-email, so Resend ingress is the single affected reader —
and it is the one that owns hard-bounce flagging for owner-directed templates.

**(3) `revokeMode: 'never'` cannot leak.** Verified: the only two other call
sites, `worker/jobs/notification/dispatch.ts:255-259` and
`worker/jobs/pending-post-notice/dispatch.ts:162-166`, pass **no** `revokeMode`
at all, so they take the `?? 'orphaned_only'` default at `create-link.ts:54`,
and `create-link.test.ts:85-102` now pins that default. The 48h TTL is real
(`create-link.ts:106`) and `revokeSiblings` on consume (`token-mode.ts:141,175`)
collapses the surviving siblings the moment the owner clicks one — but the
stated *bound* on how many extra links exist before that is wrong; see **F4**.

**(4) The satisfaction branch genuinely needs no key.** Verified:
`EngagementAlertWorker.ts:431` marks the outbox completed, `:433` then sends.
A crash in that gap loses one internal alert and cannot duplicate it, because
no retry is ever dispatched. Passing no key is correct, and
`EngagementAlertWorker.test.ts:674-703` pins both halves (ordering **and** the
absent key), which is the right shape — a future reordering would have to
delete an assertion to land.

**(5) 24h key expiry vs. retry/watchdog cadence — the mechanism is bounded, but
the recorded justification is wrong for the one path the drip key exists for.**
See **F6**. Numbers I resolved rather than assumed: BullMQ `attempts: 3` with
5s exponential backoff (`worker/queues.ts:39-40`); watchdog reclaim
`OUTBOX_WATCHDOG_STALE_MS` default **900_000 ms** (`OutboxPoller.ts:69-72`),
re-pending with `available_at = NOW()` (no additional backoff);
`job_outbox.max_attempts` default **5** (`001_initial_schema.sql:313`).
Same-outbox-row retries therefore all land inside ~75 minutes — comfortably
inside 24h, so the key holds for the path the *issue* names.

---

## 3. Findings (≥80% confidence)

### F1 — [medium] The `orphaned_only` probe is response-scoped, not sender-scoped: "can never see it / ALWAYS reads orphan" is false in the common case

**File:** `src/lib/approval/create-link.ts:19-23` (module docstring — permanent),
repeated verbatim at `worker/jobs/OnboardingDripWorker.ts:431-435`,
`worker/jobs/EngagementAlertWorker.ts:176-181`,
`src/lib/approval/__tests__/create-link.test.ts:11-16`,
`docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-deviations.md:35-38` (D2),
`docs/context/core-platform-runtime.md:21`, and the arch-review-log row.

**Contract field violated:** intake `invariants` ("Regenerate still revokes …
`revokeMode 'never'` does not weaken that path" is fine; the *justification*
recorded for the change is not) and the checklist class *"a permanent comment
states something the code does not do"* — the single most-repeated accepted
finding in `spec-correctness.md` (e.g. the `feat/safety-review-auto-approval`
rows at 2026-09-18, `feat/1086` at 2026-09-03).

**Evidence.** The probe at `create-link.ts:80-87` is:

```sql
SELECT id FROM notification_deliveries
WHERE response_id = ${responseId}      -- the RESPONSE, not the sender
  AND channel     = ${channel}
  AND template IN ('approval_request', 'pending_post_notice')
  AND sent_at IS NOT NULL
```

It asks *"has any link-carrying delivery for this response gone out on this
channel?"* — not *"has this sender's own delivery gone out?"* Both drip and
nudge target `resp.status = 'pending_approval'` rows
(`OnboardingDripWorker.ts:418`, `EngagementAlertWorker.ts:155`), and such a row
normally already carries an `approval_request` delivery on the email channel:
`insertPendingApprovalDelivery` (`src/lib/notifications/delivery.ts:357-373`)
inserts it with the response's `response_id`, the dispatch channel, and the
literal template `'approval_request'`, and `finalizeDeliverySent`
(`delivery.ts:391-397`) sets `sent_at = NOW()`. The probe therefore **matches**,
`shouldRevoke` stays `false`, and `orphaned_only` already did not revoke.

The stated bug is real only in the residual cases: the owner is enrolled on a
non-email channel (the probe is channel-scoped, so a Telegram/WhatsApp
`approval_request` does not satisfy an `email` probe), or the approval
notification failed / was held (`insertFailedDelivery` leaves `sent_at` NULL),
or the response reached `pending_approval` without a dispatched notification.

**Failure scenario.** A maintainer reads `create-link.ts:19-23` — a module
docstring, the most durable place in the change — and takes as given that the
probe cannot fire for a per-business sender. The two obvious follow-on moves are
both wrong: deleting the probe as "dead for these senders" (it is not; it is the
only reason the *other* two call sites do not revoke a delivered veto notice,
which `veto.ts`'s `already_cancelled` invariant depends on), or, in an incident
review, concluding that *every* drip/nudge retry revoked a delivered link and
sizing owner impact from that.

**Note:** the code change itself is still correct — `'never'` is a superset of
what `orphaned_only` did here, exactly as intake `edge_cases[8]` says. Only the
recorded reason is overstated. The fix is to narrow the claim to what is true
("the probe cannot see *this sender's own* delivery, so whenever the response
has no link-carrying **email** delivery — non-email enrollment, a failed or held
approval notification — it reads orphan and the retry revoked a delivered link").

---

### F2 — [medium] An idempotent replay discards the Resend message id, so bounce / delivered / complaint webhooks can never match the delivery row

**File:** `src/lib/notifications/email/templates/internal.ts:122-125` (writes the
sentinel) → `worker/jobs/OnboardingDripWorker.ts:318` and
`worker/jobs/EngagementAlertWorker.ts:233` (persist it) → broken at
`worker/ingress/resend.ts:233`.

**Contract field violated:** intake `non_goals` / `edge_cases` — this compromise
is named nowhere. `edge_cases[10]` names only that the replay "records
`idempotent-replay:<key>`"; neither it nor `observability` nor the deviations
file records that the row is now invisible to Resend ingress. Checklist class:
*"intake edge case unmet AND unrecorded"* (`feat/1086`, 2026-09-03).

**Evidence.** All three Resend event handlers key on the provider id:

```
resend.ts:203  UPDATE notification_deliveries SET delivered_at = NOW() WHERE external_message_id = ${emailId}
resend.ts:209  UPDATE … failure_reason = 'complained'                  WHERE external_message_id = ${emailId}
resend.ts:233  SELECT business_id, template FROM notification_deliveries WHERE external_message_id = ${emailId}
```

On a replay the only row that exists for that email carries
`idempotent-replay:onboarding_drip_day_7:<business_id>`. Both affected templates
are **owner-directed** by `resend.ts:266-272`: `'owner_nudge'` is in
`OWNER_DIRECTED_TEMPLATES` and `isOwnerDirectedTemplate` returns true for any
`onboarding_drip_*`. So this lands squarely on the owner-bounce path, not an
admin one.

**Failure scenario.** Day-7 drip, attempt 1: Resend accepts, the worker is
SIGKILLed before `UPDATE onboarding_drip_log SET sent_at`. Attempt 2 (≈15 min
later, watchdog) replays; `OnboardingDripWorker.ts:312-319` records
`external_message_id = 'idempotent-replay:onboarding_drip_day_7:<biz>'`. The
owner's mailbox is dead, so Resend fires `email.bounced` with the *real*
`email_id`. `handleEmailBounced` (`resend.ts:219`) finds no row, so
`delivery?.business_id` is `undefined` and `resend.ts:245` returns early:
`businesses.owner_email_bounced` is never set and `sendHardBounceAlert` never
fires. The owner keeps receiving approval emails, nudges and drips into a dead
mailbox, and no admin is told. **Before this branch**, attempt 2 sent a second
copy carrying a real message id, and that copy's bounce flagged the business —
so this is a regression on the bounce path, traded for the duplicate-suppression
win.

Minimum acceptable close: record it as a deviation with the reasoning (the
delivery/bounce signal for one email is worth less than a duplicate email), or
carry the real id forward — the cheapest version being that the replay branch
could log/record `external_message_id` as NULL rather than a sentinel that
*looks* like an id, since `notification_deliveries.external_message_id` is
nullable (`001_initial_schema.sql:341`) and the partial index at
`019_notification_delivery_bounce_indexes.sql:12-14` already excludes NULLs.
Either way it must stop being unrecorded.

---

### F3 — [low] Three pre-existing keyed callers silently inherit the new 409-as-success classification; the plan says they are "unaffected" and the blast-radius doc cannot see them

**File:** `src/lib/notifications/email/templates/internal.ts:120`
(module-level, so all 11 call sites inherit it);
`docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-plan.md:72-73`;
`docs/reviews/fix-1363-drip-alert-email-idempotency/blast-radius.md:12-16`.

**Contract field violated:** the plan's T1 "Interface change" claim, and the
blast-radius artifact's purpose.

**Evidence.** The blast-radius doc lists **4 importers** of `internal.ts`
(`contact-notify.ts`, `email.ts`, two tests). That is a one-hop resolved-specifier
search, and `src/lib/notifications/email.ts:18` is a barrel
(`export * from './email/templates/internal'`), so every worker call site is
hidden behind it. `rg` finds **11** `sendInternalEmail` call sites, and three
groups already pass an `idempotencyKey` **before** this branch:

- `worker/jobs/AutonomyAdminAlertWorker.ts:60` — `autonomy_admin_alert:<suspension_event_id>`
- `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts:314` — `emailSendIdempotencyKey(deliveryId)`
- `worker/background/pollers/NotificationFailoverPoller.ts:375, :463, :588` — `admin-alert:<claimId>`

For all three, a 409 `invalid_idempotent_request` previously **threw**; it now
returns success with a sentinel id. The plan's "The ten existing callers
destructure `messageId` only and are unaffected" is true of the *type* and false
of the *behaviour*.

**Failure scenario (bounded, which is why this is low).** I checked each body
for determinism rather than asserting risk: the offboarding token is a
deterministic HMAC of `(accountOffboardingId, deliveryId)`
(`src/lib/account-offboarding/tokens.ts:24-26`), and the failover alert bodies
are built from stable row fields — so a same-key/different-body 409 is not
reachable at those sites today. The exposure is that nothing pins it. If any of
those bodies ever gains a per-attempt value, the offboarding worker's rollback
block (`AccountOffboardingEmailWorker.ts:317-348`, which deletes a
freshly-minted keep-my-data token and the pending delivery row) would stop
running, because it is a `catch` and the send no longer throws — leaving a live
keep-my-data token for an email the owner never received.

---

### F4 — [low] "At most one extra live link per response" is quantitatively wrong; the real bound is up to ~15 per response

**File:** `src/lib/approval/create-link.ts:26-27` (module docstring), intake
`invariants[5]`, deviations D2 (`:43-44`), the arch-review-log row.

**Contract field violated:** intake `invariants` — "revokeMode 'never' leaves at
most one extra live link per response and it expires on its own".

**Evidence.** With `'never'`, `create-link.ts:91-100` never runs and
`:102-108` inserts unconditionally, so each *handler invocation* that reaches
the link loop mints one fresh 48h link per pending response. Invocations per
outbox row: BullMQ `attempts: 3` (`worker/queues.ts:39`) × up to 5 outbox
dispatches (`job_outbox.max_attempts` default 5,
`001_initial_schema.sql:313`, re-pended by the watchdog at
`OutboxPoller.ts:111-120`) ⇒ up to 15 live links for one response inside the
48h window. For the owner nudge, which loops over up to 10 pending responses
(`EngagementAlertWorker.ts:157`), that is up to 150 live `approval_links` rows
per business per nudge cycle.

**Why it is only low.** The security exposure does not scale with the count —
each token is a `randomUUID()` stored as SHA-256 (`create-link.ts:51-52`), never
delivered for the undelivered ones, and `revokeSiblings`
(`src/lib/approval/locks.ts:92-101`, called from `token-mode.ts:141,175`)
revokes every sibling the moment the owner consumes any one link. The finding is
that an *invariant* recorded in three durable places states a bound the code does
not enforce, and a future reader sizing this surface ("one extra link, fine")
would be off by an order of magnitude.

---

### F5 — [low] "The seven pre-existing keys are all domain-scoped, so the outbox-scoped pair is the exception" — the enumeration is incomplete and row-id scoping is already established practice

**File:** `docs/context/core-platform-runtime.md:20` (the **Send idempotency key**
glossary entry — a coined term, used verbatim by every later artifact), repeated
in the arch-review-log row and D1.

**Contract field violated:** intake `existing_patterns_to_follow[0]` ("the house
Resend key format is `<template>:<domain identity>`") and the glossary's own
claim of completeness.

**Evidence.** The entry enumerates exactly three sources —
`email-channel.ts`, `notification/dispatch.ts:290`,
`AutonomyAdminAlertWorker.ts:60` — and concludes the new outbox-scoped pair is
*the* exception. Two pre-existing sites it omits are row-id-scoped, i.e. the
same shape as the "exception":

- `worker/background/pollers/NotificationFailoverPoller.ts:69-71` —
  `admin-alert:${claimId}`, where `claimId` is a `notification_deliveries` claim
  row id, used at three call sites; its own docstring at `:67` says the key
  exists to "make a repeated send attempt for the SAME claim a no-op at the
  provider" — precisely the argument this branch makes for outbox scoping.
- `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts:314` —
  `accountOffboardingEmailSendIdempotencyKey(deliveryId)`.

**Failure scenario.** The glossary is the artifact a future site consults when
choosing a key shape. As written it frames row-id scoping as a novel departure
needing per-site justification, when the repo already has two precedents whose
reasoning is identical — so the next author either re-derives the argument from
scratch or, worse, treats a legitimate row-id key as a violation of a "house
format" that was never universal.

---

### F6 — [low] `edge_cases[3]`'s justification ("every retry path here completes in minutes") does not hold for the second-outbox-row path the drip key exists for

**File:** `docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-intake.json`
`edge_cases[3]`; repeated as the arch-review-log row's "Named residual" and in
`docs/context/core-platform-runtime.md:20`.

**Contract field violated:** the intake edge case's own stated reason.

**Evidence, measured rather than argued.** The *same-outbox-row* claim is true:
BullMQ retries within ~35 s (`queues.ts:39-40`) and the watchdog re-pends at
15 min with `available_at = NOW()` (`OutboxPoller.ts:69-72, :111-120`), so five
outbox attempts complete in ~75 min. But D1's whole argument is that the drip
key must survive the **second outbox row**, and that path is governed by
different clocks:

1. The first row must reach `attempts >= max_attempts` (5) and terminalize to
   `failed` — ~75 min of watchdog cycles.
2. `OnboardingDripScheduler` then mints the replacement on its **1-hour** cycle
   (`DEFAULT_INTERVAL_MS = 3_600_000`).
3. The churn cap allows only `MAX_FAILURES_PER_DAY = 3` failed rows inside
   `CHURN_WINDOW_HOURS = 24` (`OnboardingDripScheduler.ts:36-37`). Once three
   failures land inside the window, the pair is `churn_capped` and the next mint
   waits for the rolling window to clear — **past 24 h**, where the Resend key
   has expired and the duplicate ships.

The staleness cap leaves room for that: `day_1 + DRIP_STALENESS_GRACE_DAYS (3)`
is a 4-day window (`OnboardingDripWorker.ts:41, :86-95`), so a >24 h re-mint is
still sendable.

**Failure scenario.** A drip whose first three outbox rows fail for a
*non-send* reason (e.g. repeated `NEXT_PUBLIC_APP_URL` gaps on day_7,
`OnboardingDripWorker.ts:427`) inside one 24 h window, with attempt 1 having
already been accepted by Resend. The churn-capped fourth mint lands >24 h later,
the key is gone, and the owner gets the second "Your first week with RepWorth"
email — the exact outcome the key was scoped domain-wide to prevent. Narrow, but
the recorded justification asserts it cannot happen.

Close by amending the sentence to what is true: *same-row* retries complete in
minutes; the second-outbox-row path is bounded by scheduler cadence + churn cap
and can exceed the provider window.

---

## 4. Things I checked and found CORRECT (no finding)

- **Invariant #5.** `randomUUID()` raw token, SHA-256 hash stored, raw token in
  no `INSERT` — unchanged (`create-link.ts:51-52, :102-108`) and now
  negative-tested for the `'never'` mode.
- **Invariant #12.** The Resend error-code vocabulary lives entirely in
  `internal.ts:98-127`; neither worker mentions a Resend code. The workers only
  read `idempotentReplay` and log.
- **Invariant #2.** No send site gained a Postgres-write-then-BullMQ-enqueue; the
  outbox row remains the unit of work.
- **Invariants #10, #11.** No new hashing; `node:crypto` only. The subscription
  guards (`OnboardingDripWorker.ts:135-151`, `EngagementAlertWorker.ts:57-68`)
  and the bounce checks are byte-unchanged.
- **Non-goal "reordering any send site"** — honoured. `sent_at` →
  `recordNotificationDelivery` → `markOutboxCompleted` ordering is identical to
  the merge-base at all three sites.
- **Non-goal "changing the two approval-link call sites outside this ticket"** —
  honoured, and now pinned by `create-link.test.ts:85-102`.
- **Non-goal "changing the Drip staleness cap / claim protocol / cooldown
  guards"** — honoured; `OnboardingDripWorker.ts:191-248` and
  `EngagementAlertWorker.ts:125-137` are unchanged.
- **All 22 `tests_to_add` titles** appear verbatim in the diff (5 + 3 + 6 + 8),
  plus four unpromised strengthening tests. No title overclaims relative to its
  body — I checked each against what it asserts.
- **`recordNotificationDelivery` on a replay** is required, not optional, and
  both workers do it — for the nudge the row *is* the 3-day cooldown record
  (`EngagementAlertWorker.ts:125-132`), so skipping it would re-nudge an owner
  who already received one. The tests pin it.
- **Key collisions across the nine keyed send sites**: none. Prefixes are
  `approval_request:`, `admin-alert:`, `autonomy_admin_alert:`, the offboarding
  helper, `onboarding_drip_*:`, `owner_nudge:`, `partner_*:`. All ≤ 256 chars.
- **`external_message_id` uniqueness**: the only index is the non-unique partial
  `idx_nd_external_message_id` (`019_…:12-14`), so two replays writing the same
  sentinel cannot collide.
- **Mock mode** returns at `internal.ts:75-79` before any Resend call, so no key
  is sent and no 409 is reachable — `edge_cases[4]` holds by construction.

---

## 5. Non-actionable appendix (uncertain — below the 80% bar)

- **The whole safety argument rests on "409 `invalid_idempotent_request` ⟹ the
  first request was ACCEPTED".** Neither the plan's Fact 3 nor the glossary cites
  a source for the case where the *first* request under the key **errored**
  (e.g. `rate_limit_exceeded`) and the second carries a different body. Stripe,
  the closest analogue, stores the key for error responses too and answers
  `idempotency_error` on a changed payload — under that semantics this branch
  would record "delivered" for an email that was never sent, silently, which is
  exactly the first half of `risk_reasons[2]`. I could not establish Resend's
  behaviour here from the repo or the vendored SDK types, so I am not filing it
  as a finding. It is cheap to settle: one live `--live` probe against Resend, or
  a citation to their idempotency doc stating that keys are recorded only for
  accepted requests. Worth settling before the flagless prod deploy, because
  nothing observable distinguishes the two outcomes.
- **`extractOutboxHandle` fallback.** `src/lib/shared/outbox.ts:61` falls back to
  `job.id` when `outbox_id` is absent from the payload, and the OutboxPoller's
  BullMQ job id is `${entry.id}_${entry.attempts}` (`OutboxPoller.ts:329`) — which
  changes per outbox attempt. Today the poller always injects `outbox_id`
  (`:334`), so the nudge/partner keys are stable; but if either topic is ever
  enqueued outside the outbox, the key silently becomes per-attempt and the fix
  evaporates with no test failing. No test pins `outbox_id` presence for these
  two topics.
- **Owner-nudge second-occurrence path.** If the nudge's delivery row is lost to a
  crash *and* the outbox row terminalizes, `EngagementMonitorPoller` re-mints on
  its 24 h cycle (`DEFAULT_INTERVAL_MS = 86_400_000`) with a new outbox id and
  therefore a new key. This is the nudge's analogue of the drip's second-row
  path, and the branch does not close it. I am not filing it because the poller's
  cadence equals the provider key lifetime, so a domain-scoped key would not have
  helped either — but it does mean the nudge's `user_visible_behavior[1]`
  guarantee is "exactly one copy per outbox row", not "per occurrence".
- **`email.delivered` on a replay.** `resend.ts:203` also fails to match, so the
  replayed row's `delivered_at` stays NULL forever. I found no production reader
  of `delivered_at` that would misreport because of it, so this is folded into F2
  rather than filed separately.
