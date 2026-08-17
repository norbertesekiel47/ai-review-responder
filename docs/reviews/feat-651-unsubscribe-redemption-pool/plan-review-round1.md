# #651 Plan Review Round 1 — Root Triage

**Reviewer verdict:** REVISE  
**Root verdict:** all three findings ACCEPTED  
**Owner decision:** approved the corrections on 2026-08-16

## Finding 1 — intake contradicted the admission deadline

**ACCEPT.** The intake simultaneously forbade admission rejection and required
the #773 admission wrapper. `src/lib/db/admission.ts` proves its queue expires
with `DbSlotTimeoutError`; two transactions holding both slots for 30 seconds
can therefore make a third valid opt-out take the existing sanitized `503`
path. The owner approved treating this as an accepted infrastructure failure,
not an immediate busy shed. Both intake copies and the plan now say so.

## Finding 2 — same-token replay did not exercise pool capacity

**ACCEPT.** `createRedemptionSingleFlight` collapses same-token concurrency to
one promise, so the original drill could pass without ever filling two slots.
The plan now requires three or more distinct valid tokens to exercise admission,
keeps a separate same-token replay arm, and requires `DB_ADMISSION_ENABLED` to
be enabled. Deterministic ingress tests will prove distinct tokens do not share
the single-flight entry; db-server/admission tests pin the resulting production
client at cap two.

## Finding 3 — 16 warm isolates left no Max-Clients headroom

**ACCEPT.** `24 + 16×11 = 200` equals the approximate Supavisor client ceiling
and is not a safe operating bound. The plan now uses 15 (`24 + 15×11 = 189`).
ADR 0009's roughly 52/57 compound backend case becomes a conservative roughly
54/57 after the new two-slot worker client, so the staging gate now combines
redemption, worker, and Vercel pressure and retains the 46-of-57 abort threshold.

## Round disposition

The plan and intake were revised. A fresh round-2 skeptic must confirm the
corrections before implementation.
