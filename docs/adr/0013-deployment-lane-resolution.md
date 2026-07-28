# ADR 0013: Deployment-lane resolution — precedence for the name, union for the gate, and the one site that must not migrate

## Status

Accepted — 2026-07-28 (issues #610, #611)

## Context

The worker asked `NODE_ENV` a question `NODE_ENV` cannot answer: *which
deployment lane am I in?* Verified live against Railway on 2026-07-28:

| | staging | production |
|---|---|---|
| `NODE_ENV` | `production` | **unset** |
| `RAILWAY_ENVIRONMENT_NAME` | `staging` | `production` |
| `SENTRY_DSN` | set | absent |

Both open issues fall straight out of that table.

- **#610.** Staging answers "production". `worker/sentry.ts` tagged every event
  and every `health-alert-poller` cron check-in `production`, so staging noise
  was indistinguishable from a real production page and the cron monitor grew a
  `production` environment that no production process ever wrote.
- **#611.** Production answers `undefined`. Every one of the five
  `NODE_ENV !== 'production'` tests in `worker/config/startup-assert.ts`
  evaluates true in the production Railway environment. Three of them are the
  whole condition, so `assertAlertSinkEnv`, `assertAdminNotificationEmail` and
  `warnMissingProductionEnv` become unconditional no-ops there. (The other two
  are the `assertStripeWorkerEnv` / `assertCoreInfraEnv` mock-skips, whose
  second conjunct `MOCK_EXTERNAL_APIS === 'true'` is false in production — so
  those two survived on an unrelated setting rather than on the gate.)
  `assertAlertSinkEnv` exists precisely so that paging cannot be silently inert
  in production (ADR 0005, plan A1) — and in production it was the inert thing.

`RAILWAY_ENVIRONMENT_NAME` is the documented Railway system variable, injected
into every service in every environment. `RAILWAY_ENVIRONMENT` is an
undocumented legacy alias that Railway also injects; the codebase uses the
documented name. The precedent already existed —
`worker/config/replica-identity.ts` read it — it had simply never been made the
answer to "which lane".

"Lane" is `.claude/CLAUDE.md` → "Environments & branches" vocabulary
(preview / staging / production). This ADR does not coin a new sense of the
word; it names the runtime signal that resolves the one already in use.

## Decision

### 1. One authoritative owner

`src/lib/config/deployment-lane.ts` (three exports: `deploymentLane`,
`requiresProductionConfig`, `deploymentLaneFields`). It lives under
`src/lib/config/` rather than `worker/config/` because `src/lib/shared/logger.ts`
and `src/lib/config/worker.ts` are call sites and the dependency direction is
one-way — `worker/` imports from `src/lib/`, never the reverse (invariant #1).
It is its own file rather than part of `src/lib/config/flags.ts`, which owns
boolean `*_ENABLED` feature flags: a deployment lane is not a feature flag.

### 2. Precedence for the lane NAME; UNION for the gate predicate

These are two different rules that happen to read the same two variables, and
collapsing them re-introduces one of the two bugs.

- **The lane name resolves by PRECEDENCE.** `RAILWAY_ENVIRONMENT_NAME` wins
  whenever present, then `NODE_ENV`, then `'development'`.
- **`requiresProductionConfig()` is the UNION** — `RAILWAY_ENVIRONMENT_NAME`
  present **or** `NODE_ENV === 'production'`.

Issue #611's own suggested fix — `RAILWAY_ENVIRONMENT === 'production' ||
NODE_ENV === 'production'` — is **rejected**. Staging sets *both* signals, so a
`||` used to decide the lane *name* classifies staging as production. That is
exactly #610, re-created by the fix for #611.

The union is correct for `requiresProductionConfig()` because it answers a
different question: not "where am I" but "must this process satisfy
production-grade config?". Being broad is the point — every environment that
enforces today keeps enforcing, and the production Railway lane is added.

### 3. The safety property is stated over EFFECTS, not over the literal `if`

Writing the migration's safety argument as "old predicate ⇒ new predicate" is
**unsound**. Seven of the twelve migrated sites are negative predicates
(`if (!P) return`), and with `Q = P || R`, `!P ⇒ !Q` is false exactly when
`P = false, R = true` — which is the live production case, i.e. the one case
this change exists for. Stated that way the property would appear to fail on
precisely the sites it must protect.

The sound contract has two halves, both reducing to `P ⊆ Q`, which holds by
construction because `Q` is the union of `P` with a second term:

| site kind | property | reading |
|---|---|---|
| enforcement (`assertProductionMockModeEnv`, `assertWorkerPublicUrlFormat`, the `OnboardingDemoWorker` mock-leak guard, the Fastify log level) | old-applies ⇒ new-applies | the set of environments where the restriction **applies** only grows |
| skip / permission (the negative early returns in `startup-assert.ts`, the `mockSkip` in `src/lib/config/worker.ts`, the `error_stack` gate in `src/lib/shared/logger.ts`) | new-skips ⇒ old-skips | the set of environments where enforcement is **skipped** only shrinks |

Sentry's `environment` in `worker/sentry.ts` is a **value mapping**, not a
predicate. It belongs to neither half and is verified by a lane-value test.

### 4. `isProductionLane()` was designed and deliberately not built

An earlier revision carried a third predicate, a lane-name equality check. Once
the offboarding purge poller left scope (below) it had **zero callers** — Sentry
consumes the lane *name*, not a boolean, and every gate wants the union. No
abstraction before the second concrete use; an exported predicate with no caller
is a liability, because the next reader has to guess which of three near-synonyms
their site wants.

## The site that FAILS the property: the offboarding purge poller

This is the cautionary tale, not a footnote. It is the reason the safety property
above must be checked per site against that site's own expression.

`worker/background/pollers/AccountOffboardingPurgePoller.ts` refuses the
`ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` shortener when
`NODE_ENV === 'production' || VERCEL_ENV === 'production'`. An intermediate
revision of this plan swapped that for `requiresProductionConfig()` and claimed
the swap was "bit-for-bit today's behaviour".

**That claim was false.** The union models `RAILWAY_ENVIRONMENT_NAME || NODE_ENV`
and has **no `VERCEL_ENV` term**. With `NODE_ENV='test'`,
`VERCEL_ENV='production'` and no Railway variable set, today's expression is
`true` (refuse the override) and the union is `false` (permit it). The swap would
have *widened permission* on a destructive path: the override widens the poller's
claim predicate and writes only `purge_started_at`, never `purge_after`, so the
`enforce_account_offboarding_purge_after_token_expiry` trigger
(`supabase/migrations/056_account_offboarding.sql`) cannot fire on it and the
claim query carries no active-token predicate. Enabling it in that environment
could purge a row early *and* revoke a live keep-my-data token, with no way to
cancel an already-enqueued purge. `AccountOffboardingPurgePoller.test.ts:459-462`
pins exactly that combination and would have failed.

**So the file is not touched at all.** It keeps its raw `NODE_ENV`/`VERCEL_ENV`
read and is the single exemption in the CI rule below.

The general lesson, which is the reusable part:

> `requiresProductionConfig()` is only a safe substitute where the site's own old
> predicate is a **subset** of it. Monotonicity must be checked per site against
> that site's own expression — never against a single `NODE_ENV === 'production'`
> stand-in. Using the stand-in is what hid this defect through a whole review
> round.

The underlying gap — that the override can widen a destructive claim predicate at
all — is tracked as **#614**.

## Consequences

- **Vercel behaviour is unchanged by construction.** On a *deployed* Vercel build,
  production or preview, `NODE_ENV` is `'production'` and no `RAILWAY_*` variable
  exists, so `requiresProductionConfig()` returns exactly what
  `NODE_ENV === 'production'` returned. This is what makes the migration safe for
  `src/lib/shared/logger.ts`, which Next.js server code reaches.

- **`next dev` has an opt-in local effect, accepted.** `next dev` sets
  `NODE_ENV='development'`. A developer who *also* exports
  `RAILWAY_ENVIRONMENT_NAME` in their local shell flips the union true and loses
  local `error_stack` output from `src/lib/shared/logger.ts`. It requires
  deliberately exporting a Railway-injected variable locally, it is local-only,
  and it is recorded here rather than guarded against. The corollary for
  operators: never set `RAILWAY_ENVIRONMENT_NAME` by hand in a `.env` file.

- **The CI rule bans raw `NODE_ENV` under `worker/`, and `src/**` is deliberately
  out of scope.** `scripts/ci/static-policy-audit.ts` fails on statically
  identifiable raw `NODE_ENV` reads under `worker/`, with one path exemption
  (the purge poller). `src/**` is excluded as a decision, not an oversight:
  cookies, the logger, impersonation and destructive-auth all branch on
  `NODE_ENV` for genuine dev-vs-prod *runtime behaviour* rather than for lane
  identity, and each would need its own judgement-call allowlist entry. A rule
  whose allowlist is mostly judgement calls stops being a rule.

- **The CI rule has a known residual gap.** "Statically identifiable" excludes
  dynamic-key access (`const k = 'NODE_ENV'; process.env[k]`) and whole-object
  aliasing (`const env = process.env; env.NODE_ENV`). Neither is decidable
  without symbol resolution the audit does not have, and rejecting *all* dynamic
  `process.env[…]` access is not an option — `worker/config/startup-assert.ts`
  legitimately iterates required-variable lists that way, and the rule must not
  fire on it.

- **Removal trigger for the exemption.** Resolving **#614** — making the purge
  override incapable of widening the claim predicate against a live keep-my-data
  token — is what lets a future change delete both the CI exemption and the raw
  `NODE_ENV`/`VERCEL_ENV` read behind it. Until then the exemption is the honest
  record of a gap, and removing it without fixing #614 would trade a documented
  gap for an undocumented one.

- **Operational follow-up.** The `health-alert-poller` cron monitor in Sentry
  carries a stale `production` environment created while staging mis-reported
  itself, and will grow a correct `staging` environment on the first post-deploy
  check-in. The stale one must be deleted by hand; procedure and the expected
  single missed check-in are in `docs/runbooks/beta-launch-alerting.md` §2a.
