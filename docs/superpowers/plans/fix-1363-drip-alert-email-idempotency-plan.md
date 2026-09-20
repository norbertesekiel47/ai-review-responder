# Plan — #1363 drip and alert email idempotency

Lane: SMALL · RISK = high · SURFACE = backend. Built in one session, no subagent
dispatch. Intake:
`docs/superpowers/plans/fix-1363-drip-alert-email-idempotency-intake.json`.

## REVISED after the step-7 review wave — read this before the tracers below

The wave (5 axes) disproved three claims this plan was built on. The tracers
below are kept as the historical record of what was built first; **the as-built
design is this section.** Findings and dispositions:
`docs/reviews/fix-1363-drip-alert-email-idempotency/` and
`docs/reviews/red-team/fix-1363-drip-alert-email-idempotency-65eabf/`.

1. **A provider key requires a byte-stable body.** Three axes independently found
   that a 409 replay writes a synthetic `external_message_id`, and
   `worker/ingress/resend.ts:229-246` correlates bounce/delivered/complained
   ONLY on the real Resend id. A hard bounce on such a send matches no row, so
   `businesses.owner_email_bounced` is never set. The day_7 drip and the owner
   nudge mint a fresh approval token per attempt, so they were on that path by
   construction. **They now mark before sending and carry no key.**
2. **T2 is fully reverted.** `revokeMode: 'never'` existed only to stop a retry
   revoking an already-delivered link. With mark-before-send there is no retry
   and so no second mint. `src/lib/approval/create-link.ts` and its test file are
   byte-identical to `main`. The justification T2 carried was also wrong: the
   orphan probe keys on `response_id`, and a pending response normally DOES have
   an `approval_request` delivery, so it does not "always read orphan".
3. **Every key is domain-scoped.** The mixed shape is gone. The stated reason for
   outbox-scoping the nudge and partner alerts — that a business-scoped key might
   suppress a legitimate later alert inside the 24h window — was false:
   `EngagementMonitorPoller.ts:30-35` sets cooldowns of 3/7/14 **days**. Domain
   scope is also strictly stronger, because it covers the poller's re-mint after
   a watchdog terminalizes a crashed row.

As-built, per send:

| Send | Body across attempts | Defence |
|---|---|---|
| day_1, day_30 | stable | key `onboarding_drip_<type>:<business_id>` |
| day_7 | varies (fresh tokens) | mark `sent_at` before send, no key |
| owner nudge | varies (fresh tokens) | complete outbox before send, no key, **no rethrow** |
| partner ×3 | stable (payload metrics) | key `<alert_type>:<business_id>` |
| satisfaction | — | unchanged, already marks first |

One further defect the rework introduced and a pre-existing test caught: with the
outbox row completed first, rethrowing a send failure lets BullMQ retry the JOB
and send a second nudge. The owner nudge now swallows and logs, as
`WeeklySummaryWorker`'s `sendSummaryReportEmail` does. The drip does not need
this — its dedupe record is `sent_at`, re-checked at the top of the handler.

## Design record

Two modules deepen; nothing new is created.

| Module | Seam | Verdict |
|---|---|---|
| `sendInternalEmail` | `src/lib/notifications/email/templates/internal.ts` | Deepen. It already owns "Resend result → throw or messageId". The 409 classification goes behind that same interface; the interface grows by one optional return field. |
| `createApprovalLink` | `src/lib/approval/create-link.ts` | Deepen. The `revokeMode` union gains one literal. No new parameter. |
| The two worker handlers | `worker/jobs/*.ts` | Call sites. They pass arguments. Failure behaviour stays in the module (invariant #12). |
| A shared key-builder helper | — | Rejected as a shallow module: one caller per key shape, and the seven existing house keys are inline template literals. |

## Facts this plan rests on

Verified against HEAD `650f625e7` on 2026-09-20.

1. `node_modules/resend/dist/index.mjs:1130` maps `options.idempotencyKey` to the
   `Idempotency-Key` header. `src/lib/notifications/email/send-email.ts:51` is the
   single owner of that mapping. No change is needed there.
2. `node_modules/resend/dist/index.d.mts:131-135` — `ErrorResponse.name` is a
   `RESEND_ERROR_CODE_KEY`, which includes `invalid_idempotent_request`,
   `concurrent_idempotent_requests` and `invalid_idempotency_key`.
3. Resend keeps an idempotency key for 24 hours, caps it at 256 characters, and
   answers 409 `invalid_idempotent_request` when the same key arrives with a
   different body.
4. `src/lib/approval/create-link.ts:37` mints a fresh `randomUUID()` per call, so
   the Day 7 drip and owner nudge bodies differ between attempts. The 409 path is
   their NORMAL retry path, not an exception.
5. `src/lib/approval/create-link.ts:60-61` sets `shouldRevoke` from `'always'`,
   then from the `'orphaned_only'` delivery probe. A third literal `'never'`
   falls through both tests to `false`, so the logic change is the type only.
6. `src/lib/notifications/delivery.ts:19` requires `externalMessageId: string`.
   An idempotent replay has no Resend message id, so it records a sentinel.
7. The drip stale-claim takeover (`worker/jobs/OnboardingDripWorker.ts:227-236`)
   admits a SECOND outbox row. Two rows carry two outbox ids, which is why the
   drip key is scoped to `(business_id, drip_type)` and not to the outbox row.

## Tracers

Blocking edges: T3 and T4 both need T1 and T2. T1 and T2 are independent of each
other. T5 needs T1–T4.

---

### T1 — `sendInternalEmail` classifies the Resend 409 codes

**Modify:** `src/lib/notifications/email/templates/internal.ts`
**Test:** `src/lib/notifications/email/templates/__tests__/internal.test.ts` (new)

**Behaviour.** When `sendEmail` returns an error whose `name` is
`invalid_idempotent_request` AND the caller supplied an `idempotencyKey`,
`sendInternalEmail` returns
`{ messageId: \`idempotent-replay:<key>\`, idempotentReplay: true }` instead of
throwing. Every other error keeps throwing `Resend API error: <message>`.

**Negative cases.** `concurrent_idempotent_requests` throws — the first request is
still in flight, which is not proof of acceptance, and Resend documents it as
retryable. `invalid_idempotency_key` throws — a malformed key is our bug, not a
delivery outcome. An `invalid_idempotent_request` with NO key supplied throws,
because that shape is impossible without a key and swallowing it would hide a
provider or plumbing fault.

**Owner.** The module owns the classification so neither worker needs Resend
error-code knowledge (invariant #12).

**Interface change.** Return type widens from `{ messageId: string }` to
`{ messageId: string; idempotentReplay?: boolean }`. The ten existing callers
destructure `messageId` only and are unaffected.

**Export.** `export const IDEMPOTENT_REPLAY_PREFIX = 'idempotent-replay:'` so the
workers, the tests and the operator SQL in the intake share one spelling.

**Precedent.** `src/lib/notifications/email/__tests__/approval-idempotency.test.ts`
shows the mock shape: `vi.mock('../client')` plus
`vi.mock('@/lib/shared/mock-mode', () => ({ isMockMode: () => false }))`.

**Seam.** `sendInternalEmail`.

**Test titles.**
- `treats invalid_idempotent_request as a delivered email and reports an idempotent replay`
- `rethrows concurrent_idempotent_requests so the job retries instead of dropping the email`
- `rethrows invalid_idempotency_key because a malformed key is a programming error`
- `keeps throwing on an ordinary Resend error when an idempotency key was supplied`
- `omits the idempotency key from the Resend request when the caller supplies none`

---

### T2 — `createApprovalLink` gains `revokeMode: 'never'`

**Modify:** `src/lib/approval/create-link.ts`
**Test:** `src/lib/approval/__tests__/create-link.test.ts`

**Behaviour.** `revokeMode: 'never'` inserts the new approval link and revokes
nothing. `'orphaned_only'` and `'always'` behave exactly as they do today.

**Why it exists.** The Day 7 drip and the owner nudge deliver a link and then
record a delivery whose `template` is not `approval_request` or
`pending_post_notice` and whose `response_id` is NULL. The `'orphaned_only'`
probe therefore never matches, so a retry revokes the link the owner already
received. With the idempotency key suppressing the second email, that link is
the only one the owner holds.

**Security contract.** Approval links keep their 48-hour TTL, so `'never'` leaves
at most one extra live link per response and it expires unaided. Token generation
is untouched: `randomUUID()` raw token, SHA-256 hash stored, raw token never
persisted (invariant #5). Regenerate still revokes every outstanding link for a
response; `'never'` does not reach that path.

**Implementation note.** `shouldRevoke` already starts `false` for any mode that
is not `'always'` and the `'orphaned_only'` probe is guarded by an explicit
equality test, so `'never'` needs no new branch. Widen the union and document it.

**Negative test.** A `'never'` call must not weaken token handling — assert the
stored value is the SHA-256 of the returned raw token and that the raw token
appears in no INSERT.

**Seam.** `createApprovalLink`.

**Test titles.**
- `revokeMode never leaves an existing open link untouched while inserting the new one`
- `revokeMode never still stores only the SHA-256 hash and never the raw token`
- `revokeMode orphaned_only and always keep their existing revoke behaviour unchanged`

---

### T3 — `OnboardingDripWorker` passes its business-scoped key

**Modify:** `worker/jobs/OnboardingDripWorker.ts`
**Test:** `worker/jobs/__tests__/OnboardingDripWorker.test.ts`

**Behaviour.** The handler builds
`` const idempotencyKey = `onboarding_drip_${drip_type}:${businessId}` `` and passes
it to `sendInternalEmail` at `:277`. The key deliberately matches the
`notification_deliveries.template` value the same handler writes at `:296`.

**Scope choice.** `(business_id, drip_type)` mirrors the
`onboarding_drip_log UNIQUE (business_id, drip_type)` constraint, so it covers
the stale-claim takeover at `:227-236` where a SECOND outbox row re-enters on
`sent_at IS NULL`. An outbox-scoped key would not, and that path is the one the
issue names.

**Approval links.** The `createApprovalLink` call in `buildDay7` at `:414` changes
from `revokeMode: 'orphaned_only'` to `revokeMode: 'never'`.

**Replay handling.** `sendInternalEmail` now returns `idempotentReplay`. When it
is true, the handler still marks `sent_at`, still records the delivery (with the
sentinel message id) and still completes the outbox row — the email IS delivered,
so every downstream fact must be written. It logs one distinct line naming the
worker, the business id and the key.

**Ordering unchanged.** `sent_at`, `recordNotificationDelivery` and
`markOutboxCompleted` stay after the send, in that order. This ticket does not
reorder anything.

**Invariants.** The Drip staleness cap, the three-way claim, the subscription
guard and the bounce check are untouched.

**Seam.** `handleOnboardingDrip`.

**Test titles.**
- `day_1 drip sends with an idempotency key scoped to the business and drip type`
- `day_7 drip sends with an idempotency key scoped to the business and drip type`
- `day_30 drip sends with an idempotency key scoped to the business and drip type`
- `a drip taken over by a second outbox row reuses the same idempotency key`
- `a drip replay marks sent_at and records the delivery with an idempotent-replay message id`
- `day_7 drip builds its approval links with revokeMode never so the delivered link survives a retry`

---

### T4 — `EngagementAlertWorker` passes its outbox-scoped keys

**Modify:** `worker/jobs/EngagementAlertWorker.ts`
**Test:** `worker/jobs/__tests__/EngagementAlertWorker.test.ts`

**Behaviour.** `handleOwnerNudge` builds `` `owner_nudge:${outboxId}` `` and passes
it at `:198`. `handlePartnerAlert` builds `` `${alertType}:${outboxId}` `` and
passes it at `:282`. Both handle `idempotentReplay` exactly as T3 does: record the
delivery with the sentinel, complete the outbox row, log one distinct line.

**Scope choice.** Both alerts recur on a cooldown and have no natural domain
identity, so the outbox row id IS the identity of one send occurrence. This is the
opposite of T3's choice and the reason is written at each call site.

**Approval links.** The `createApprovalLink` call in `handleOwnerNudge` at `:180`
changes from `revokeMode: 'orphaned_only'` to `revokeMode: 'never'`.

**Untouched.** `handleSatisfactionAlert` at `:304-420` keeps its
mark-before-send ordering and passes NO key. Adding one would buy nothing: it
already completes the outbox row before calling Resend, so the duplicate this
ticket fixes cannot occur there. A test pins that.

**Invariants.** The subscription guard, the hard-bounce check, the 3-day nudge
cooldown probe and the env-config validation order are untouched.

**Seam.** `handleEngagementAlert`.

**Test titles.**
- `owner nudge sends with an idempotency key scoped to the outbox row`
- `owner nudge builds its approval links with revokeMode never so the delivered link survives a retry`
- `an owner nudge replay records the delivery with an idempotent-replay message id`
- `partner engagement alert sends with an idempotency key scoped to the outbox row`
- `partner escalation alert sends with an idempotency key scoped to the outbox row`
- `partner low engagement alert sends with an idempotency key scoped to the outbox row`
- `a partner alert replay completes the outbox row instead of failing it`
- `the partner satisfaction alert still marks the outbox completed before sending and passes no key`

---

### T5 — glossary and directory rows

**Modify:** `docs/context/core-platform-runtime.md`, `CONTEXT-MAP.md`,
`docs/directory/lib-reviews-responses.md`,
`docs/directory/lib-notifications-channels-messaging.md`

**Behaviour.** Two terms are coined and used verbatim by every later artifact.

- **Send idempotency key** — the stable `Idempotency-Key` a worker hands Resend
  through `sendInternalEmail`, shaped `<template>:<identity>`. The identity is a
  domain key when the email has one (the drip's `business_id` plus `drip_type`)
  and the Outbox job row id when it does not (a recurring alert occurrence).
  Valid for 24 hours at the provider, so it bounds a crash-retry window, not a
  durable guarantee.
- **Idempotent replay** — a send Resend refused with 409
  `invalid_idempotent_request` because the same **Send idempotency key** arrived
  with a different body. It means the email WAS delivered by the first attempt.
  `sendInternalEmail` reports it rather than throwing, and the delivery record
  carries `external_message_id` prefixed `idempotent-replay:`.

Add both to the `CONTEXT-MAP.md` term list for
`docs/context/core-platform-runtime.md`. Update the `create-link.ts` row to name
the third `revokeMode`, and the `internal.ts` row to name the replay return.

**Seam.** None — documentation.

**Test titles.** None. `pnpm ci:directory-map` and the CLAUDE.md shape test are the
mechanical checks.

## Self-review

1. **Intake coverage.** Each of the five `user_visible_behavior` entries maps to a
   tracer: duplicates suppressed → T3, T4 via T1; link survives → T2 consumed by
   T3, T4; operator-visible sentinel → T1 defines it, T3 and T4 write it, T5
   documents it. All 22 `tests_to_add` titles appear above, each under one tracer.
2. **Placeholder scan.** No `TBD`, no `TODO`, no "handle edge cases", no "similar
   to Task N". Every type and constant used is defined in T1 or T2.
3. **Security coverage.** T2 is the only tracer crossing a trust boundary. It
   states its contract and owns a negative test on raw-token storage. T1's
   no-key-supplied case is its own negative test.
4. **Name consistency.** `IDEMPOTENT_REPLAY_PREFIX`, `idempotentReplay` and
   `revokeMode: 'never'` are spelled identically in T1, T2, T3, T4 and T5.
