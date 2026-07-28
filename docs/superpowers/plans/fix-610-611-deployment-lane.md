# Plan — one authoritative deployment-lane owner (#610, #611)

Branch: `fix-610-611-deployment-lane`
Intake: `docs/superpowers/plans/fix-610-611-deployment-lane-intake.json`
RISK=high · SURFACE=backend · db_touching=false

> **Revision 5** — after adversarial round 4. Round 4 **cleared the destructive-path
> question**: all 12 migrated sites touch only early returns, throws, warnings, URL
> validation, log metadata and the Sentry tag; the purge poller's claim/write path
> is verified byte-for-byte untouched. Its remaining findings were all
> statement-level, and all are fixed here: the safety property is restated over
> **effects** (enforcement-set grows / skip-set shrinks) because the literal
> "old predicate ⇒ new predicate" form is unsound for the seven negative
> predicates; T4's guarantee is narrowed to *statically identifiable* reads with the
> dynamic-key and aliasing gap documented (and the legitimate dynamic reads at
> `startup-assert.ts:45,49,238` protected); the string-literal rationale, the
> "every worker site" wording, and the test/file counts are corrected.
>
> **Revision 4** — after adversarial round 3 (REVISE, all items verified correct).
> The purge poller is now left **completely untouched**: revision 3 swapped it to
> `requiresProductionConfig()` while claiming "bit-for-bit today's behaviour", but
> its old predicate carries a `VERCEL_ENV` term the union does not model, so the
> swap was non-monotonic on a destructive path — and it would have failed an
> existing test (`AccountOffboardingPurgePoller.test.ts:459-462`) that pins
> `NODE_ENV='test'` + `VERCEL_ENV='production'` → refused. It is now the one T4
> exemption, removable by #614. Also: monotonicity is asserted **per site** against
> each site's own old expression; T4 bans raw `NODE_ENV` reads under `worker/`
> outright (closing cross-file indirection at source) and covers template-literal
> access; an `OnboardingDemoWorker` guard test is added (its existing suite never
> reaches the guard); a `requiresProductionConfig()` whitespace test is added; and
> the intake's "nothing changes on staging" / "two Next-reachable modules"
> statements are corrected.
>
> **Revision 3** — after adversarial round 2 (REVISE, all 7 items verified correct).
> Changes: the purge-window override is **out of scope** and keeps today's
> behaviour (the round-2 High finding invalidated its safety argument — filed as
> **#614**); `isProductionLane()` is **not built**, since removing the purge change
> left it with zero callers; T4 uses the file's **existing AST mechanism** (my
> round-2 claim that the file had no AST precedent was factually wrong — it imports
> `typescript` and builds ASTs at seven sites); the Fastify signature change is
> stated as a **type-checker break** requiring same-commit test rewrites; the Vercel
> claim is narrowed to deployed builds with `next dev` documented; the
> `assertWorkerConfig` test target and the logger baseline instruction are corrected.
>
> Revision 2 changes retained: `src/lib/shared/logger.ts` and
> `worker/config/fastify-options.ts` are in scope (surface amendment #1).

## Problem

Both issues are one root cause: the worker asks `NODE_ENV` a question `NODE_ENV`
cannot answer — *which deployment lane am I in?*

Verified against Railway on 2026-07-28:

| | staging | production |
|---|---|---|
| `NODE_ENV` | `production` | **unset** |
| `RAILWAY_ENVIRONMENT_NAME` | `staging` | `production` |
| `SENTRY_DSN` | set | absent |

So staging answers "production" (#610: Sentry mis-tags every event and cron
check-in) and production answers `undefined` (#611: five production-only boot
gates return early and never run — including `assertAlertSinkEnv`, the gate whose
entire purpose is that paging cannot be silently inert in production).

`RAILWAY_ENVIRONMENT_NAME` is the documented Railway system variable
(`RAILWAY_ENVIRONMENT` is an undocumented legacy alias, also injected).
`worker/config/replica-identity.ts` already reads it — the precedent exists.

## Design

### The interface

New module `src/lib/config/deployment-lane.ts` — **three** exports:

```ts
deploymentLane(env?): string             // RAILWAY_ENVIRONMENT_NAME ?? NODE_ENV ?? 'development'
requiresProductionConfig(env?): boolean  // RAILWAY_ENVIRONMENT_NAME present || NODE_ENV === 'production'
deploymentLaneFields(env?): Record<string, string>   // { deployment_lane, lane_source }
```

Shape mirrors `replica-identity.ts`: an exported `DeploymentLaneEnv` interface, a
`platformLaneEnv()` doing **named** per-variable `process.env.RAILWAY_*` reads (so
`ci:process-env` treats them as platform indicators), and every public function
taking `env` with that default. Tests inject; production call sites pass nothing.

**No `isProductionLane()`.** It was designed for the purge-window override; with
that out of scope (#614) it would have zero callers, and Sentry consumes the lane
*name*, not a boolean. No abstraction before the second use.

### The two rules, and why they differ

- **The lane NAME resolves by precedence.** Railway wins whenever present.
  A `||` — which #611's suggested fix literally proposes — classifies staging as
  production, because staging sets *both* signals. That re-creates #610.
- **`requiresProductionConfig()` is the UNION.** Deliberately broad: it is
  "this process must satisfy production-grade config", not "where am I".

The union is what makes the change safe — but the property has to be stated over
**effects**, not over the literal `if` expressions. Writing it as "old predicate ⇒
new predicate" is unsound: seven of the twelve sites are *negative* predicates
(`if (!P) return`), and with `Q = P || R`, `!P ⇒ !Q` is false exactly when
`P=false, R=true` — the live production case, i.e. the one this change exists for.

The correct contract has two halves, both reducing to `P ⊆ Q`:

| site kind | property | reading |
|---|---|---|
| enforcement (`assertProductionMockModeEnv`, `assertWorkerPublicUrlFormat`, `OnboardingDemoWorker` guard, Fastify `warn`) | old-applies ⇒ new-applies | the set of environments where the restriction **applies** only grows |
| skip / permission (the five `!P` early-returns, `mockSkip` ×2, logger `error_stack`) | new-skips ⇒ old-skips | the set of environments where enforcement is **skipped** only shrinks |

Sentry's `environment` is a **value mapping**, not a predicate, and is verified by
a lane-value test rather than by either half above.

Each half is asserted by a test, checked per site against that site's own original
expression — never against a single `NODE_ENV === 'production'` stand-in. That
stand-in is exactly what hid the purge-poller defect in revision 3.

### Vercel

On a **deployed** Vercel build — production or preview — `NODE_ENV` is compiled to
`'production'` and no `RAILWAY_*` variable exists, so `requiresProductionConfig()`
returns exactly what `NODE_ENV === 'production'` returned. That is the case that
matters for `src/lib/shared/logger.ts`, which Next.js server code reaches.

`next dev` sets `NODE_ENV='development'`. A developer who *also* exports
`RAILWAY_ENVIRONMENT_NAME` in their local shell would flip the union true and lose
local `error_stack` output. Opt-in, local-only, and recorded in the ADR rather than
guarded against.

(Round 2 also correctly noted that `src/lib/config/worker.ts` has no demonstrated
Next.js consumers on the checked-in import surface — the Vercel argument is
therefore load-bearing only for `logger.ts`.)

### Home

`src/lib/config/`, not `worker/config/`, because `src/lib/config/worker.ts:250`
and `src/lib/shared/logger.ts:32` are call sites and the dependency direction is
one-way — `worker/` imports from `src/lib/`, never the reverse (invariant #1,
ESLint-enforced). `src/lib/config/` is already a `process-env-baseline.ts`
allowlist **prefix**, so no baseline entry is needed. New file rather than folding
into `flags.ts`, whose own header declares it the sanctioned reader for boolean
`*_ENABLED` **feature flags** — a lane is not a feature flag.

### Module depth

One new module with a small interface; **zero interface widenings** among the
migrated modules. Only `buildFastifyOptions` changes signature — from
`nodeEnv: string | undefined` to a boolean — which *narrows* it from "an env-var
string" to "the decision", and keeps it injectable. Depth here is for *locality*,
not pluggability: there is one adapter (`process.env`) and there should be.

## Call-site map (13 sites, 7 files)

| site | today | becomes |
|---|---|---|
| `startup-assert.ts:56` `assertProductionMockModeEnv` | `NODE_ENV === 'production'` | `requiresProductionConfig()` |
| `startup-assert.ts:71` `assertStripeWorkerEnv` mockSkip | `NODE_ENV !== 'production'` | `!requiresProductionConfig()` |
| `startup-assert.ts:87` `assertCoreInfraEnv` mockSkip | `NODE_ENV !== 'production'` | `!requiresProductionConfig()` |
| `startup-assert.ts:188` `assertAdminNotificationEmail` | `NODE_ENV !== 'production'` | `!requiresProductionConfig()` |
| `startup-assert.ts:208` `assertAlertSinkEnv` | `NODE_ENV !== 'production'` | `!requiresProductionConfig()` |
| `startup-assert.ts:229` `warnMissingProductionEnv` | `NODE_ENV !== 'production'` | `!requiresProductionConfig()` |
| `startup-assert.ts:295` `assertWorkerPublicUrlFormat` | `NODE_ENV === 'production'` | `requiresProductionConfig()` |
| `src/lib/config/worker.ts:250` `mockSkip` | `NODE_ENV !== 'production'` | `!requiresProductionConfig()` |
| `src/lib/shared/logger.ts:32` `error_stack` gate | `NODE_ENV !== 'production'` | `!requiresProductionConfig()` |
| `worker/config/fastify-options.ts:11` log level | `nodeEnv === 'production'` | boolean param from `requiresProductionConfig()` |
| `OnboardingDemoWorker.ts:55` mock leak guard | `NODE_ENV === 'production'` | `requiresProductionConfig()` |
| `worker/sentry.ts:8` `environment` | `NODE_ENV ?? 'development'` | `deploymentLane()` |
| `AccountOffboardingPurgePoller.ts:50` window override | `NODE_ENV === 'production' \|\| VERCEL_ENV === 'production'` | **UNCHANGED — not migrated** |

That is **12 migrated sites across 6 files**. The purge poller is the 13th
`NODE_ENV` site under `worker/` and is deliberately left alone (below), so it
carries the T4 rule's one exemption. The only other `NODE_ENV` occurrences under
`worker/` are the error-message string at `startup-assert.ts:57`, a comment at
`:181`, and test files — verified exhaustively.

### Why the purge override is NOT changed

Round 2 falsified the safety argument that justified changing it. The
`enforce_account_offboarding_purge_after_token_expiry` trigger is
`BEFORE UPDATE OF purge_after` (migration `056:224-228`), but the override never
writes `purge_after` — it widens the claim predicate
(`AccountOffboardingPurgePoller.ts:88-96`) and writes only `purge_started_at`
(`:124`). The trigger cannot fire on that path, and the claim query has no
active-token predicate, so enabling the override could purge a row early *and*
revoke a live keep-my-data token, with no way to cancel an already-enqueued purge.

Filed as **#614**.

Revision 3 then made a second mistake: it moved the site to
`requiresProductionConfig()` and called that "bit-for-bit today's behaviour". It
is not. The old predicate is
`NODE_ENV === 'production' || VERCEL_ENV === 'production'`; the union models
`RAILWAY_ENVIRONMENT_NAME || NODE_ENV` and has **no `VERCEL_ENV` term**. With
`NODE_ENV='test'`, `VERCEL_ENV='production'` and no Railway variable, today
refuses and the swap would permit — re-opening the exact destructive early-claim
path that #614 defers. `AccountOffboardingPurgePoller.test.ts:459-462` pins that
case, so the swap would also have failed an existing test.

**So the file is not touched at all.** It keeps its raw `NODE_ENV`/`VERCEL_ENV`
read and is named as the single T4 exemption, with #614 recorded as the trigger to
remove both the exemption and the underlying gap. `owner-offboarding-staging-dry-run.md:253`
stays true and leaves the edit surface.

The general lesson, recorded in the ADR: `requiresProductionConfig()` is only a
safe substitute where the site's old predicate is a **subset** of it. Monotonicity
must be checked per site against that site's own expression — not against a single
`NODE_ENV === 'production'` stand-in.

## Tickets (tracer bullets)

### T1 — owner module + Sentry tag + boot log  *(blocking edges: none)*

Fixes **#610 end-to-end**: env var → module → Sentry `environment` tag, plus the
success-proof log line.

- NEW `src/lib/config/deployment-lane.ts`
- NEW `src/lib/config/__tests__/deployment-lane.test.ts` (18 titles: 5 lane-name,
  7 `requiresProductionConfig`, 2 `deploymentLaneFields`, 3 safety-property,
  1 Sentry lane-value mapping)
- `worker/sentry.ts` — `environment: deploymentLane()`
- `worker/index.ts` — spread `deploymentLaneFields()` into the existing
  `[boot] 'Worker listening'` call alongside `replicaIdentityFields()`.
  **No second log line.**

### T2 — boot gates  *(blocking edge: T1)*

Fixes **#611**. Seven predicates in `worker/config/startup-assert.ts`, plus every
assert's error message gains the resolved lane and its source (the failure proof,
which must work when `SENTRY_DSN` is the missing thing).

- `worker/config/startup-assert.ts` (7 sites)
- `worker/config/__tests__/startup-assertion.test.ts` (7 titles), **and add
  `RAILWAY_ENVIRONMENT_NAME` to every `KEYS` save/restore list in the file** — a
  developer shell with that variable set would otherwise silently change verdicts.

Existing assertions must keep passing apart from that sanitisation. If one needs
its expectation rewritten, the union rule was implemented wrong: stop and re-plan.

### T3 — remaining lane call sites  *(blocking edge: T1; parallel with T2)*

- `src/lib/config/worker.ts` — `mockSkip()`; test targets **`assertWorkerConfig()`**,
  which is the function that actually has the mock-skip path (`getWorkerConfig()`
  does not). 1 title in `src/lib/config/__tests__/worker.test.ts`.
- `src/lib/shared/logger.ts` — `error_stack` gate (2 titles). **Do not** prune its
  `process-env-baseline.ts` entry: `serviceName()` still reads `LOG_SERVICE`
  (`logger.ts:23`).
- `worker/config/fastify-options.ts` — parameter becomes boolean;
  `worker/index.ts:176` passes `requiresProductionConfig()`. This is a
  **type-checker break**: all three existing calls in
  `worker/config/__tests__/fastify-options.test.ts:7,16,23` pass strings and must
  be rewritten to booleans **in the same commit**. 2 titles. Staging stays `warn`.
- `worker/jobs/OnboardingDemoWorker.ts` — mock leak guard. Needs a NEW test: the
  existing suite mocks `isMockMode()` false and never reaches the guard
  (`OnboardingDemoWorker.test.ts:99`), so migrating it is currently untested.
  1 title.
- `worker/background/pollers/AccountOffboardingPurgePoller.ts` — **not in this
  ticket and not in the edit surface.** See above; it is out of scope entirely.

### T4 — CI regression rule  *(blocking edges: T2 AND T3)*

Cannot land before T2+T3 — the rule is red until every **non-exempt** `worker/`
site is migrated. The purge poller is never migrated; it is the exemption.

- `scripts/ci/static-policy-audit.ts` — ban the **statically identifiable raw
  read** of `NODE_ENV` in executable position under `worker/`, not merely
  comparisons against `'production'`. Banning the read is simpler than enumerating
  comparison shapes and it closes cross-file indirection at source: the audit scans
  each file independently (`scanFile(file, text)` at `:702`, `:936`) with no symbol
  resolution, so `export const runtimeMode = process.env.NODE_ENV` in one worker
  file and `if (runtimeMode === 'production')` in another would otherwise evade any
  comparison-shaped rule. If the read cannot exist, the export cannot either.

  **Scope of the guarantee, stated honestly.** "Statically identifiable" means
  property access, bracket access with a string literal, template-literal access,
  and destructuring (including renamed). It does **not** cover dynamic-key access
  (`const k = 'NODE_ENV'; process.env[k]`) or whole-object aliasing
  (`const env = process.env; env.NODE_ENV`) — neither is decidable without symbol
  resolution the audit does not have. That residual gap is documented in the rule
  comment and the ADR rather than papered over. Rejecting *all* dynamic
  `process.env[…]` access is not an option: `startup-assert.ts:45,49,238`
  legitimately iterate required-variable lists that way, and the rule must not fire
  on them.

  Use the file's **existing AST mechanism** (`ts.createSourceFile` /
  `ts.forEachChild`, already used at `:480`, `:526`, `:536`, `:609`, `:654`,
  `:666`, `:696`). AST is what makes the no-false-positive requirement satisfiable:
  comments are trivia, and while string literals *are* AST nodes — the scanner
  already visits `StringLiteralLike` at `:568` — a bare string is not a
  `process.env` member-access subtree, so the `NODE_ENV` text at
  `startup-assert.ts:57` (error message) and `:181` (comment) is excluded.

  **One exemption**, by exact path:
  `worker/background/pollers/AccountOffboardingPurgePoller.ts`, with a comment
  naming #614 as the trigger to remove it. `src/**` stays out of scope.
- `scripts/ci/__tests__/static-policy-audit.test.ts` (7 titles, including the
  no-false-positive case and the exemption)

`src/**` is deliberately out of the rule's scope: cookies, logger, impersonation
and destructive-auth branch on `NODE_ENV` for genuine dev-vs-prod runtime
behaviour and would each need a judgement-call allowlist entry. Record that gap in
the rule's comment and the ADR so it is a decision, not an oversight.

### T5 — docs, ADR, glossary  *(blocking edge: T1; parallel with T2/T3)*

- NEW `docs/adr/0013-deployment-lane-resolution.md` — precedence vs union; the
  per-site old ⇒ new safety property **and the purge poller as the worked example
  of a site that fails it**; why `isProductionLane()` was designed and then not
  built; the `next dev` local effect; the accepted `src/**` gap in the CI rule; and
  the #614-tracked exemption.
- `CONTEXT.md` — glossary entry for **deployment lane**, aligned with CLAUDE.md's
  existing "Three lanes" vocabulary.
- `.claude/reference/env-vars.md` — `RAILWAY_ENVIRONMENT_NAME` as the lane source.
- `docs/runbooks/beta-launch-alerting.md` — the gate keys off the lane, not
  `NODE_ENV`; add the post-deploy Sentry cron-monitor cleanup step.
- `docs/runbooks/deployment-guide.md` — correct the prod-worker required-var list.
- `.env.example:332` — the override's `NODE_ENV`/`VERCEL_ENV` mechanism is
  UNCHANGED, so the existing description stays accurate; add a reference to #614
  so the known gap is discoverable from the variable's own documentation.

## Ship (RISK=high lane)

1. Land on `staging`; worker auto-deploys.
2. Verify on staging: `[boot]` log shows `deployment_lane=staging`,
   `lane_source=RAILWAY_ENVIRONMENT_NAME`; Sentry events tagged `staging`;
   Fastify still at `warn` and stacks still suppressed (the additive-union
   proofs); `health-alert-poller` grows a `staging` environment. The purge
   poller is untouched, so its behaviour needs no staging verification.
3. Delete the stale `production` environment on the cron monitor in Sentry.
   Expect one transient missed-check-in in the gap.
4. PR to `main`, CI green, pause for merge approval.

No migration, no flag, no Railway variable write, no destructive-path change.
Rollback = revert; the monitor self-heals.
