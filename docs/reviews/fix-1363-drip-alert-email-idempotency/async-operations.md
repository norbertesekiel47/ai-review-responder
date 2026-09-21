# Async / operations risk review — fix/1363-drip-alert-email-idempotency

Fork: `10377aa9b..1b9fe88de` (fixed; not recomputed).
Axis: outbox atomicity, idempotency, poison work, timeout/retry bounds, observability, recovery, kill switches.
Checklist consulted: `docs/reviews/finding-checklists/async.md` (all 13 entries; no entry matched this diff directly — closest in spirit is the "accepted gap justified by a false premise" class, which A2 and A3 below reproduce).

---

## Findings (>= 80% confidence)

| severity | file:line | finding |
|---|---|---|
| high | worker/jobs/OnboardingDripWorker.ts:318 (via src/lib/notifications/email/templates/internal.ts:123) | The synthetic `idempotent-replay:<key>` message ID breaks Resend webhook correlation, silently disabling the hard-bounce -> `owner_email_bounced` safety net for the email that WAS delivered |
| medium | src/lib/notifications/email/templates/internal.ts:98-126 | A suppressed duplicate whose body is UNCHANGED is completely invisible — Resend returns the original 2xx, not a 409, so no replay flag, no log line, and no `idempotent-replay:` row; that is the majority of replays (day_1, day_30, all three partner alerts) |
| medium | worker/jobs/OnboardingDripWorker.ts:292 | The drip's business-scoped key CAN outlive Resend's 24h window (~T0+25h, reachable); the intake's accepted-risk rationale "every retry path here completes in minutes" is wrong by two orders of magnitude — one outbox row alone lives ~75 min |
| low | src/lib/approval/create-link.ts:26-27 | "at most one extra live link per response" is false — `revokeMode:'never'` adds one live 48h link **per attempt**, up to ~15 per response across the full retry envelope |

---

## A1 [high] — the replay message ID breaks Resend webhook correlation, and with it the hard-bounce safety net

**Where.** `src/lib/notifications/email/templates/internal.ts:120-126` returns
`messageId = 'idempotent-replay:' + key`. All three changed call sites feed that
straight into `recordNotificationDelivery`:
`worker/jobs/OnboardingDripWorker.ts:318`,
`worker/jobs/EngagementAlertWorker.ts:233`,
`worker/jobs/EngagementAlertWorker.ts:326`.

**Failure scenario (concrete).**

1. `handleOnboardingDrip` day_7, attempt 1. `sendEmail` posts to Resend; Resend
   accepts and assigns message id `re_abc`. The 10 s `Promise.race` timeout in
   `src/lib/notifications/email/send-email.ts:53-59` fires first (or the worker
   is OOM-killed), so the awaiter throws. `recordNotificationDelivery`
   (OnboardingDripWorker.ts:312) never runs. **No row anywhere carries `re_abc`.**
2. BullMQ retries (or the watchdog re-pends). `buildDay7` mints fresh approval
   tokens (`createApprovalLink` -> `randomUUID`), so the body differs. Resend
   answers 409 `invalid_idempotent_request`. The new branch returns
   `idempotent-replay:onboarding_drip_day_7:<businessId>` and the handler writes
   the delivery row with that value.
3. Resend later posts `email.bounced` (hard) for `re_abc`.
   `handleEmailBounced` (`worker/ingress/resend.ts:232-236`) looks the delivery
   up by `external_message_id = 're_abc'` -> **zero rows** -> `!delivery?.business_id`
   at `resend.ts:244` -> early return.
   `businesses.owner_email_bounced` is never set and `sendHardBounceAlert` never
   fires.

**Why this is a regression, not a pre-existing gap.** Before this change the
retry sent a SECOND real email with a real message id and recorded it, so the
second email's bounce webhook DID match a row and DID flag the owner
(`onboarding_drip_*` and `owner_nudge` are both owner-directed —
`worker/ingress/resend.ts:91-124`). Suppressing the duplicate removes the only
row the webhook could have matched. The hard-bounce flag is precisely what the
two changed workers gate on
(`OnboardingDripWorker.ts:156`, `EngagementAlertWorker.ts:102`), so the failure
is self-silencing: RepWorth keeps emailing a dead address (drips, nudges,
weekly, monthly, approval requests) and the admin is never told.

**Secondary effects of the same break.**
- `email.complained` (`resend.ts:207-211`) never records `failure_reason='complained'`.
- `email.delivered` (`resend.ts:201-206`) never sets `delivered_at`, so the
  replay row reads **pending forever** in `/admin/notifications`
  (`src/lib/admin/notifications-service.ts:97-101`) and is missing from
  `delivered_24h` (`src/lib/admin/overview-service.ts:153`).

**Note.** Resend's 409 response body does not carry the original message id, so
there is no cheap recovery inside the replay branch. The options are a real fix
(persist the key on the delivery row and let the ingress fall back to a
key-based lookup — needs a column, which the intake lists as a non-goal) or an
explicit, recorded acceptance that hard bounces on replayed emails are lost. The
branch currently does neither, and nothing in
`docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-deviations.md`
(D1-D7) raises it.

---

## A2 [medium] — the durable replay signal only covers the token-carrying subset

`src/lib/notifications/email/templates/internal.ts:98-126` classifies only the
**error** path. Resend returns 409 `invalid_idempotent_request` solely when the
same key arrives with a *different* payload; an identical-payload repeat under a
live key is answered with the **original 2xx response**, carrying the original
message id.

So for a replay whose body is unchanged the code takes `return { messageId: data!.id }`
at `internal.ts:130`: `idempotentReplay` is `false`, no log line is emitted, and
`external_message_id` is a real Resend id. Nothing distinguishes it from a fresh
send.

Which sites produce an unchanged body on retry:

| site | body varies per attempt? | replay visible? |
|---|---|---|
| day_7 drip (`OnboardingDripWorker.ts:438`) | yes — fresh `randomUUID` tokens | yes (409 path) |
| owner nudge (`EngagementAlertWorker.ts:183`) | yes — fresh tokens | yes (409 path) |
| day_1 drip | no — `buildOnboardingDay1Html(name, owner, dashboardUrl)` is deterministic | **no** |
| day_30 drip | effectively no — DB stats are stable across a minutes-apart retry | **no** |
| partner engagement / escalation / low-engagement | no — metrics come from the frozen outbox payload | **no** |

Consequence for hunt item 4: the intake's durable signal
(`observability[2]`: `SELECT count(*) ... WHERE external_message_id LIKE 'idempotent-replay:%'`)
systematically undercounts, and the three-of-five sites listed above replay
**completely silently** — no log line, no prefix, no way for an operator to tell
a suppressed duplicate from a genuine send. The new test file
(`src/lib/notifications/email/templates/__tests__/internal.test.ts`) asserts the
three error codes and the no-key case but never the identical-body 2xx replay,
so the gap is not pinned either.

Confidence note: this rests on Resend replaying the original response for an
identical-body repeat (documented idempotency semantics, and the only behaviour
under which `invalid_idempotent_request` can be defined as "same key, *different*
payload"). ~88%.

---

## A3 [medium] — the real retry envelope, and why "completes in minutes" is false

The intake accepts the 24h window with:

> "A Resend idempotency key expires after 24 hours. A retry or a Watchdog
> re-dispatch beyond that window sends a second email. **Accepted: every retry
> path here completes in minutes**, and no durable guarantee is claimed."
> (`intake.json` edge_cases[4])

Measured against the code, that premise is false.

**The numbers.**

| bound | value | source |
|---|---|---|
| OutboxPoller tick | 5 000 ms default | `OutboxPoller.ts:36` (`OUTBOX_POLL_INTERVAL_MS`) |
| BullMQ attempts | 3 | `worker/queues.ts:35` (`defaultJobOptions`; neither queue uses `llmJobOptions`) |
| BullMQ backoff | exponential from 5 000 ms, jitter 0.5 -> ~[2.5,5] s then ~[5,10] s | `worker/queues.ts:36` |
| in-band BullMQ budget | **~7.5-15 s** of waiting (+ up to 3 x 10 s send timeout) | derived |
| `job_outbox.max_attempts` | **5** (default; neither producer overrides it) | `supabase/migrations/001_initial_schema.sql:313`; `OnboardingDripScheduler` INSERT omits the column; `EngagementMonitorPoller.ts:172` likewise |
| watchdog stale-`dispatched` reclaim | **900 000 ms = 15 min** | `OutboxPoller.ts:68-72` (`OUTBOX_WATCHDOG_STALE_MS`) |
| stale-`dispatching` reclaim | 2 min | `OutboxPoller.ts:166-176` |
| one outbox row's total life | 4 watchdog re-pends x 15 min ~= **60-75 min** | derived |

So the floor is ~75 minutes, not "minutes" — and for the drip it does not stop
there.

**Can the elapsed time between the FIRST send and a later attempt exceed 24h?**

- **Owner nudge (`owner_nudge:${outboxId}`) — NO.** The key is outbox-scoped and
  an outbox id's entire life is ~75 min. Safe by construction.
- **Partner alerts (`${alertType}:${outboxId}`) — NO.** Same reasoning.
- **Onboarding drip (`onboarding_drip_<type>:<businessId>`) — YES.** Walk it:
  1. T0: attempt 1 is accepted at Resend; the worker dies (or Resend degrades)
     before `sent_at` is written at `OnboardingDripWorker.ts:306-308`.
  2. T0 -> ~T0+75 min: if the provider fault persists, the 5 outbox attempts
     burn and the watchdog terminalizes the row to `failed`
     (`OutboxPoller.ts:134-154`), stamping `completed_at ~= T0+75 min`.
  3. `OnboardingDripScheduler` (hourly, `DEFAULT_INTERVAL_MS = 3_600_000`)
     re-mints: its `NOT EXISTS` excludes only *non-failed* outbox rows, and
     `onboarding_drip_log.sent_at` is still NULL. Row #2 -> fails ~T0+2.5 h,
     row #3 -> fails ~T0+4 h.
  4. `MAX_FAILURES_PER_DAY = 3` over `CHURN_WINDOW_HOURS = 24` now churn-caps
     the pair.
  5. At **~T0+25.25 h** the first failure's `completed_at` drops out of the
     rolling 24h window, the count falls to 2, and the scheduler mints row #4.
     Step 4's stale-claim takeover succeeds (`sent_at IS NULL`,
     `claimed_at` long past `STALE_CLAIM_MINUTES`), and the handler sends under
     the **same key** — now past Resend's 24h key record. Resend accepts it.
     **The owner receives the second copy the ticket exists to prevent.**
  6. Upper bound is the drip staleness cap (`activated + days + 3 days`,
     `OnboardingDripWorker.ts:41,86-95`), which leaves room for this on days 2
     and 3.

The *outcome* may still be acceptable (it needs a multi-hour provider fault on
top of a crash-after-send). The *rationale* is not: the true bound is the drip
staleness cap measured in days, not "minutes", and that is what should be
written down — both in `intake.json` edge_cases[4] and in the call-site comment
at `OnboardingDripWorker.ts:277-286`, which explains the key's scope without ever
naming its expiry.

---

## A4 [low] — `revokeMode:'never'` is bounded per attempt, not per response

`src/lib/approval/create-link.ts:91-108`: with `'never'`, `shouldRevoke` is
`false` and the INSERT runs unconditionally. Every handler attempt therefore adds
one live 48-hour link per pending response and revokes none.

The docblock at `create-link.ts:26-27` says

> "Bounded by the 48-hour TTL below: **at most one extra live link per response**,
> expiring unaided."

and `intake.json` invariants[6] repeats it. Both are wrong by the retry
multiplier. Worst case across the envelope in A3 — 5 outbox attempts x 3 BullMQ
attempts — is ~15 live links per response, of which at most one was ever emailed;
the owner nudge builds up to 10 responses per run
(`EngagementAlertWorker.ts:157`) and the day_7 drip up to 5
(`OnboardingDripWorker.ts:419`).

Invariant #5 is intact (still `randomUUID` in memory, SHA-256 hash only in
`approval_links`) and the links are unguessable, so this is a documentation /
surface-growth finding rather than a token-security break. But the stated bound is
the thing a future reviewer will reach for when asked "how many live links can a
response accumulate", and it is off by a factor of ~15. Fix the sentence, or bound
it (revoke all-but-the-last inside the same transaction).

---

## Clean — checked and found correct

**Invariant #2 (transactional outbox).** No file in the diff writes Postgres and
separately enqueues BullMQ. No outbox transition moved:
- drip still `markOutboxCompleted` last, after `sent_at` and the delivery row
  (`OnboardingDripWorker.ts:306-321`);
- nudge and partner alert unchanged in ordering
  (`EngagementAlertWorker.ts:227-236`, `320-329`);
- the satisfaction branch still completes the outbox row **before** the send
  (`EngagementAlertWorker.ts:427-438`) and deliberately passes no key, matching
  `intake.json` non_goals[1].

**Replay-path downstream writes (hunt item 2) — each is correct as a fact.** On a
409 replay the email genuinely IS delivered, so `onboarding_drip_log.sent_at`,
the `notification_deliveries` row (which is the nudge's own 3-day cooldown record
at `EngagementAlertWorker.ts:125-137`) and the outbox completion are all true
statements. Skipping any of them would be the bug (correctly argued in D3).
The one field that is now false is `external_message_id` — see A1.

**Downstream consumers of `external_message_id`.** Swept: `worker/ingress/resend.ts`
(A1), `worker/ingress/twilio/twilio-delivery-status.ts:109` (channel-scoped to
sms/whatsapp, unreachable from an email row),
`worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts:335,352,469-505`
(its own claim protocol, different send path, no key),
`src/lib/notifications/delivery.ts:391-438` (`finalizeDeliverySent` /
claim-release — not on any changed path). No query JOINs on the column; all of
them equality-match a provider id, which is exactly the assumption A1 breaks.

**Kill switches.** None added, none needed — the change has no flag and
`rollback_plan` (revert the single squash commit) is accurate. `MOCK_EXTERNAL_APIS`
still short-circuits at `internal.ts:75-79` before any key reaches Resend.

---

## Non-actionable appendix (below the 80% bar, or shape notes only)

- **`concurrent_idempotent_requests` reachability (hunt item 3).** It is NOT
  unreachable, but not for the reason the prompt suggests. Two replicas are ruled
  out by invariant, and intra-queue concurrency is ruled out too — both
  `engagementAlertWorker` and `onboardingDripWorker` register with bare
  `workerOpts` (`worker/index.ts:215,400,404`), i.e. BullMQ default concurrency 1,
  and OutboxPoller's re-dispatch of a still-running entry needs a >15 min handler,
  which a 10 s-capped send and a 30 s `statement_timeout` make implausible. The
  real path is the **orphaned fetch**: `send-email.ts:53-59` races a timer against
  `resend.emails.send` and abandons the awaiter at 10 s while the underlying fetch
  keeps running at Resend. The BullMQ retry lands ~2.5-5 s later with the same key
  while the first request is still in flight -> 409 `concurrent_idempotent_requests`
  -> throw -> retry. It recovers cleanly: the outbox budget (5) strictly exceeds
  the BullMQ budget (3), so burning all three in-band attempts leaves the row
  `dispatched` for the 15 min watchdog rather than terminalizing it. Cost is wasted
  attempts, not lost mail. Worth a sentence in the call-site comment; not a defect.
- **worker-layout trap "best-effort work after a primary side effect needs its own
  try/catch".** The three new `if (idempotentReplay) logger.log(...)` calls
  (`OnboardingDripWorker.ts:299`, `EngagementAlertWorker.ts:224`, `:317`) do sit
  after the Resend send and before the `sent_at` marker, unguarded. `emit`
  (`src/lib/shared/logger.ts:189-195`) serializes only plain strings and a
  two-string record here, so a throw is not reachable in practice. Shape note only
  — I am not >=80% confident this is actionable.
- **Second delivery row on the partner-alert branch.** A crash between
  `recordNotificationDelivery` (`EngagementAlertWorker.ts:320`) and
  `markOutboxCompleted` (`:329`) re-runs the handler with no cooldown guard on that
  branch (unlike the nudge's 3-day check and the drip's `sent_at` claim), writing a
  second `notification_deliveries` row. Pre-existing; this change makes the second
  row carry a replayed/duplicated id instead of a second genuine send, which is
  strictly better. Raised only so it is not mistaken for new.
- **Recipient address in the new log line.** `internal.ts:121` logs `to=<email>`.
  Consistent with the pre-existing mock line at `internal.ts:77` and outside
  CLAUDE.md's named prohibitions (review/response text, tokens, secrets, MFA
  codes). Not raised as a finding.
