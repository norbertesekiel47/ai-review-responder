=== FINDINGS TABLE ===

severity | artifact:location | one-line finding
--- | --- | ---
high | `src/lib/solicitation/dispatch.ts:1514` | Decision 9 has no live recovery owner: a crash after tx1 permanently leaves `sending` rows and blocks their batch if #900 slips.
high | `src/lib/solicitation/dispatch.ts:1580` | The tx1/provider/tx2 shape loses a provider-accepted send when tx2 rolls back, then falsely resolves the outbox on BullMQ re-entry.
high | `src/lib/solicitation/dispatch.ts:695` | A per-location place-ID configuration defect is retried and terminalized as `send_exhausted`, losing every affected contact instead of surfacing a remediable location hold.
medium | `src/lib/solicitation/dispatch.ts:466` | Slow-gate safety relies on application convention, not an enforced immutable-artifact boundary; tx1 never proves it is sending the bytes that were re-linted and re-moderated.

=== DETAIL ===

1. Decision 9 is not safe to ship independently of #900. The only D12d references in production code are comments. A fresh invocation finds `sending`, completes the outbox attempt, and returns without terminalizing the outreach. That removes watchdog ownership while leaving the row live. A deploy/crash after tx1 therefore leaves a permanent `sending` row, an unclosed batch, and potentially consumes the location’s active-batch slot. Bundle the minimum unknown-terminalizer with this feature, or make #900 a hard enablement dependency.

2. The claimed D12a recovery is false in the important case: provider accepts the email, then tx2 fails. The provider ID exists only in memory; the handler throws; BullMQ re-invokes; the `sending` resume path completes the outbox and exits. No watchdog then owns the terminal facts, and later bounce/complaint correlation cannot use the lost provider ID. This needs an explicit reconciliation/settlement design, not just an eventual `unknown` status.

3. `buildReviewLink` throws inside tx1 for an expected legacy-data condition. The transaction rolls back with the outreach still `queued`; configured BullMQ retries are spent; the exhaustion hook then turns it into generic `send_exhausted`. Correcting the business’s place ID later does not restore the lost cohort. The deviations record already identifies per-location handoff readiness as the appropriate owner. Validate/hold the location before releasing children, or introduce a distinct remediable disposition.

4. ADR 0020 makes post-approval regeneration refuse through the domain module, but it deliberately adds no schema protection. The database permits body mutation; `ArchivalPoller` already changes these columns for terminal rows. Because slow evidence is taken from an unlocked read and tx1 re-reads the body without checking a digest/version, a future repair or writer can make the worker moderate old bytes and send new ones. Add an immutable-after-approval DB guard or pass a content digest into tx1 and retry when it differs.

=== LOW CONFIDENCE ===

None.

VERDICT: REVISE

---

# Orchestrator triage

## A1 + A2 — ACCEPT the finding, REJECT a code change: #900 becomes a HARD enablement dependency

**Both claims verified in code.** `dispatch.ts:1315` — the `sending` resume path calls
`markOutboxCompletedIfOwned`. So after a crash between tx1 and tx2 the outbox attempt is
completed on the next invocation while the row stays `sending`: watchdog ownership is released
and nothing terminalizes it. Consequences are exactly as reported — the batch never settles (a
`sending` row is not a **Settled batch**), D8's one-active-send index then blocks new batches for
that location, and if the provider had accepted, `provider_message_id` is lost so a later bounce
is unattributable.

**Why #899 cannot fix it inline** — considered three ways and all fail:
1. *Terminalize `unknown` immediately on the resume path.* Wrong: `UNKNOWN_GRACE_MINUTES` exists
   precisely because the grace must exceed the outbox watchdog's 15-minute re-pend window, or a
   **normally-recovering** row is declared indeterminate. Immediate terminalization stomps rows
   that were about to recover.
2. *Do not complete the outbox attempt, let it exhaust.* The BullMQ job returns normally, so
   BullMQ does not retry; the outbox watchdog re-pends instead and eventually terminalizes the
   OUTBOX row without writing any domain row. The Outreach row is still wedged, just later.
3. *Let the failed hook write `failed`/`send_exhausted` for a `sending` row.* This is D12d's
   named lie-with-teeth: the restraint policy's `over_contacted` check reads prior sends, so
   calling a possible send "not sent" can put that customer in a future batch and email them
   twice.

The grace-period sweep is genuinely the releaser's. The reviewer's own second option is right.

**Resolution — recorded in three places so it cannot be missed:** #900 is a **hard enablement
dependency**. `SOLICITATION_SEND_ENABLED` must NOT be flipped in any environment until #900's
D12d `unknown` sweep ships.

**Exposure is gated today, verified:** the flag is off in every environment (every
`SOLICITATION_SEND_ENABLED=true` occurrence in the repo is documentation or a boot assertion,
not an env file), and `UNKNOWN_GRACE_MINUTES` has no implementation at all — it exists only as
comments in `dispatch.ts`. So no row can reach `sending` until someone deliberately flips a flag
that #900 must land before.

**For #900's author:** a row your sweep terminalizes `unknown` may correspond to a DELIVERED
email whose `provider_message_id` was lost with the crashed process. Treat `unknown` as
"possibly contacted" for over-contact purposes (D12d already says this) and expect a small
population of genuinely unattributable bounces.

## A3 — ACCEPT the concern, REJECT the change here; already filed

This challenges locked decision 10, which the owner took with the alternatives in front of them,
including the withhold option and its migration cost. The reviewer's proposed fix — "validate/hold
the location before releasing children" — is **already** the D11 step-8 follow-up: the **Send
handoff** withholds a whole location for a missing **Attested postal address**, and a missing or
non-canonical place id is the same class of fact. The disagreement is about timing, not
direction. Surfaced to the owner rather than silently deferred.

## A4 — ACCEPT, and FIX. Its example is wrong; its general form is right.

**The specific example does not hold.** `ArchivalPoller` selects on
`sent_at < NOW() - BODY_RETENTION_DAYS` and takes `FOR UPDATE SKIP LOCKED` explicitly "to keep
the sweep off a row a send worker currently holds" (`ArchivalPoller.ts:261-271`). A `queued` row
has `sent_at IS NULL`, so the predicate is NULL and the row is never selected. Recorded because
a triage that accepts a wrong premise is how a false conclusion gets enshrined.

**The general form survives and is worth code.** Slow evidence is gathered from an UNLOCKED read;
tx1 then re-reads the row and sends whatever it finds, without proving the bytes are the ones
that were linted and moderated. Today only convention (ADR 0020's refusal, which lives in a
domain module, not the schema) stands between that and sending unmoderated copy. The fix is
cheap and turns the branch's central guarantee — "we send exactly what we moderated" — from an
assumption into a check.
