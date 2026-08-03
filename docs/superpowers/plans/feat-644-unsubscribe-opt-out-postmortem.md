# #644 — post-mortem at step 3 (plan), after six revisions and six adversarial passes

**Written because two workflow abort criteria fired simultaneously**, not because the work
is unsalvageable. No implementation code was ever written; the branch is 11 documentation
commits. Nothing is lost by stopping here — that is the point of stopping here.

## Why this stopped

| Trigger | Detail |
|---|---|
| **2nd surface amendment** | Owner-run #3 finding 1 can only be fixed in `worker/config/fastify-options.ts`, outside the 21-glob `allowed_edit_surface`. Amendment #1 (`sentry-scrub.ts`) was spent in round 1. The workflow treats a 2nd as an abort trigger. |
| **A finding class recurring a 3rd time** | Three distinct false-success vectors in three consecutive passes: `?done=1` (owner-run #1), spent-token replay after a Correction-path removal (#2), receipt outliving the ledger (#3). |

I had also named this exact tripwire to the owner one message earlier: *"if the next pass
finds a third distinct false-success vector, that's the signal the design is wrong rather
than the prose."* It did.

## Root cause of the recurring class

Every false-success vector has the same shape: **the success page asserts a fact about
mutable ledger state using evidence that is decoupled in time from that state.**

- v1 `?done=1` — evidence was a *query parameter*: no binding to anything.
- v2 spent-token — evidence was `redeemed_at IS NOT NULL`: binding to a *past* redemption,
  not a present suppression.
- v3 receipt — evidence was an *HMAC minted earlier*: binding to a suppression that existed
  at mint time, for a 10-minute window in which the Correction path can remove it.

Each fix replaced one point-in-time attestation with a better point-in-time attestation. The
ledger is **mutable by design** (§8.2 Correction path), so *no* carried proof can be
sufficient. The invariant is not "hold better evidence" — it is:

> **A page may claim "you are unsubscribed" only from a ledger read taken during that
> render.** A receipt can gate *whether we are permitted to show the success state* (§5.4
> enumeration resistance); it can never establish that the claim is *true*.

I stated an invariant in revision 6 ("a receipt is never issued without a live suppression")
but attached it to the *minting* moment rather than the *rendering* moment, which is why v3
survived it.

## The genuinely unresolved problem — and it is spec-level, not plan-level

Findings 2 and 3 are not patchable inside this ticket:

- §9.2 forbids rate limiting on both unsubscribe paths, because a throttled unsubscribe is a
  silently-lost statutory opt-out.
- Both paths perform **unauthenticated database work**. The Vercel half fans out across
  serverless instances, so no in-process bound applies; the shared Supavisor backend is the
  contended resource.
- Any admission control that sheds load re-introduces the exact loss §9.2 exists to prevent
  — and §1.7 already concedes there is **no evidence providers retry a 503**.

So: *bound the work and you may drop a statutory opt-out; don't bound it and an anonymous
flood can delay every opt-out plus unrelated writes.* That is a **conflict between locked
spec decisions**, and the ticket-seeded rule says a decision that looks wrong at
implementation time goes back to the map, not into a plan revision.

## What is genuinely settled and should be reused, not rebuilt

Six passes closed a lot. None of it has re-broken:

- **Claim-first ordering** with `RETURNING` provenance — verified 6/6 against a live PG16 DB
  with real concurrent transactions (commit `ae28c6e5`), including the mint-race window and
  the rollback case.
- **Rate-limit exemption keyed on resolved route config**, both arms (resolved route OR
  decoded path) — verified on Fastify 5.8.5, incl. `/%69ngress/…` and 404 sub-paths. This
  also uncovered a **live pre-existing production bypass** affecting all six ingress routes.
- **Sentry scrub rule order** — verified 12/12 with every shipped `/approve/` contract intact.
- **`FastifyContextConfig` augmentation**, cross-account fail-closed name resolution,
  `encodeURIComponent` at path boundaries, dual-lane mailto, first-write-wins reuse of
  `recordSuppression`.

## What I would do differently

1. **Verify, don't argue.** Every claim I *measured* held first time (3 for 3). Every claim I
   *reasoned* about runtime behaviour failed review (rev 2 logging, rev 3 `SELECT 1`, rev 4
   telemetry equivalence, rev 6 bulkhead no-loss).
2. **Fix classes, not instances.** Three false-success vectors and three artifact-drift
   findings each got an instance patch before a structural one.
3. **Bound the whole feature, not the half I was looking at.** The bulkhead covered Railway
   because that is where I was working; the Vercel half has the harder saturation profile.
4. **Escalate a locked-decision conflict immediately.** §9.2-vs-saturation was visible at
   owner-run #2 and I tried to engineer around it instead of naming it.
