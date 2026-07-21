# ADR 0010: Owner-unreachable outcome — an outbox completion marker read latest-first, a durable age-floor health check, and a poller-driven advisory-locked retry

## Status

Accepted — 2026-07-21 (F1 owner-unreachable escalation)

## Context

An approval draft becomes owner-actionable only after `send_notification`
delivers an approval link on an enrolled owner channel. When the draft's
account/location has **zero verified channel enrollments** at send time, the
`send_notification` job completes with nothing delivered (`no_verified_enrollments`):
the draft is legitimately still `pending_approval`, no delivery was attempted,
and the owner has no way to act. Nothing posts to Google — invariant #3 holds —
but the draft can sit silently forever, indistinguishable from a draft that is
merely waiting on the owner.

The F1 ticket framed this as "no health check can see it." That premise was
**stale**. `checkZeroDeliveryNotifications` already partially observed the
zero-enrollment case within its 1h window via a blanket
`NOT EXISTS(notification_deliveries)` — a completed `send_notification` with no
delivery rows matches whether the cause was zero enrollments or an all-channel
delivery failure. So the gap was not "invisible"; it was **conflated and
transient**: the zero-enrollment case was folded into the all-failed signal and
aged out of the 1h window, so a persistently-unreachable owner stopped being
observable after an hour. This correction was surfaced to and accepted by the
owner — F1's value is making the outcome **distinct + durable + de-conflated**,
not making a wholly invisible state visible.

Three distinct notification outcomes must be told apart:

- **Owner-unreachable** — zero verified enrollments; no attempt possible.
- **All-failed** — a delivery was attempted on an enrolled channel and every
  attempt failed.
- **Stale** — delivered, but the owner has not acted.

## Decision

### (a) A `job_outbox.completion_reason` marker, not a new `responses.status`

The owner-unreachable outcome is recorded as
`job_outbox.completion_reason='owner_unreachable'` on the completed
`send_notification` row — **not** as a new `responses.status` value. The draft
is legitimately still `pending_approval`; minting a status for it would force
every status consumer (dashboard queries, publisher guards, KPI rollups, admin
views) to learn a new terminal-ish state that means "still pending, but for this
one reason." Containing the blast radius to the outbox row keeps the fact where
the notification pipeline already owns it and leaves `responses.status`
semantics untouched.

### (b) Current-state is the LATEST completed `send_notification` reason, not sticky marker presence

An account is owner-unreachable **now** only if the *most recent* completed
`send_notification` for the response carried `completion_reason='owner_unreachable'`.
A marker is not sticky: a later completion for a different reason (e.g. a
subscription-skip retry, or a successful delivery once a channel is verified)
**supersedes** it. The current-state predicate therefore selects the latest
completed `send_notification` row per response and inspects *its* reason, rather
than testing `EXISTS(… completion_reason='owner_unreachable')`, which would
report a stale marker as if it were live.

The predicate orders by **`created_at DESC`**, not the nullable `completed_at`,
so a row that is completed-but-null-timestamped can never sort ahead of or
behind its true position, and it matches migration 082's
`idx_jo_send_notification_by_aggregate` so the lookup is index-served.

### (c) A durable age-floor health check, plus de-conflation of the existing one

Add `checkOwnerUnreachable` — a **durable 4h age-floor** check (Sentry): it
fires when a response has been owner-unreachable (by the latest-reason predicate
above) for longer than 4h, and keeps firing until a channel appears. This is the
opposite of a sliding window — a persistently-unreachable owner stays visible
indefinitely instead of aging out.

De-conflate the existing signal: `checkZeroDeliveryNotifications` (the transient
1h-windowed `NOT EXISTS(notification_deliveries)` check) now **excludes** the
owner-unreachable marker, so the two checks no longer double-count the same
rows. `checkZeroDeliveryNotifications` keeps observing genuine all-failed cases;
`checkOwnerUnreachable` owns the zero-enrollment case durably.

**Known residual (out of F1 scope — follow-up ticket):**
subscription-skip and all-channel-flag-disabled completions are *also*
zero-delivery, but do **not** get their own marker, so they still fire
`checkZeroDeliveryNotifications`. F1 does not mint markers for those causes; the
follow-up ticket will decide whether each deserves its own reason.

### (d) A poller-driven, advisory-locked retry on the existing cadence

The retry rides the existing `NotificationFailoverPoller` cadence: each cycle
re-dispatches `send_notification` for responses whose latest outcome is
owner-unreachable, so the moment a channel is verified the next poll delivers.
The retry is **self-clearing** (a successful delivery writes a newer completion
that supersedes the marker per (b)) and **at-most-once across concurrent
pollers** via a Postgres advisory lock, so two poller instances cannot double
re-dispatch the same response.

Chosen over an **event-driven re-notify hook** wired into channel-enrollment
verification: the poller reuses an existing loop, needs no new coupling from the
enrollment path back into the notification pipeline, and self-heals on the
normal cadence regardless of which code path added the channel (owner UI, admin
action, backfill). The cost is up-to-one-cadence latency after a channel
appears, which is acceptable for this outcome.

### (e) Both escalation surfaces: durable Sentry finding + deduped admin email

The outcome escalates through **both** a durable Sentry finding (from
`checkOwnerUnreachable`, the always-on operator signal) **and** a best-effort
admin email **deduped to at most once per 24h** per subject. The Sentry finding
is the source of truth; the email is a human nudge and is allowed to fail
without failing the check.

### (f) No new index

Migration 082 already provides `idx_jo_send_notification_by_aggregate`, which
serves both the latest-reason current-state lookup (b) and the retry selection
(d). F1 adds **no new index**.

## Consequences

- **Positive:** the three outcomes (owner-unreachable / all-failed / stale) are
  finally distinct; the zero-enrollment case is durable (age floor, not a 1h
  window) and de-conflated from all-failed; the marker is read latest-first so a
  stale marker never masquerades as live; the retry self-heals on the existing
  cadence with no new coupling and is safe under concurrent pollers; and no new
  schema or index is introduced.
- **Negative / accepted — durability is coupled to the retry loop.**
  `ArchivalPoller` deletes `completed` `job_outbox` rows older than 7 days, so an
  `owner_unreachable` marker is pruned at 7d. The signal stays durable **because
  the retry arm re-creates a fresh marker every ~2–6h** — the latest-by-
  `created_at` completion stays well under 7d for as long as retries run, so
  `checkOwnerUnreachable` keeps seeing it. If the retry loop itself stalls
  (a response stuck `pending`/`dispatching` for >7d), that is caught
  independently by `checkStaleDispatching` / `checkOldestPendingOutbox`. So the
  durability is real but coupled to the retry loop, not intrinsic to the marker.
  The owner reviewed and accepted this. **Rejected alternative:** excluding
  owner-unreachable markers from `ArchivalPoller` would decouple durability from
  the retry loop, but it widens the F1 edit surface into the archival path and
  complicates retention semantics; not worth it while the retry-loop coupling
  gives durability for free.
- **Accepted residual (follow-up ticket):** subscription-skip and
  all-channel-flag-disabled zero-delivery completions still fire
  `checkZeroDeliveryNotifications` because they carry no marker of their own.
- **Map correction, recorded:** the ticket's "no health check can see it"
  premise was stale — `checkZeroDeliveryNotifications` already partially observed
  the zero-enrollment case within its 1h window. F1's contribution is
  distinctness, durability (age floor vs window), and de-conflation, not
  first-time visibility. Surfaced to and accepted by the owner.
- **Reversal / revisit trigger:** if the retry cadence is ever slowed enough
  that the ~2–6h marker-refresh interval could exceed the 7d archival horizon
  (leaving a live-but-pruned marker between refreshes), revisit the archival
  coupling — either exclude the marker from `ArchivalPoller` or lift the outcome
  to its own durable row. Likewise, if any of the residual zero-delivery causes
  in (c) proves to need distinct operator handling, promote it to its own
  `completion_reason` alongside `owner_unreachable`.
