# ADR 0022 — The solicitation lane gets a rate cap, not a yield

## Status

Accepted — 2026-08-22 (#923). Amends the deliverability spec
`docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` **§7.1**,
last bullet, and the **#630** row of that spec's §11 per-ticket binding table.
Does not amend §3.3's ramp stages or §3.2B's Send breaker — those govern
*volume*; this governs *priority* between two lanes sharing one provider quota.

## Context

§7.1 asks for a yield:

> **Dispatch yields to transactional** on the shared 10 req/s team limit. The
> drip worker is the low-priority consumer — an approval email must never be
> rate-limited behind a batch of asks.

The obligation was assigned to **#630**, carried forward as a named grilling
fork on **#899** with the instruction "do not leave it unowned", and answered by
**#900** with a release budget rather than a yield. What shipped:

| Dial | Value | Where |
|---|---|---|
| Per-tick release budget | `RELEASE_PER_TICK_BUDGET = 2` | `src/lib/solicitation/release.ts` |
| Release poll interval | `DEFAULT_INTERVAL_MS = 60_000` | `worker/background/pollers/SolicitationReleasePoller.ts` |
| Send-worker concurrency | `concurrency: 1`, boot-asserted | `worker/index.ts`, `assertSingleConcurrencyWorker` |

The releaser is the sole producer of `solicitation_send` jobs, so a per-tick
budget is the only scheduling lever it owns. Combined with single-concurrency on
the send worker, the solicitation lane emits at most **2 provider calls per
minute**.

**That is a rate cap, not a yield, and the difference is real.** The budget is
open-loop: it bounds the solicitation lane's own throughput and never reads what
the transactional lane is doing. Under a transactional spike it does not defer,
because it cannot see one. §7.1 asks for a priority relationship between two
producers; #900 shipped a constant.

**The arithmetic, recorded here so it is never re-derived.** Resend's limit is
10 req/s *per team*, not per key — a separate `SOLICITATION_RESEND_API_KEY`
(§1.6) does not split it. Ten per second is ~864,000 sends/day. §3.3's ramp tops
out at a **5,000/day platform ceiling**, so at the highest planned stage the
solicitation lane consumes about **0.6%** of the team limit. Instantaneously the
lane is bounded tighter still: 2 sends per 60s is **0.033 req/s**, about
**0.33%** of the limit, and single-concurrency means it cannot burst above that
average. Two per minute against ten per second is not contention.

## Decision

**Record the refusal. The budget plus single-concurrency IS the accepted answer
to §7.1 at every planned ramp stage. No shared limiter view is built.**

The alternative — one place both lanes consult, with the solicitation lane
deferring — is a real mechanism defending against contention that the numbers
above say cannot occur inside the planned envelope. Building it now would add a
cross-lane coupling, a new failure mode in the send path, and a second reader of
provider-quota state, to buy nothing measurable.

**What is NOT decided:** that a yield is never needed. It is needed the moment
the bound above stops holding. The bound is a product of four dials, and the
whole point of this ADR is that a person raising one of them will not otherwise
know that §7.1 is what they are spending:

1. **`RELEASE_PER_TICK_BUDGET` above 2** — the direct lever, and the one a
   ramp-stage operator reaches for first when a batch drips too slowly.
2. **Send-worker concurrency above 1** — `assertSingleConcurrencyWorker`
   forbids it at boot today, so this is a deliberate act.
3. **Parallelizing the releaser across replicas** — already flagged in #900's
   intake as requiring the cap resolution to be revisited; the same change
   invalidates the burst bound here.
4. **A second `MessagingAdapter` tenant sharing the Resend team** — a producer
   this arithmetic never counted.

**The pin.** `src/lib/solicitation/__tests__/dispatch-rate-bound.test.ts`
asserts dials 1 and 2 exactly, and re-derives the share of the team limit from
them. Raising either dial turns that test RED with this ADR named in the failure
message. That is the mechanism connecting the spec to the code, whose absence
issue #923 called the unacceptable part of the previous state: "the spec asks for
a mechanism, the code substitutes a constant, and nothing connects the two."

## Consequences

- **§7.1 stops asking for something the codebase decided not to build.** The
  bullet now records the decision and points here. `.claude/reference/env-vars.md`'s
  `SOLICITATION_RESEND_API_KEY` row and `RELEASE_PER_TICK_BUDGET`'s docstring
  say the same thing, in the same words, with one owner — this file.
- **A transactional spike can still starve nothing, and cannot be *proven* to
  starve nothing.** The lane's share is bounded by construction; what is not
  bounded is the transactional lane's own burst. If an approval email is ever
  observed rate-limited by Resend, this ADR is the first thing to re-open — the
  right response is to build the limiter view, not to lower the budget further.
- **Raising a dial is now a two-file act**, deliberately: the constant and this
  ADR. A green test suite after a dial change means someone read the arithmetic.
- **The Send breaker, the platform ceiling and the account cap are unaffected.**
  They govern how much mail goes out; this governs whose mail goes first.
