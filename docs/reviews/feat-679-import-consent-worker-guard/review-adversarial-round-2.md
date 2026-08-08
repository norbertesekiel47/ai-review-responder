# Adversarial approach review — round 2 (verification-only), #679

**Axis**: adversarial approach. **Round**: 2 of max 3 (`branchReviewRounds: 2`).
**Scope**: verification of round-1 findings A1–A3 against fix commits
`fa84bc1c`, `bfac89d4`, `6b312edb`, `a2f2ac09`, plus an adversarial challenge of
the savepoint remedy itself (`bfac89d4`), which no reviewer had seen.

**Reviewer**: Codex `gpt-5.6-sol`, read-only sandbox, direct `codex exec`.
**Codex session id**: `019fdef1-ae8a-7ca2-9503-cfcd21406cbc`
**Brief**: `docs/reviews/feat-679-import-consent-worker-guard/branch-review-brief-round-2.md`

> **Dispatch note.** The `codex:codex-rescue` plugin path failed twice this
> round: the companion wrapper launched job `task-msjolvby-y182uu` and then
> recorded **no job at all** (`codex-companion.mjs status` → "No jobs recorded
> yet"), and the rescue subagent is scoped forward-only so it cannot poll,
> retrieve, or write up a result. The workflow's documented fallback — direct
> `codex exec` from the orchestrator session — is what produced this report.
> This is the third recorded instance of the wrapper losing a task id; see the
> process-lessons section of the handoff doc.

## Verification table

| finding | status | evidence |
|---|---|---|
| **A1 — High** — analytics is an availability dependency of consent and connection finalization | **LANDED** | Both emissions now use a transaction-derived savepoint and swallow only after rollback: `src/lib/reviews/import-consent.ts:287-294,386-393,465-477` |
| **A2 — Medium** — a policy refusal is persisted as indistinguishable success | **NOT LANDED — deferred by design** | Filed as #695. Refusals log a reason but still call generic `markOutboxCompleted`: `worker/jobs/zernio/job-eligibility.ts:193-201` |
| **A3 — Medium** — "manual SQL means no enqueue-time chokepoint" is a false constraint | **NOT LANDED — deferred by design** | Filed as #695. Enforcement remains post-dispatch in the worker transaction: `worker/jobs/zernio/job-eligibility.ts:185-200` |

A2 and A3 read as NOT LANDED because they were **filed, not fixed** — both
challenge decisions locked at #670 and were routed to #695 during round-1
triage. Codex confirmed the in-branch state matches that disposition. No action.

## Savepoint challenge — the four questions

**1. Does a failed emission leave the enclosing transaction usable?** **PASS.**
A Postgres-side failure is rolled back to the nested savepoint before the helper
catches it. The recorded `23503` connect-shaped demonstration confirms the offer
write and a subsequent caller write both commit.
`src/lib/reviews/import-consent.ts:469-477`;
`docs/superpowers/plans/feat-679-import-consent-worker-guard-deviations.md:519-535`.

**2. Does a successful emission still die with the caller's transaction?**
**PASS.** The savepoint uses the caller's `tx`, not an independent client. The
Postgres-side abort test verifies the event, the decision, and the outbox row all
roll back together — the savepoint did not convert a dependent write into an
independent one.
`src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts:435-462`.

**3. Can the savepoint's own failure handling poison the transaction?** **PASS.**
postgres.js issues `ROLLBACK TO` before rethrowing and issues no `RELEASE`,
which eliminates the already-aborted-savepoint release hazard entirely.
`node_modules/postgres/src/index.js:258-281`.

**4. Is the `warn` fallback a real signal or a silent swallow?** **CONCERN.**
See the finding below.

## New defects introduced by a fix commit

| severity | file:line | finding |
|---|---|---|
| **Medium** | `src/lib/reviews/import-consent.ts:472` | The savepoint fallback logs a structured `console.warn` but reaches no durable or paged alert sink, so persistent analytics-schema drift can undercount one-shot events indefinitely without alerting. `src/lib/shared/logger.ts:89-98`; the documented paging path depends on `captureMessage` (`docs/runbooks/beta-launch-alerting.md:45-50`). |

## Appendix — new, untriaged

none

## VERDICT: REVISE

Single blocking item: the Medium above. A1 is genuinely closed and the savepoint
survives three of four adversarial challenges cleanly.

## Orchestrator triage — 2026-08-08 (branch review round 2)

| Item | Verdict | Disposition |
|---|---|---|
| A1 LANDED | — | No action. Independently corroborated by the spec and standards axes; the savepoint is correct on questions 1–3. |
| A2 / A3 NOT LANDED | **Correct disposition** | Both were filed to **#695** at round-1 triage. Codex confirmed in-branch state matches. No action. |
| Medium — swallowed failure reaches no durable/paged sink (`import-consent.ts:472`) | **ACCEPTED, filed not fixed** | Filed as **#697**. Owner decision 2026-08-08: the alerting seam is outside the locked edit surface and the intake's `observability` contract names no Sentry signal. Migration-before-code ordering remains the enforced primary control and stands independently of this. |

**Note on the Q4 CONCERN.** It is real and the ticket records it in full. What the
savepoint traded away is loudness: a connect outage (unmissable) became a lost
metric plus a `warn` (quiet). That trade is sound only while the deploy-ordering
rule holds, which is why #697 exists rather than the concern being dismissed.

Round-2 verdict for this axis: **REVISE → resolved by filing.**
