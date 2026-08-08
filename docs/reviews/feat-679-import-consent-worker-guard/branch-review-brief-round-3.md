# Branch review round 3 — verification-only brief (#679)

**Round 3 of a max 3 — this is the LAST round.** After it the orchestrator
stops looping and surfaces any remaining disagreement to the owner. Counter is
in `.feature/state.json` (`branchReviewRounds: 3`).

**The entire delta you are reviewing is ONE commit: `4c4e9df9`.** Base for the
branch is `main@2f369582`; round-2's review commit was `3b7e0404`.
`git show 4c4e9df9` is your scope. Nothing outside it is in play.

## Verification-only rule

- Verify each round-2 fix landed and introduced nothing new.
- You MAY flag a defect `4c4e9df9` introduced. That is the point of this round.
- You may NOT open new fronts against code `4c4e9df9` did not touch. Genuinely
  new observations go in an **Appendix — new, untriaged** section.
- Findings table = ≥80% confidence only, with `file:line` and a concrete failure
  scenario or a named standard.

## PRIORITY — the catch narrowing is a production semantic change

`src/lib/reviews/import-consent.ts:484`:

```ts
if (typeof (error as { code?: unknown }).code !== 'string') throw error;
```

Before `4c4e9df9`, `emitConsentEvent` swallowed **every** error. Now it swallows
only errors carrying a string `code` and rethrows the rest. **No reviewer has
seen this.** It is the same "unreviewed change to the highest-risk path"
condition that made the savepoint round 2's priority.

**The question that matters most, and the one to attack hardest:**

> Can a **transient or connection-level** failure now escape `emitConsentEvent`
> and abort the caller's transaction — reintroducing the exact GBP-connect
> outage the savepoint was introduced to fix?

Concretely, enumerate what `enqueueAnalyticsEvent` can actually throw when
called through `tx.savepoint(...)`, and for each decide whether it carries a
**string** `code`:

- `PostgresError` (constraint violations, `23514`, `23503`, …) — presumably yes.
- postgres.js **connection** errors (`CONNECTION_CLOSED`, `CONNECTION_ENDED`,
  `CONNECTION_DESTROYED`, timeouts) — do these carry a string `code`? Verify
  against `node_modules/postgres/src/errors.js`, do not assume.
- Node system errors surfacing through the driver (`ECONNREFUSED`, `EPIPE`,
  `ETIMEDOUT`) — these carry a string `code`, so they would be **swallowed**.
  Is that the intended outcome, or does it hide a real infrastructure failure?
- An `AbortError`/`DOMException` from a query timeout — string `code`?
- A `TypeError` from a malformed handle — no `code`, rethrown. **Intended.**

A wrong answer in either direction is a real finding:
- **Too narrow** (something transient now escapes) → the connect outage is back,
  and the savepoint's whole purpose is defeated. **High.**
- **Too wide** (an infra failure is swallowed as if it were schema drift) → a
  quiet failure mode with no durable sink (see #697). **Medium.**

Note the repo has related precedent that is deliberately kept distinct:
`isCrashNetRecoverableDbError` (strict allowlist) vs billing's broad
`isTransientPostgresError`. Judge whether a bare `typeof code === 'string'` check
belongs alongside those or should reuse one — **but** weigh it against the
anti-slop rule "no abstraction before the second use" and CLAUDE.md's own
guidance that these predicates stay distinct. A recommendation to unify needs to
beat both.

## Also verify

1. **The two new savepoint tests genuinely pin.** They must go RED if the
   savepoint is deleted (body reverted to `await enqueueAnalyticsEvent(tx, input);`).
   Round 2 claims this was mutation-verified — re-confirm it rather than trusting
   the claim. Titles:
   - `createImportOffer keeps the caller transaction usable when the emission fails`
   - `recordImportDecisionAndEnqueue commits the decision and still enqueues when the emission fails`
   The injection is a real `23514` from `analytics_events_event_name_check`, via
   a `Proxy` that wraps the savepoint handle. Check that the `Proxy` does not
   accidentally make the test pass for the wrong reason.
2. **The two mock completions are correct, not merely green.**
   `import-offer-junction.test.ts` and `import-offer-resume.test.ts` each gained
   `savepoint`. In the second, `begin` hands the same object back as the
   transaction — confirm that is faithful to postgres.js rather than papering
   over a different bug.
3. **The four doc rewrites are accurate to shipped behaviour**, not to intent:
   `supabase/migrations/102_….sql` header, `.claude/reference/migrations-log.md`,
   `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` §6,
   `docs/analytics/events.md` (both event blocks). Every `file.ts:NNN` citation
   in the diff must resolve — round 1 and round 2 each found stale ones.

## Out of scope — do not reopen

- **#694** (`ci:live-db-suites` R2 detector), **#695** (enqueue-boundary
  enforcement + durable policy-block reason), **#696** (verify-gate 40-char slug
  collision), **#697** (no durable/paged sink for the swallowed emission). All
  filed by owner decision.
- The **post-savepoint doc rewrite being "not done"** — it is done, in this
  commit. Verify it, don't file it.
- The **`reclassify` WARN** — re-checked three times (prod 507, test 2305), same
  lane every time. Not a finding.
- The **surface amendments (2 of 2) and the abort-criteria override** — an
  explicit owner decision, recorded in deviations **D36**. Not a finding.

## Facts already established — do not re-derive

- A JS throw does not poison a Postgres transaction. Abort injection must be
  Postgres-side.
- postgres.js issues `ROLLBACK TO` and never `RELEASE`, so the
  already-aborted-savepoint hazard does not exist (verified round 2 at
  `node_modules/postgres/src/index.js:258-281`).
- The race fix is load-bearing: `guardImportConsent` must keep `sql.begin` +
  `SELECT … FOR UPDATE` + `markOutboxCompleted(tx, …)`.
- The three real `createImportOffer` producers are `finalize-tx.ts:208`,
  `worker/ingress/stripe/shared.ts:159`, and the GET self-heal in
  `src/app/api/dashboard/import-offer/route.ts`. `add-location-tx.ts` is NOT one.

## Live-DB access

Suites SILENTLY SKIP without the env var, and a skipped suite is not evidence:

`export TEST_DATABASE_POOL_URL=$(grep '^TEST_DATABASE_POOL_URL=' .env.local | cut -d= -f2-)`

**NEVER run `pnpm test:db:setup`** — it drops schema `public`. Migration 102 is
already applied to the local `repworth-testdb` container. Only the agent told it
holds the live-DB lock may run `*.integration.test.ts` suites.

## Output contract

Full report to
`docs/reviews/feat-679-import-consent-worker-guard/review-<axis>-round-3.md`.
Return ONLY:

1. Verification table: `item | LANDED / NOT LANDED / REGRESSED | evidence (file:line)`
2. Findings table for anything `4c4e9df9` broke: `severity | file:line | one-line finding`
3. `VERDICT: APPROVED` or `VERDICT: REVISE`

No prose beyond that.
