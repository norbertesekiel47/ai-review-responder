# Staging smoke — #967 post-purge global opt-out

**Date** 2026-08-26 · **Branch** `fix-967-post-purge-global-optout`
**Staging worker deploy** `28216992-9049-4f25-98d8-f61bc60660b3` — SUCCESS at
commit `ee02f72d`, the branch tip. Health `GET /api/health` → `{"status":"ok"}`.

Placed here rather than `docs/runbooks/evidence/` deliberately: that directory
is outside this run's `allowed_edit_surface`, and adding it would have been a
second surface amendment for a file the review directory already accommodates.

## Why a hand-signed probe

There is no way to make a real post-purge Resend event happen on demand. The
live-DB suite covers the lane's logic but never crosses the signature layer or
the worker's HTTP boundary, so the probe is what proves the deployed path.

Both requests are svix-signed exactly as `verifySignature` expects
(`HMAC-SHA256` over `${svix-id}.${svix-timestamp}.${rawBody}`, base64, header
`v1,<sig>`), carry the `lane: solicitation` tag, and use an `email_id` matching
no `solicitation_outreach` row — the state a bounce meets after a purge.

Probe script: `probe-967.mjs` in the session scratchpad. The webhook secret was
read from Railway into an environment variable and never printed.

## Results — every prediction held

| | Predicted | Observed |
|---|---|---|
| **A** `to: ["probe-967-20260826@example.test"]` | 200 | **200** `{"received":true}` |
| **A** ledger row | `scope='global'`, `account_id IS NULL` | **`global` · `complaint` · `email` · account_id NULL** |
| **A** inbound event | `status='processed'` | **`processed`**, no error |
| **B** `to` omitted | 503 | **503** `{"received":true,"retry":true}` |
| **B** inbound event | `status='failed'` | **`failed`** |
| **B** error message | no recipient address | `unattributed email.complained carried 0 recipient entries, expected exactly 1: probe_norec…` |
| **B** ledger row | none | none |

### Idempotency, proven on real infrastructure

Probe A was fired **twice** against the same handle, with different
`provider_message_id`s and different svix ids — so ingress dedup could not mask
it. Afterwards:

- `solicitation_suppressions` for that handle: **1 row**. First-write-wins held.
- `inbound_events LIKE 'probe967_%'`: **2 processed, 2 failed**. The split is
  exactly the designed one, with no event stuck in between.
- `analytics_events` where `event_name='solicitation_suppressed'` in the window:
  **1 row**, not 2. This independently confirms `recordSuppression`'s
  documented behaviour that the §9.4 event is skipped on the no-op path, so a
  redelivery never double-mints.

## What the two acked events prove about retention

`inbound_events.status='processed'` is not cosmetic. It is the column
`ArchivalPoller` sweeps on after 30 days, and nothing sweeps `'failed'` rows at
all. Before this change these events stayed `failed` forever, retaining a
recipient address indefinitely. The `processed` rows above are that retention
bound, observed rather than argued.

It is also what removes them from `checkFailedInboundEvents`' alert set — which
is exactly why the Sentry signal below had to be added.

## Not verified, stated plainly

**Sentry delivery was not observed.** `SENTRY_DSN` is set on the staging worker
(95 chars), so `worker/sentry.ts` initializes and `captureMessage` has a live
transport — but I did not open Sentry to confirm the
`solicitation_suppression_without_attribution` issue arrived. Two attempts to
capture the accompanying structured warn line from Railway logs both came back
empty: the MCP's search filter returned nothing, and `railway logs` tails from
invocation with no history, so a detached capture around the probe recorded no
lines. The call itself is a try/catch-wrapped `captureMessage` following the
in-repo precedent at `worker/ingress/stripe/subscription-updated.ts:154`, and
`the payload-recipient fallback never logs the recipient address` covers the
redaction half in the live-DB suite — but neither is a substitute for seeing
the issue in Sentry. **Worth one manual look before merge.**

## Residue left on staging

One `solicitation_suppressions` row for `probe-967-20260826@example.test`
(global, no account) and four `inbound_events` rows keyed `probe967_*`. The
address is fictional and staging is a disposable integration anchor, so these
are left in place as evidence rather than deleted. The Suppression ledger has
no expiry and no ordinary delete path by design; the admin Correction path is
the only remover, and using it here would be misusing a compliance surface for
test cleanup.
