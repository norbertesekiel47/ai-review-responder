# #644 — deviations from the plan

Entries are things plan revision 7 did not anticipate. Each gets a triage verdict
(ACCEPT / RE-PLAN) at step 6.5, before any review agent sees this file.

---

## D1 — `SESSION_COOKIE_SECRET` rotation invalidates delivered unsubscribe links

**Raised** 2026-08-03, step 4 start, before T1a was dispatched. The handoff named this
as the open question on §1.4a ("confirm whether a `SESSION_COOKIE_SECRET` rotation would
invalidate delivered links"). It does.

**Mechanism.** §1.4a keys `isWellFormedUnsubscribeToken` on `getSessionCookieSecret()`
(`src/lib/shared/session-cookie-secret.ts:9`). `token_hash` is an *unkeyed* SHA-256, so a
rotation does not corrupt the lookup — it makes every **already-delivered** link fail the
admission gate and land on 503 (ingress) or the neutral page (landing), while the token row
remains perfectly valid and redeemable. CAN-SPAM §7704(a)(3) requires the link operate
≥30 days, so the failure is statutory, silent, and indistinguishable from a genuine unknown
token by design (§5.4).

**Pre-existing, not introduced.** Rotation already breaks the keep-my-data offboarding token
today — `src/lib/account-offboarding/tokens.ts:24` derives the raw token as a deterministic
HMAC under the same secret and persists only its hash. #644 raises the consequence to
statutory grade; it does not create the coupling. `SESSION_COOKIE_SECRET` has no entry in
`.claude/reference/env-vars.md` at all, and no rotation procedure exists anywhere in the repo
(it is asserted at worker boot only — `worker/config/startup-assert.ts:449`).

**Owner decision 2026-08-03: document-only constraint.** Options weighed were dual-secret
verification (`SESSION_COOKIE_SECRET_PREVIOUS`), a dedicated never-rotated
`SOLICITATION_UNSUBSCRIBE_TOKEN_SECRET`, and withdrawing the HMAC gate. Document-only was
chosen: it costs no code and no new secret to provision, and the two rejected code options
each add a path for an event that has never happened and still has no procedure. Withdrawing
the gate was rejected outright — it reopens owner-run #3 findings 2 and 3 (the unbounded
unauthenticated DB path and the bulkhead loss path that revision 7 deleted).

**Deliverable, owned by T3** (`.claude/reference/env-vars.md` is already in
`allowed_edit_surface`, so this needs no surface amendment):

- Add a `SESSION_COOKIE_SECRET` registry entry stating it MUST NOT be rotated without a
  documented procedure, and naming **both** blast radii: in-flight unsubscribe links
  (statutory, ≥30 days) and keep-my-data offboarding tokens.
- State the escape hatch explicitly — if a rotation ever becomes necessary, dual-secret
  verification is the scoped follow-up, and it must land *before* the rotation, not after.

**Not a surface amendment. Not a re-plan trigger.** §1.4a's design is unchanged; T1a's spec
is unchanged. The residual risk is accepted and now visible instead of silent.

---

## D2 — §1.5's redaction fix was incomplete: Fastify logs the 404 URL as a message string

**Raised** 2026-08-03 by the T1a implementer, commit `2e181fc0`.

Plan §1.5 closed the unmatched-404 leak with a pino `logger.serializers.req`. That is
necessary but **not sufficient**. Fastify's default 404 handler logs
`Route GET:/ingress/unsubscribe/<token>/extra not found` as a **plain message string**, and
pino serializers bind only to the `req`/`res`/`err` objects — never to the message. So the
exact case §1.5 was written for still leaked the raw Unsubscribe token, violating
invariant #5.

Fastify writes the URL in **two distinct shapes**, and the plan only knew about one:

| Shape | Emitted by | Reached by |
|---|---|---|
| serialized request object | `incoming request`, before `onRequest` and before routing | `serializers.req` |
| plain message string | the default 404 handler | `hooks.logMethod` |

**Closed in the same file** with a pino `hooks.logMethod` applying the *same single rule*
(`redactSensitivePathsAndQueries`) to every string argument. One rule, now three sinks
(Sentry, the request serializer, the log message).

**Scope.** `worker/config/fastify-options.ts` is already in `allowed_edit_surface` as surface
amendment #2, so this widens nothing — it is a correction *within* the amendment the plan
already spent, not a third amendment. It is correctly scoped to the Fastify server logger
only; `createWorkerLogger` (`src/lib/shared/logger.ts`) is a separate logger and is untouched,
so CLAUDE.md's "string args are logged verbatim" note still holds for the worker's own
structured logging.

**Verdict: pending** — held until the T1a spec reviewer's empirical confirmation that the
raw token really does appear without the hook and really does not with it. The plan has twice
been wrong about Fastify logging behaviour when reasoned about rather than measured, so this
one is being measured.

---

## D3 — receipt TTL is single-sided by design

**Raised** 2026-08-03 by the T1a implementer.

`verifyUnsubscribeReceipt` rejects `age > 10 minutes` but accepts a future-dated
`issuedAtMs`, rather than enforcing a symmetric window. Rationale: a lower bound would reject
the *common* case under ordinary clock skew between serverless instances.

Assessed and **ACCEPT**. A future-dated receipt is only mintable by a holder of
`SESSION_COOKIE_SECRET`, so it is not an attacker-reachable vector — the worst case is our own
clock being wrong, which extends one receipt's window and is bounded by §1.8's rule that a
receipt is **never sufficient on its own**: the render-time ledger read still governs whether
the success claim is true.

---

## D4 — the admission gate throws on missing `SESSION_COOKIE_SECRET` (fail-closed)

**Raised** 2026-08-03 by the T1a implementer.

`isWellFormedUnsubscribeToken` propagates the config error rather than returning `false`.
Deliberate: returning `false` would silently reclassify every genuine opt-out as malformed —
a silent statutory failure, and exactly the false-neutral class this ticket keeps closing.
The error is reachable only by misconfiguration, never by hostile input.

**Carried as a constraint into T1c and T2** (not a defect):

- The worker asserts `SESSION_COOKIE_SECRET` at boot (`worker/config/startup-assert.ts:449`),
  so the ingress cannot hit this in practice; its adapter still catches and returns 503 with a
  Sentry event, per §9.1.
- **Vercel does not assert it** — `src/lib/config/server.ts:104` reads it as optional. The
  landing page must therefore let this error **propagate loudly** (500) and must NOT swallow
  it into the neutral page. Rendering "we couldn't find that" when the real cause is a missing
  secret would make every opt-out fail invisibly — the precise failure mode §1.8 exists to
  prevent.
