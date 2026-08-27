# Codex adversarial review — round 1 (verbatim findings + orchestrator triage)

Target: branch diff against 40e79e6a. Verdict: needs-attention.
"No-ship: optional telemetry is on the redirect's critical path, anonymous
traffic can amplify unlimited durable writes outside current WAF coverage,
and QR rendering does not scale to the product's uncapped location counts."

## Findings (verbatim substance)

- [high] **A1 — Best-effort analytics can prevent the redirect**
  (`src/app/q/[businessId]/route.ts:73-89`). The handler AWAITS the analytics
  INSERT before returning the 302. A stalled INSERT (admission deadline 30s +
  statement_timeout 30s, or platform timeout) delays or kills the redirect
  even though resolution succeeded. The test covers immediate rejection, not
  delayed failure. Recommendation: 302 first, guarded INSERT via Next.js
  `after()`; regression test with an unresolved INSERT.

- [high] **A2 — The public route is an unbounded durable-write amplifier**
  (`route.ts:73-84`). Random event key per scan means ON CONFLICT cannot
  dedupe replays; one printed business UUID lets anyone mint unlimited
  analytics rows + PostHog events. The WAF runbook's enforcing coverage is
  `/api/*`; `/q/*` matches no enforcing rule. Sustained replay can outpace
  the 50-events/30s dispatcher, corrupt metrics, and consume the three-slot
  Vercel write pool. Recommendation: enforcing GET/HEAD `/q/*` edge rule
  before exposure; independently bound analytics writes under abuse.

- [medium] **A3 — Server-rendering print PNGs scales linearly with location
  count** (`review-qr.ts:97-110`). Measured ~131ms per 2048px image; 50
  locations ≈ 6.7s + 1.4MiB base64 before React serialization. The print
  page uses the ALL-location loader to render one location. Recommendation:
  preview/download split; single-location print query.

## Orchestrator triage (receiving-code-review, verified before verdicts)

- **A1 — ACCEPT (code fix this round).** Mechanically true: the await sits
  between resolve and the 302. `after()` (Next 15.1+ stable, present in the
  installed Next 16) is the platform-sanctioned post-response hook and makes
  the intake invariant ("never blocks the redirect") true under DELAY, not
  just rejection. Fix: wrap the guarded insert in `after()`; route tests
  gain a passthrough `after` mock plus a stalled-insert regression test.

- **A2 — ACCEPT AS OPS GATE, no in-code limiter.** The intake non-goal ("no
  rate limiting on the route — WAF owns the edge") was locked against the
  /r/google precedent, but codex names the asymmetry the intake missed:
  /r/google WRITES nothing; /q/ writes a durable row per hit, and /q/* sits
  outside the runbook's enforcing coverage. Resolution that honors the
  locked non-goal: no code limiter, but an ENFORCING GET/HEAD `/q/*` WAF
  rule becomes a MANDATORY pre-exposure item in the step-8 ship checklist
  (staging + prod, per `docs/runbooks/vercel-waf-rate-limiting.md`
  procedure), stated in the PR description for the owner's merge decision.
  A1's `after()` additionally decouples redirect availability from insert
  storms. Residual risk (metrics pollution below WAF threshold) accepted —
  scan metrics are directional, not billing.

- **A3 — PARTIAL ACCEPT.** (a) Print page: real waste — it generates QRs
  for EVERY location to render one. Fix this round: single-location loader
  (`getOwnerReviewQrLocation(sql, accountId, businessId)`) reusing repo's
  account-scoped read, one QR generated. (b) Preview/download split for the
  settings list: REJECTED for v1 — location counts are quota-bounded
  (`locations_included`), typical launch accounts hold a handful (~131ms
  each server-side), and the split doubles generation or reintroduces the
  dropped API endpoint. The scale ceiling gets a module-header note naming
  the on-demand endpoint as the escape when quotas grow.
