# Adversarial approach review — round 3 (verification-only), #679

**Axis**: adversarial approach. **Round**: 3 of max 3 — the LAST round.
**Scope**: one commit, `4c4e9df9` (the round-2 fix commit). Branch base `main@2f369582`.

**Reviewer**: Codex `gpt-5.6-sol`, read-only sandbox, direct `codex exec`.
**Codex session id**: `019fdfbb-e197-7f32-a4c0-5538f8c5c6bb`
**Brief**: `docs/reviews/feat-679-import-consent-worker-guard/branch-review-brief-round-3.md`

> **Dispatch note.** Direct `codex exec` again, skipping the `codex:codex-rescue`
> plugin path that failed twice in round 2 (see D35). One new wrinkle worth
> recording: this repo's own Stop hook fires INSIDE the codex session, so
> `codex exec -o <file>` captured codex's reply to the hook rather than its
> report. The report was recovered from the run log. **Read the run log, not the
> `-o` file, when reviewing this repo with codex.**

## The question this round existed to answer

Commit `4c4e9df9` changed production error-handling semantics: `emitConsentEvent`
previously swallowed EVERY error; it now swallows only errors carrying a string
`code`. The risk was that a transient or connection-level failure would escape
and abort the caller's transaction, reintroducing the GBP-connect outage the
savepoint exists to prevent.

**Answer: it cannot.** Verified against the driver source, not assumed.

## Transient-error analysis

| error kind | string `code`? | swallowed or rethrown | correct? | evidence |
|---|---:|---|---|---|
| `PostgresError`: `23514`, `23503`, other SQLSTATEs | Yes | Swallowed after `ROLLBACK TO` | Yes; preserves the caller transaction | `node_modules/postgres/src/errors.js:1-6,30-33`; `node_modules/postgres/src/connection.js:31-35,812-817`; `src/lib/reviews/import-consent.ts:482-489` |
| Server `statement_timeout` / query cancellation (`57014`) | Yes | Swallowed after `ROLLBACK TO` | Yes; this is an isolatable statement failure | `src/lib/db/server.ts:33-48`; `node_modules/postgres/src/index.js:350-360`; `node_modules/postgres/src/errors.js:36-39` |
| `CONNECTION_CLOSED` | Yes | Swallowed locally if it reaches the catch; outer transaction rejects | Yes; a lost connection cannot be preserved by a savepoint | `node_modules/postgres/src/errors.js:16-27`; `node_modules/postgres/src/connection.js:453-457`; `node_modules/postgres/src/index.js:243-246` |
| `CONNECTION_ENDED` | Yes | Swallowed if surfaced | Yes; normally occurs after root `sql.end()`, outside an active savepoint callback | `node_modules/postgres/src/index.js:329-332`; `node_modules/postgres/src/errors.js:16-27` |
| `CONNECTION_DESTROYED` | Yes | Swallowed locally; shutdown destroys the transaction | Yes; infrastructure failure remains caller-visible | `node_modules/postgres/src/index.js:384-388`; `node_modules/postgres/src/connection.js:422-425` |
| Connect timeout — actual code is `CONNECT_TIMEOUT` | Yes | Swallowed if surfaced | Yes; connection startup precedes `emitConsentEvent`, so this cannot quietly commit the caller transaction | `node_modules/postgres/src/connection.js:261-264`; `node_modules/postgres/src/errors.js:16-27` |
| Node `ECONNREFUSED` | Yes | Swallowed if surfaced | Yes; it occurs before the transaction callback can invoke the emitter | `node_modules/postgres/src/connection.js:129-140,335-355,381-410` |
| Node `EPIPE` / `ETIMEDOUT` | Yes | Swallowed locally; socket close rejects the enclosing transaction | Yes; not converted into quiet success | `node_modules/postgres/src/connection.js:139-140,381-410,436-457`; `node_modules/postgres/src/index.js:243-246` |
| `AbortError` / `TimeoutError` as `DOMException` | No; numeric `20`/`23` | Would be rethrown | Yes; postgres.js does not use DOM aborts for query timeout—its cancellation path is `57014` | `node_modules/@types/node/web-globals/domexception.d.ts:4-7,27-30`; `node_modules/postgres/src/query.js:52-54`; `node_modules/postgres/src/index.js:350-360` |
| `TypeError` from missing `savepoint`/`json` | No | Rethrown | Yes; malformed transaction handle is a wiring defect | `src/lib/reviews/import-consent.ts:482-484`; `src/lib/analytics/enqueue.ts:29-50` |
| Invalid event name / other ordinary JS error | No | Rethrown | Yes | `src/lib/analytics/enqueue.ts:24-28`; `src/lib/reviews/import-consent.ts:484` |

## Verdict on the narrowing

Every reachable database timeout, SQLSTATE, postgres.js lifecycle error, and Node socket error has a string code. DOM exceptions do not, but postgres.js 3.4.9 does not produce them for query timeout. Connection loss still rejects the enclosing `begin` independently, so it cannot be hidden as a successful connect. Reusing either shared transient predicate is unwarranted: this guard also handles constraint failures, has one use, and CLAUDE.md explicitly keeps those predicates distinct. CORRECT

## Verification table

| item | status | evidence |
|---|---|---|
| Error-catch narrowing | LANDED | `src/lib/reviews/import-consent.ts:482-489`; driver taxonomy above |
| Two savepoint regression tests genuinely pin | LANDED | Injection follows both the outer and freshly minted savepoint handles at `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts:328-357`; post-failure statements assert transaction usability at `:592-662`; deleting the savepoint leaves poison in the parent transaction |
| Two postgres.js mock completions | LANDED | `src/app/api/zernio/connect/_shared/finalize/__tests__/import-offer-junction.test.ts:87-97`; `worker/ingress/stripe/__tests__/import-offer-resume.test.ts:72-79`; real callback contract at `node_modules/postgres/src/index.js:251-254,283-289` |
| Four shipped-behaviour doc rewrites and citations | LANDED | `supabase/migrations/102_import_consent_analytics_events.sql:20-37`; `.claude/reference/migrations-log.md:1005-1015`; `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md:399-416`; `docs/analytics/events.md:277-294`; corrected citation resolves at `worker/jobs/zernio/ZernioBackfillWorker.ts:416` |

## New defects introduced by 4c4e9df9

none

## Appendix — new, untriaged

none

## VERDICT: APPROVED

## Orchestrator triage — 2026-08-08 (branch review round 3)

| Item | Verdict | Disposition |
|---|---|---|
| Narrowing is CORRECT in both directions | **ACCEPTED** | No action. The High risk (too narrow → outage returns) is closed on driver-source evidence; the too-wide direction is INHERITED from the pre-commit unbounded swallow, strictly shrunk by this commit, and tracked as **#697**. |
| All four verification rows LANDED | — | No action. |
| No new defects, empty appendix | — | No action. |
| Recommendation NOT to reuse `isCrashNetRecoverableDbError` / `isTransientPostgresError` | **ACCEPTED** | Independently reached the same conclusion as the standards axis brief anticipated: this guard also handles constraint failures, has one call site, and CLAUDE.md explicitly keeps those predicates distinct. "No abstraction before the second use" holds. |

Round-3 verdict for this axis: **APPROVED.**
