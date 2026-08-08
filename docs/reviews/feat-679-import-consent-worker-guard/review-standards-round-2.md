# #679 — standards & maintainability review (round 2, verification-only)

Branch `feat-679-import-consent-worker-guard`. Fix commits verified:
`fa84bc1c`, `bfac89d4`, `6b312edb`, `a2f2ac09` (whole fix range `07f57148..HEAD`,
9 files / +1176 / −348).

**Constraint honoured:** no `*.integration.test.ts` suite was run and
`pnpm test:db:setup` was not invoked (a sibling agent holds the live-DB lock).
Verification is static, plus non-integration vitest runs, `pnpm lint`,
`pnpm typecheck`, and all 16 `ci:*` audit scripts. Anything only a live run can
settle is marked as such.

Gates run clean on the worktree:

- `pnpm lint` — clean. `pnpm typecheck` — clean.
- All 16 `ci:*` audits PASS, including `ci:live-db-suites`, `ci:analytics-events`,
  `ci:outbox-seam`, `ci:tenant-scope`, `ci:db-imports`.
- Non-integration suites touched by the fix commits: `job-eligibility.test.ts`,
  `runbook-import-consent.test.ts`, `import-consent-lock-order-source.test.ts` —
  15/15 green.

---

## 1. Verification of my round-1 findings

| # | Round-1 finding | Status | Evidence |
|---|---|---|---|
| S1 | **High** — run-time DDL in `import-consent.integration.test.ts:969-979` | **LANDED** | `rg 'ALTER TABLE\|ADD CONSTRAINT\|DROP CONSTRAINT\|CREATE INDEX' src/lib/reviews/__tests__/` is empty; the abort is now a Postgres-side `23503` from `abortingExecutor` (`src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts:224-257`), asserted as `rejects.toMatchObject({ code: '23503' })` at `:456`. |
| S2 | **High** — `ci:live-db-suites` R2 detector keys on an incidental marker (`scripts/ci/live-db-suites-audit.ts:117`) | **NOT LANDED — deferred by triage** | Filed as **#694**; `scripts/**` is outside `allowed_edit_surface`. Line 117 is unchanged. Per the round-2 brief this is closed for this round and not reopened here. |
| S3 | **Medium** — file crossed 1000 lines by appending a distinct slice | **LANDED** | `import-consent.integration.test.ts` 1039 → **807** lines; the slice is `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts` (516). All 38 intake `tests_to_add` titles still resolve — verified mechanically: 0 missing of 38. |
| S4 | **Medium** — `assertSchemaReady` misses the migration-102 precondition | **LANDED (correctly re-scoped)** | `assertAnalyticsEventNamesRegistered` at `src/lib/shared/__tests__/helpers/schema-ready.ts:439`, requirement at `:428`; applied at `import-offer-analytics.integration.test.ts:290` and `src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:110`. |
| S5 | **Low** — assertion that cannot fail (`job-eligibility.test.ts:307`) | **LANDED** | `expect(completionCalls[0]!.exec).toBe(mockSql)` deleted along with the `exec` field itself (`fa84bc1c`); only `inTransaction` survives (`job-eligibility.test.ts:344`). |
| S6 | **Low** — NULL-deadline title not constructed | **LANDED** | Pinned at the seam that can actually decide it: `expiredArmOf()` (`job-eligibility.test.ts:142`) bounds the `WHEN … THEN 'expired'` arm and `:233` asserts the `IS NOT NULL` conjunct sits *inside* that arm, then that the guard's query contains the fragment. |
| S7 | **Low** — `scenarioBlock('A5')` unbounded | **LANDED** | `scenariosArray()` (`runbook-import-consent.test.ts:31`) bounds the slice to the `SCENARIOS` literal. Verified the outer bound is unambiguous: `src/app/admin/runbook/page.tsx` has exactly one line matching `^];` (line 109, the array terminator). |

**Net: 6 LANDED, 1 deferred-by-triage. Nothing REGRESSED among my own findings.**

### Quality notes on the landings

`S4`'s landing includes a **correction to my round-1 reasoning**, and the
correction is right. I argued the precondition sat on ~10 pre-existing #677
titles that would fail with an opaque `23514`. After `bfac89d4` that is false —
the savepoint swallows the rejection, so on a DB at 101 those titles now *pass*
and the metric under-counts. D29 re-scoped the assertion onto the two suites that
**assert an event row exists** and deliberately left `import-consent.integration.test.ts`
without it, saying so in the comment where the slice used to be
(`import-consent.integration.test.ts:800-806`). That is the more honest placement.

`S3`'s extraction is not a bare file split: the new file's header states why it
exists and why it carries the name it does. `a2f2ac09`'s rename claim is verified —
computing `tr -c 'a-zA-Z0-9' '-' | cut -c1-40` over every sibling
`*.integration.test.ts` in `src/lib/reviews/__tests__/` yields four distinct slugs
(`…import-consent`, `…import-offer-a`, `…import-offer-v`, `…import-review-`), and
`scripts/verify-gate.sh:193` does derive both the row name and the coverage
directory from exactly that expression.

`S4`'s helper went into the **existing** `schema-ready.ts`, beside
`assertSchemaReady`, with the same `db: postgres.Sql` signature, the same
`SETUP_COMMAND` failure text and the same read-only posture. No new file was
minted for it. That is the right call and it needs no further defence.

---

## 2. The savepoint (`bfac89d4`) — the brief's four questions

Judged on the postgres.js v3.4.9 source in this worktree
(`node_modules/postgres/src/index.js:234-296`), not on the docs.

**Q1 — does a failed emission leave the enclosing transaction usable? YES, and
for two independent reasons, both of which matter.**

`scope(c, fn, name)` issues `savepoint sN` before `fn`; on any rejection it
`await`s `rollback to sN` and rethrows (`index.js:257-272`). `ROLLBACK TO
SAVEPOINT` is one of the few statements Postgres accepts on an aborted
transaction, so the parent leaves the aborted state. The second reason is the
non-obvious one: postgres.js keeps a per-scope `uncaughtError` closure
(`index.js:253, 290-291`) and checks it at the end of `fn`
(`if (uncaughtError) throw uncaughtError`, `:265`). The failing INSERT is issued
through the **savepoint's** `sql`, so it sets the **savepoint's**
`uncaughtError`, never the parent's. A caught savepoint failure therefore cannot
resurface at the parent's commit. I could not find a path by which it leaks.
`emitConsentEvent` (`src/lib/reviews/import-consent.ts:465-478`) catches that
rethrow, so the caller continues. **Settled statically; D26 also records a live
three-direction demonstration.**

**Q2 — does a successful emission still die with the caller's transaction? YES,
structurally.** postgres.js issues **no `RELEASE SAVEPOINT` at all** — the
success path of `scope` just returns, and only the *unnamed* (top-level) scope
runs `commit` (`index.js:274-279`). A committed savepoint's rows are ordinary
rows of the parent transaction and roll back with it. This is also pinned
behaviourally, at `import-offer-analytics.integration.test.ts:435-463`: the
`23503` is injected *after* the emission, and the title asserts both zero
analytics rows and `import_decision === 'pending'`.

**Q3 — can the savepoint's own failure handling poison the transaction? NO.**
The "RELEASE on an already-aborted savepoint" hazard the brief names cannot
arise, because postgres.js never issues `RELEASE`. Ordering is
`SAVEPOINT` → work → (on error) `ROLLBACK TO SAVEPOINT` → rethrow, with nothing
after it. Savepoint names are unique per transaction (`savepoints` counter lives
in `begin`, `index.js:237`), and this code opens exactly one savepoint per
transaction, so the never-released savepoints do not accumulate.

**Q4 — is the fallback a `warn` or a swallow-and-continue? It is a `warn`, and
the log shape is right — but the `catch` around it is wider than the failure it
was written for, and that has already cost signal.** See finding R1 below.
The `warn` itself follows in-repo precedent
(`src/lib/solicitation/ask-generation.ts:776`, "api_costs write failed after
render persistence — swallowing"), logs only `business_id` / `event_name` /
`error.message`, and correctly picks `warn` over `logRejection`'s `log`.

One thing the header claims that I could not verify and that is worth an
operational note rather than a finding: *"the warn line is how a project that got
the order wrong announces itself."* `createImportOffer`'s hottest producer runs
in a **Next.js route** (`finalize-tx.ts:208`), so that line lands in Vercel
function logs, not Railway — nothing in `HealthAlertPoller` or the Sentry sink
watches it. The residual risk is therefore a metric that under-reports with no
alarm attached. That is a consequence of the accepted remedy, not a defect in it.

**Verdict on the savepoint itself: correct.** It does what the commit message
claims, on all four questions, and the module header is now accurate about both
the hazard and the producer list.

---

## 3. Findings — defects a fix commit introduced

| Severity | file:line | Finding |
|---|---|---|
| **Medium** | `src/lib/reviews/import-consent.ts:471` | `emitConsentEvent`'s `catch` is unbounded: it swallows a JS wiring error identically to a Postgres constraint failure. `import-offer-junction.test.ts`'s hand-rolled `mockTx` has no `savepoint` (`:39-87`), so since `bfac89d4` six pre-existing GREEN titles run `TypeError: tx.savepoint is not a function` through that catch and emit nothing — reproduced, six warn lines in that suite's stderr. |
| **Medium** | `src/lib/reviews/import-consent.ts:465-478` | The savepoint — the highest-risk production change on the branch — ships with **zero** test coverage of its own new behaviour. No suite in the tree exercises a failing emission or asserts the parent transaction survives one. `bfac89d4` says "a follow-up agent owns the test for this behaviour"; neither `6b312edb` nor `a2f2ac09` added it. |

### R1 — the unbounded catch, and the false coverage it created

Reproduced, not inferred:

```
$ REPWORTH_DISABLE_LIVE_DB_SUITES=1 npx vitest run --reporter=verbose \
    src/app/api/zernio/connect/_shared/finalize/__tests__/import-offer-junction.test.ts

stderr | … > finalize-tx creates the import offer and enqueues no import when import consent is pending
{"level":"warn","logger":"import-consent","message":"Import consent analytics emission failed",
 "data":{"business_id":"biz-1","event_name":"import_offer_created",
         "error":"tx.savepoint is not a function"}}
…
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

Six titles, six warn lines, all green. Before `bfac89d4` this suite exercised the
emission for real: `enqueueAnalyticsEvent(tx, …)` reached
`mockTx` as a tagged template (default arm returns `Promise.resolve([])`) and
`mockTx.json` exists at `:87`. After it, the emission is dead in every mocked run
of the connect junction and the suite cannot tell.

**Why this is worth a round trip rather than a shrug.** The catch does not
distinguish "the database rejected my INSERT" — the failure it was written for —
from "I was handed the wrong kind of handle", which is a wiring bug. Concretely:
`enqueueAnalyticsEvent` throws a plain `Error` for an unregistered name *before*
touching the database (`src/lib/analytics/enqueue.ts:24-26`), and
`sanitizeAnalyticsProperties` can throw on a bad property shape. Every one of
those is now a `warn` and a lost metric that only the two live-DB suites can
catch. That is the exact defect class this branch's round-1 report named as its
dominant one — *tests that do not test what they claim* — reintroduced by a fix
commit, which is what round 2 exists to find.

It is also the reason D27's note ("the *swallowing* form of that mutation …
structurally undetectable, because `sql.savepoint` does not exist and the `catch`
eats the `TypeError`") is a symptom rather than a curiosity: the mutation is only
undetectable because the catch is too wide.

**Two fixes, both small; the second is the principled one and I would take both.**

1. Give the mock the shape the real handle has — two lines in
   `import-offer-junction.test.ts` beside `mockTx.json` at `:87`:
   ```ts
   mockTx.savepoint = vi.fn((cb: (sp: typeof mockTx) => Promise<unknown>) => cb(mockTx));
   ```
   That alone restores the emission path in the mocked suite and removes the six
   stderr lines.

2. Narrow the catch so a wiring bug is not laundered into a lost metric.
   `PostgresError` is a value export of the `postgres` default
   (`node_modules/postgres/types/index.d.ts:704`):
   ```ts
   } catch (error) {
     // A metric must never poison the caller. A WIRING bug is not a metric.
     if (!(error instanceof postgres.PostgresError)) throw error;
     createWorkerLogger(LOG_PREFIX).warn(…);
   }
   ```
   Note this makes fix 1 mandatory rather than optional — with the narrowing
   alone, `import-offer-junction.test.ts` goes RED, which is the correct signal
   and is precisely the point.

### R2 — the savepoint has no test

`rg savepoint` over the tree finds the production code, three explanatory
comments, and the two pre-existing WS8 migration-shape suites. Nothing exercises:

- a failing emission leaving the parent transaction usable (the whole reason the
  change exists), or
- the `warn` being emitted (the entire residual-risk story the header now tells).

Both properties are cheap to pin in `import-offer-analytics.integration.test.ts`,
which already owns `abortingExecutor` and already has a live client: point an
emission's `business_id` at a non-existent uuid inside `createImportOffer`'s
transaction, assert the transaction still commits a later write, assert zero
analytics rows, assert one `warn` line. That is the same injection D26 already
built and threw away. **This is a live-DB test and I could not write or run it
this round; flagged for the orchestrator to route.**

The narrower point is a repo one: `bfac89d4` shipped production behaviour with a
deliberate "tests untouched, a follow-up owns it", and no follow-up commit
claimed it. On a branch whose test bucket ran 5:1 against production code, the
one change with an availability blast radius is the one with no test.

---

## 4. Anti-slop sweep on the fix range

Checked and **clear** — recorded so round 3 does not re-derive:

- **New file.** `import-offer-analytics.integration.test.ts` is the only new
  file. It is an extraction I asked for, its header names why it exists and why
  it is named that way, and every title moved verbatim (38/38 intake titles
  resolve). `schema-ready.ts` grew a function rather than spawning a sibling
  helper file — the existing file was the right home and was used.
  `docs/directory.md` does not enumerate per-feature integration suites, so no
  registration is owed.
- **Abstraction before second use.** `emitConsentEvent` has two callers.
  `AnalyticsEventNameRequirement` has one constant today, but it mirrors the
  file's existing `SchemaRequirement` shape rather than inventing one. Neither
  trips the rule.
- **Precedent over invention.** The `Proxy`-over-a-real-`Sql` injection keeps the
  test typed against the shipped `Sql` (D22's failure class avoided);
  `Reflect.get(target, prop)` without the receiver is the safer of the two forms.
  The `logger.warn(msg, {…})` + swallow shape matches
  `ask-generation.ts:776`.
- **Net-negative bias.** `fa84bc1c` deleted a dead assertion and its field rather
  than annotating them. `6b312edb` removed the `.unsafe(ALTER TABLE …)` pair
  outright. Both are the right direction.
- **No `any`, no `@ts-expect-error`, no `eslint-disable`** added anywhere in the
  fix range (the `: any` in `import-offer-junction.test.ts` is pre-existing mock
  idiom). `pnpm typecheck` and `pnpm lint` clean.
- **`import-consent.integration.test.ts:212`** still deletes `analytics_events`
  in `afterAll`. That is not dead cleanup left behind by the split — the writers
  still emit on the paths that suite exercises.

---

## 5. Could not settle without a live DB

Stated rather than guessed, for the orchestrator:

- `connection: { lock_timeout: 5_000 }` on the new suite's client
  (`import-offer-analytics.integration.test.ts:279`). `lock_timeout` is a USERSET
  GUC and should be accepted in the startup packet by a plain `postgres:16`
  container, but a **pooler** in front of `TEST_DATABASE_POOL_URL` can reject an
  unsupported startup parameter outright. If it does, the failure is a hard
  connection error in `beforeAll`, not a subtle one.
- The claim that the 8 moved titles pass green in their new file. Their text is
  verbatim and their fixtures came with them, but only a run proves it.
- The `23503` determinism claim at `:237-241` (that the injected row violates
  *only* the FK, given migration 102 is asserted in `beforeAll`). Reads correct;
  only a run settles it.

---

## Appendix — new, untriaged

Not triaged this round, per the brief.

- **An untracked file appeared in the worktree mid-review**, at
  `src/lib/reviews/__tests__/zzz-round2-savepoint-probe.integration.test.ts`
  (created 18:19 while I was working). **It is not mine** — presumably the
  sibling axis probing the savepoint against live Postgres. Flagging only so
  `git status --porcelain` is not misread: my own output is this file alone.
- `expiredArmOf()` (`job-eligibility.test.ts:142`) takes `indexOf('WHEN')`, so a
  second `WHEN` arm added *before* the expired arm would silently reslice the
  wrong region. There is exactly one arm today and the JSDoc says what it means.
  Below reporting threshold; noted so it is not rediscovered.

---

## Verdict

The savepoint is right — it answers all four of the brief's questions correctly,
and the two non-obvious ones (no `RELEASE` to mis-order; per-scope `uncaughtError`
so the parent is never poisoned) hold on inspection of the postgres.js source
rather than on its documentation. Six of my seven round-1 findings landed, several
of them landed *better* than proposed, and one landed with a correction to my own
reasoning that I accept.

But a fix commit introduced a new instance of this branch's signature defect —
an over-wide catch that turned six green titles into false coverage — and the
change with the largest blast radius on the branch still has no test. Both fixes
are mechanical.

**VERDICT: REVISE**

## Orchestrator triage — 2026-08-08 (branch review round 2)

| Finding | Verdict | Disposition |
|---|---|---|
| S1 / S3 / S4 / S5 / S6 / S7 LANDED | — | No action. |
| S2 NOT LANDED (`ci:live-db-suites` R2 detector) | **Correct disposition** | Filed as **#694** at round-1 triage; `scripts/**` is out of surface. No action. |
| Medium — `emitConsentEvent`'s catch is unbounded (`import-consent.ts:471`) | **ACCEPTED — FIXED** | Catch now rethrows non-Postgres errors; `mockTx.savepoint` added to the junction suite. Cost one surface amendment (owner-approved, **1 of 2**). |
| Medium — savepoint ships with zero coverage of its own behaviour (`import-consent.ts:465-478`) | **ACCEPTED — FIXED** | Converged with the spec axis's Medium. Coverage added to `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts`, mutation-verified. |

### Correction to the unbounded-catch evidence

The finding is **real and now fixed**, but the orchestrator re-ran the repro and
the reported detail was off — recorded because this branch's triage standard is
to verify, not accept:

- The count is **5 of 6**, not 6 of 6.
- `import-offer-junction.test.ts` **never asserts analytics at all** (neither
  `analytics` nor `savepoint` appears in it; its six titles are all `finalize-tx`
  enqueue behaviour). So it is not false coverage *of that suite's own claims* —
  the suite proves what it says it proves.

What it **is**, and why the finding stands: a live demonstration that the
unbounded catch silently absorbed a genuine wiring error. Verified by probe —
replacing the catch body with a rethrow surfaced
`TypeError: tx.savepoint is not a function` on 5 of 6 titles, while the shipped
code swallowed it and the suite stayed green. Post-fix mutation (omit
`mockTx.savepoint`, keep the narrowing) → **5 failed**, confirming the narrowing
is load-bearing rather than decorative. Probe reverted; production diff clean.

Round-2 verdict for this axis: **REVISE → resolved.**
