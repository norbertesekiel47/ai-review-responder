# #644 plan revision 4 — owner-run `/codex:adversarial-review`

**Run by:** repository owner (the command is user-invocable only — which is very likely why
all four programmatic attempts at round 4 failed).
**Target:** branch diff against `main` · **Verdict: needs-attention** · 3 high findings.
All three **ACCEPTED**. Addressed in plan **revision 5**.

> "Do not ship this plan. It can display a false unsubscribe confirmation, leaves an
> unbounded logging path, and its execution artifacts contradict the current revision."

---

## 1. HIGH — attacker-controlled query parameter produces false unsubscribe success

The success state rendered solely from `?done=1`, explicitly without checking redemption
state. So `/u/bogus?done=1` claims the visitor is unsubscribed even though no token resolved
and no suppression was written — contradicting the neutral-page requirement for unknown or
malformed tokens, and misleading recipients who may then keep receiving requests.

**Verdict: ACCEPT.** This was raised during the original grilling and I judged it
"bounded — nobody does that." That was wrong. The cost of being wrong is a recipient who
stops watching for mail that keeps arriving, on the one path that is legally required to
work.

**Fix (revision 5 §1.8):** bind the success view to a server-minted **signed receipt**.
`POST /api/u/<token>` mints `?ok=<issuedAt>.<HMAC-SHA256>` keyed on `getSessionCookieSecret()`
— the same trust boundary `src/lib/account-offboarding/tokens.ts` already uses — **only**
after the write commits, and only for `redeemed` / `already_suppressed`. The page renders
success only when the receipt verifies against `hashUnsubscribeToken(token)` via
`timingSafeEqual` and is inside a 10-minute TTL; otherwise it falls through to the button or
neutral page. No cookie (so cookie-blocking browsers still see success after a real opt-out)
and no JS (so the progressive-enhancement flow survives). The receipt authorises nothing —
it is a claim check that this server just wrote that suppression.

## 2. HIGH — unknown-token logging remains an unbounded amplification path

The route is deliberately unauthenticated and exempt from rate limiting, yet revision 4
emitted a warning for every arbitrary unknown token. "Bounded by request volume" supplies no
bound under scanning, hostile traffic, or provider retry storms; it can create unlimited
log-ingestion cost and drown the mint-race signal it exists to expose. **Other ingress
routes are not equivalent, because they retain the global limiter.**

**Verdict: ACCEPT** — and the false equivalence is the part worth recording. Revision 4 also
over-corrected: round 3's finding was that the counter's *single-replica premise* was wrong,
not that aggregation was wrong. Revision 5 keeps the aggregate and fixes the premise.

**Fix (revision 5 §1.6):** at most **one** line per 60s per process, carrying `count`,
window bounds and `replica_id` (from `worker/config/replica-identity.ts`) so counts **sum
across replicas** during a cross-deployment overlap instead of silently under-reporting.
Partial windows flush via the existing graceful-shutdown sequence; an ungraceful crash loses
≤60s of counts, which feeds no correctness decision. Unknown tokens get **no** per-request
line and **no** Sentry event. Test required: hostile traffic inside one window produces at
most one warning, with an accurate count.

## 3. HIGH — handoff and intake at incompatible revisions

The handoff named stale HEAD `d8373026`, called the plan revision 2, claimed one commit, and
still required Sentry for unknown tokens — while HEAD was `c468bc90` and revision 4
explicitly forbids that event. `.feature/state.json` still recorded the old HEAD and a stale
intake hash, and `.feature/intake.json` was absent (parked between sessions), so the
mandated resume workflow would stop at `arm-check`.

**Verdict: ACCEPT.** My handoff edits had been partial — exactly the stale-doc drift I would
flag in anyone else's work, and blocking, because a resumer would implement superseded
behaviour.

**Fix:** `.feature/state.json` regenerated at `c468bc90`; arming and committed intakes
verified byte-identical; handoff HEAD, revision number, commit count, telemetry decision,
gate test count, and next actions all rewritten; the parked-worktree convention documented
so `arm-check` failure is self-explanatory. A residual contradiction sweep also caught two
intake entries still promising a per-request warn log and a Sentry report for unknown
tokens.

---

## Not raised, and worth noting

The review did not challenge the claim-first ordering, the route-config rate-limit
exemption, `logLevel: 'silent'`, the type augmentation, the cross-account predicate, or the
scrub rule order — the areas closed by codex rounds 1–3 and by the empirical verification in
commit `ae28c6e5`.
