# RepWorth — 1000-Business Readiness: Verdict

**Date:** 2026-06-18 (slimmed to a verdict 2026-06-19)
**Status:** Verdict only. The action list lives in
[`2026-06-17-worker-scaling-hardening-backlog.md`](./2026-06-17-worker-scaling-hardening-backlog.md)
(single source of truth). Launch posture: [ADR 0005](../adr/0005-beta-launch-posture.md).

> This document was a full 7-dimension scan against a **1000-business** target. A
> grill-with-docs-codex review (4 rounds, APPROVED) reframed it against the actual
> near-term target — a **10–50 business paid beta** — and merged its findings into
> the worker-scaling backlog so there is one action list, not two. Read this for
> the verdict; act from the backlog.

## Verdict

**Ready for a 10–50 paid beta with a small gate; NOT ready for 1000 as-is — but
the 1000-scale gap is configuration + targeted hardening, not a rearchitecture.**

Nothing in the system corrupts data or money at any scale — billing math,
idempotency, and tenant isolation are sound (verified). The failure mode at scale
is **degradation and operational blindness**, not corruption: drafts arriving late
under load, retention tables growing unbounded, and (before this work) no
automated paging.

## What gated the beta (shipped — see ADR 0005 / branch `harden/beta-launch-gate`)

1. **Owner-approval-only** (`AUTO_APPROVAL_ENABLED=false`) — the human-in-the-loop
   content-safety control for irreversible public posting.
2. **Alerting on silent pipeline failure / dropped paid work** — `HealthAlertPoller`
   (Sentry, non-email) + cost-cap alert + `SENTRY_DSN` hard boot gate + Sentry Cron
   dead-man + external `/ready` check.
3. **Two critical-path timeouts** — Resend send chokepoint, Upstash `commandTimeout`.

## What stays deferred to growth triggers (→ the backlog)

Worker concurrency raise, horizontal scale / multi-replica decoupling, OutboxPoller
priority/throughput, circuit breakers, ArchivalPoller drain loop, poller keyset
rewrites, Stripe-webhook async decoupling, admin-margin SQL pushdown, Upstash
`KEYS`→`SCAN`, the global cost-ceiling re-dimensioning / non-terminal redesign,
DB/Supabase capacity planning, and scale alerting (queue-depth / Redis-memory /
cost-%). Each is listed with its trigger in the backlog.

## Corrections to the original full scan

- **Double-send** is *mitigated, not eliminated* — the claim-before-send guard is
  not DB-unique and holds only under the single-worker + single-flight assumption;
  deploy-overlap or duplicate outbox rows can reopen it. Add a durable claim before
  any concurrency/replica change. (Backlog → "Corrections".)
- **"Billing is solid"** is narrowed — `invoice.payment_failed` is not
  subscription-scoped, so an unrelated invoice can wrongly flip a paying account to
  `past_due`. Beta mitigates with a subscription-invoices-only operating constraint;
  the code fix is deferred (backlog P4 #11).
- The **SerpAPI ranking timeout** the original scan flagged is now fixed (third call
  site), and the **Resend send timeout** is now in place — both on
  `harden/beta-launch-gate`.
