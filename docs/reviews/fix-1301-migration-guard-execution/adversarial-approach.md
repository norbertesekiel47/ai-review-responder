# Adversarial approach review

Reviewed head: `a4becdc44e56030d10384fe7faec17493623b9ab`.
Pinned merge-base: `07738319cd5d7a78661ed1e3af07430bd84a8521`.
Date: 2026-09-20.

**Recommendation: revise the isolation boundary before merging. Keep PostgreSQL 17 and the independent expectations.** Executing SQL is the right replacement for recognizing SQL text. The problem is granting the SQL being tested control of the transaction that supposedly makes execution harmless to other suites.

I read the brief first and accepted its measured facts, including the green gate, 201 passing tests, successful rollback measurements, current migration transaction compatibility, and PostgreSQL privilege counts. I used the plan's section 8 as the disposition of the closed review findings. This report does not reopen those findings. Source inspection below checks a different question: whether the built architecture remains safe when the subject of a regression test changes.

## Findings at or above 80% confidence

| severity | area | one-line finding | what you would do instead |
|---|---|---|---|
| P1 | Q2 — isolation | The migration under test can commit its own destructive test setup; the rollback wrapper is not a containment boundary for verbatim SQL. | Run migration execution in a disposable database owned exclusively by the run, with a dedicated disposable PostgreSQL instance where privileged or cluster-wide effects are possible; keep unrelated integration suites elsewhere. |
| P2 — follow-up design | Q4 — D8 reuse | The deferred work includes data backfills and trigger functions that the table-catalogue oracle cannot verify, so its cost is not fourteen mechanical uses of the existing pattern. | Keep the deferral, but classify the follow-up into schema, data-transform, and trigger/policy behavior cases; budget independent fixtures and behavioral assertions, or deliberately extend the catalogue model. |

P1 is the reason for REVISE. P2 is a concrete constraint on the deferred design, not a request to absorb fourteen suites into this branch.

## Q1 — Is the two-oracle design the right answer?

**It is defensible for the seven selected guards, but it should not be treated as the only alternative to a SQL lexer.** Oracle A is an independent expected result, which tests need. Capturing PostgreSQL's output from a known-good database and then freezing it is a valid regression technique. Subsequent provisioning from a weakened candidate does not rewrite that expectation. Oracle B then proves that the selected operation actually repairs the selected degradation. Removing Oracle A without replacing that independence would restore the circularity already resolved in plan review.

The maintenance objection is nevertheless real. These tests freeze a selected representation of head, rather than an isolated historical migration's contract. They inherit the database's deparser, bootstrap roles, search path, and later migrations. A major-version rendering change can require many expectation changes without a product change. A legitimate future schema change can require updating an old suite whose migration has not changed. Copying newly generated strings without reviewing the semantic difference would approve a regression just as readily as a legitimate change. Generation reduces transcription work; it does not remove the need to decide whether the result is correct.

This is a different failure mode from the retired lexer. The lexer could accept SQL it misunderstood. Exact renderings tend to reject harmless representation changes. That trade is acceptable when expectations are few, stable, independently reviewed, and pinned to a supported engine. I would retain them for the present seven cases while addressing P1.

**A stronger third design exists: differential execution from a frozen pre-migration baseline.** For migration N:

1. Build an isolated template from an explicitly pinned, approved bootstrap and migrations through N−1. Candidate changes must not rewrite this input.
2. Clone that baseline into reference and candidate databases on the same PostgreSQL image and settings.
3. Apply the approved version of N to the reference and the checked-in version to the candidate, using the same deterministic row fixtures.
4. Compare their resulting schema representations and relevant rows. Retain a small set of explicit behavioral requirements, especially allowed/denied role operations and data-preservation assertions.
5. Dispose of both databases. Test head composition separately by applying the full current chain.

The reference migration must be pinned too. A scratch **BEFORE alone is not an expected AFTER** and cannot establish that a removed predicate or revoke is wrong. This design still has an independent source of truth: approved migration history and explicit requirements. It avoids maintaining a second hand-edited catalogue snapshot because PostgreSQL renders both sides during the same run. A version change that changes both renderings equally need not change dozens of literals.

For historical first-application behavior and future expansion, this is materially better than continually reconstructing older states inside today's head schema. It also naturally exercises inline `CREATE TABLE` declarations. It costs bootstrap/template ownership, deterministic data fixtures, database lifecycle management, and additional execution. It can reproduce a defect shared by the approved reference and candidate, so semantic requirements still matter. I have not measured its runtime and do not claim it is cheaper in wall-clock time. The minimum merge correction is isolation; replacing every Oracle A literal is not necessary to correct P1.

## Q2 — What rollback does and does not protect

### P1: the test subject owns its supposed containment boundary

Evidence in the built tree:

- `src/lib/shared/__tests__/helpers/migration-guard.ts:594` opens `db.begin`, invokes an unrestricted transaction callback, and throws a sentinel. It does not prevent the callback's SQL from ending that transaction.
- The installed postgres.js implementation, `node_modules/postgres/src/index.js:251`, responds to callback failure by issuing `ROLLBACK`; it does not provide nested-transaction containment around an explicit SQL `COMMIT`.
- `src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts:225` changes default privileges and drops the table. The first execution case, at line 462, applies the migration verbatim at line 477 and checks the recreated table against its previous catalogue representation.
- `readPublicCatalogue`, at `migration-guard.ts:238`, models selected properties of public ordinary/partitioned tables. It is not a snapshot of `pg_default_acl`, table contents, sessions, or the cluster.

A realistic counterexample is a future edit that wraps 118's otherwise unchanged contents in `BEGIN; … COMMIT;`, following the transaction-bearing style already present in migration 119. This is a proposed mechanism example, **not a mutation executed during this review**:

1. The suite's outer transaction grants permissive default ACLs and drops `poller_heartbeats`.
2. The migration's `BEGIN` does not create an independent nested transaction.
3. The migration recreates the expected table and revokes the table's inherited client grants.
4. Its `COMMIT` commits the entire transaction, including the test's default-ACL degradation and table replacement.
5. The table can match the captured catalogue. The later sentinel causes a `ROLLBACK` with no open transaction; that cannot restore committed state.

PostgreSQL documents that `BEGIN` inside a transaction only warns, that `COMMIT` makes the current transaction permanent, and that a standalone `ROLLBACK` only warns and has no effect. These semantics, together with the inspected driver and suite, support the counterexample without executing it against the shared container. [BEGIN](https://www.postgresql.org/docs/17/sql-begin.html), [COMMIT](https://www.postgresql.org/docs/17/sql-commit.html), [ROLLBACK](https://www.postgresql.org/docs/17/sql-rollback.html).

The dedicated default-ACL case at lines 517–583 does check its own before/after state outside the transaction. That is useful detection, but it cannot prevent a commit. Earlier execution cases can already have contaminated the state that this later case captures as its BEFORE. Even a later test failure would leave the shared database changed. This is an isolation finding, not a claim that the current unchanged migrations leak or that every test in a mutated full run would pass.

The measured absence of transaction commands in the seven files establishes compatibility **at the reviewed SHA**. It does not establish containment when a regression test executes a changed file. The accepted F8 fix correctly preserves callback errors; an error-preserving wrapper cannot undo a transaction the callback has already committed. A regex ban on transaction keywords would reintroduce the parser problem. A post-execution transaction-ID check would detect some escapes only after damage. An exclusive disposable execution environment removes the shared-state consequence.

### The rest of the protection boundary

| Scenario | Assessment of the built approach |
|---|---|
| Current transactional DDL and ordinary callback/assertion failure | Sound within the outer transaction. The sentinel and error path roll back the selected changes; the supplied measurements support this. No current DDL residue defect is alleged. |
| Statements prohibited inside a transaction | `CREATE INDEX CONCURRENTLY` and `CREATE DATABASE` fail in a transaction block; they do not silently bypass it. This is a future compatibility limit, distinct from explicit transaction termination. [CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html), [CREATE DATABASE](https://www.postgresql.org/docs/17/sql-createdatabase.html). |
| Sequence state | `nextval` consumption and `setval` changes are not undone by rollback. This is outside the table catalogue comparison. The current seven files do not establish an observed sequence leak; this prevents generalizing their result to arbitrary migrations. [Sequence functions](https://www.postgresql.org/docs/17/functions-sequence.html). |
| Prepared statements | They are session objects. The suites use `prepare: false` and close their own clients, which limits driver-managed and cross-suite residue. Explicit SQL preparation would still require session-lifecycle reasoning, rather than a catalogue equality claim. [PREPARE](https://www.postgresql.org/docs/17/sql-prepare.html). |
| Session GUCs | Ordinary `SET` performed inside an aborted transaction is rolled back; `SET LOCAL` ends with the transaction. It would be incorrect to list ordinary in-transaction `SET` as an unavoidable leak. Changes outside the wrapper or committed by an escaped transaction are different. [SET](https://www.postgresql.org/docs/17/sql-set.html). |
| Session advisory locks | Rollback does not release them. The suite's intended mutex is deliberately session-scoped on a separate client and explicitly released. Additional session locks acquired by migration SQL are outside the sentinel's cleanup guarantee. Transaction advisory locks do release with their transaction. [Explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html). |
| Replication slots | Persistent slots have a lifecycle independent of the connection and survive crashes. Their operations have their own prerequisites/restrictions; none is present in these seven migrations. A general-purpose privileged migration sandbox must use an isolated cluster, not assume that dropping a scratch database covers all effects. [Logical decoding concepts](https://www.postgresql.org/docs/17/logicaldecoding-explanation.html). |
| Process/server crash before rollback | If the transaction has not committed, the transactional changes are not a persistent degraded schema. A client disappearance ends the transaction once the server detects disconnection; a server crash recovers transactional state. Delayed disconnection can prolong blocking. A crash after an escaped COMMIT is a different case and cannot undo that commit. [Transactions](https://www.postgresql.org/docs/17/tutorial-transactions.html). |

The word “byte-identical” is too broad. The evidence supports restoration of the asserted logical state after successful cleanup, not a physical database image or all server state. Also, 117 retains committed fixture setup and explicit cleanup at lines 290–310, outside the rollback wrapper. A killed suite can leave those existing fixtures behind; this is retained behavior, not a new regression attributed to this branch.

### Concurrent readers and the cross-process lock

`helpers/live-db-lock.ts` expressly says ordinary tenant-scoped readers/writers need not acquire the mutex. `vitest.config.ts` serializes integration files within one process; it cannot serialize another worktree's Vitest process or an application connection. Thus the advisory lock is sufficient to coordinate cooperating DDL suites, but not to exclude all users of the database.

Other sessions do not normally observe uncommitted RLS disablement or a half-rebuilt table as committed schema. The practical exposure is blocking, timeout, or deadlock: the destructive DDL needs relation locks that conflict with unrelated access. PostgreSQL automatically supplies those locks; the advisory mutex does not replace them. Its separate lock connection also is not a lease enforced on the DDL connection if the lock session disappears. [Explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html).

I do not claim the reported 201-test run suffered any race. That run proves a successful schedule, not universal exclusion. A dedicated execution database removes these relation-lock conflicts with unrelated suites. If shared operation is retained, every competing session must join a correctly scoped shared/exclusive protocol, and the guarantee must be stated that narrowly. Even universal participation would not fix P1's committed residue after the lock is released.

## Q3 — Is PostgreSQL 17 safe and sufficient?

**Keep one required lane on 17.** Given the brief's established fact that both deployed projects use 17, a mandatory 16 lane would test an additional compatibility promise the product has not stated. It would not improve coverage of 17's MAINTAIN privilege. A temporary 16 lane is reasonable only if supporting existing developer environments is an explicit transition requirement, or a named version-dependent concern warrants it. I found no such executable dependency that justifies requiring two majors here.

The built changes cover both service images, the local E2E creation recipe, and cross-file major assertions in `src/__tests__/ci-audit-wiring.test.ts:212`. The composite test-DB action takes connection inputs and provisions the selected service; it does not silently create a third PG16 service. Database storage is ephemeral tmpfs. The checked cache keys cover pnpm packages and Playwright browser binaries, not PostgreSQL data directories, so a database-major cache-key change is not needed for those caches.

There is still local divergence, deliberately accepted in D2: the other worktrees' PG16 container remains. `scripts/new-worktree.sh:73` copies local environment files without migrating their database target, and schema readiness checks are not a server-major check. Consequently D7's broad sentence that local and CI now use the same major is true for this prepared worktree, not a repository-wide enforcement property. Keep D2; provide a clear version diagnostic for developers switching to the new test contract instead of treating every mismatch as a behind-head schema.

A targeted search also found current-tense stale prose in `.claude/reference/lab-notes/migrations.md` (the container is PG16) and `docs/sass_ready/03-multitenancy-isolation.md` (CI runs Postgres 16). Other hits describe genuine historical measurements or version-independent behavior. These warrant documentation cleanup, not restoration of PG16 CI. I am not turning comment cleanup into an approach blocker.

Matching the major is necessary and sufficient for the specific RT-4 coverage gap described in the brief. It does not prove parity with all Supabase extensions, roles, configuration, or hosted deployment behavior. That broader parity limitation existed before this branch. No new PG16-specific runtime break was established by this review; I accept the supplied PG17 gate rather than claiming to have independently rerun the full repository on both majors.

## Q4 — What becomes harder to change?

Head expectations and historical migration replay now move together. A future migration changing an index definition, FK, guarded default, or pinned column inventory must revisit the owning expectations. Merely touching a guarded table does not necessarily require literal edits: only an asserted property or inventory does. However, equality-based replay can require a deeper redesign when a later migration replaces an object that the old migration recreates. Updating an expected string alone cannot make an old migration recreate a new definition.

There is already a concrete future seam in 118. Its full-table-drop strategy is justified by the absence of later modifications. Add a later column or index to `poller_heartbeats`, and replaying 118 alone after dropping it cannot reproduce head. That future feature would need a narrower degradation, replay of an explicit suffix, or a historical scratch baseline. This is an acknowledged present precondition whose maintenance consequence should be explicit, not an allegation that the current table-drop case is wrong.

D11 records 4,558 changed test lines for this work, with large per-suite fixtures and expectations. The reusable reader eliminates repeated catalogue joins, but not the need to choose a valid adverse starting state, seed relational dependencies, prove the precondition, and write an independent result oracle. I would not estimate D8 by multiplying the shortest RLS case.

**P2's concrete evidence:**

- Migration 047 is a data backfill from `updated_at` into `past_due_at`, conditional on status and NULL. Catalogue equality cannot distinguish the intended update from no update or an incorrectly broad update. It needs eligible/ineligible row fixtures and value assertions.
- Migration 054 combines column/default/constraint changes with a tier-dependent price backfill. It needs data cases as well as catalogue cases.
- Migration 056 defines two trigger functions and two triggers (`056_account_offboarding.sql:169–225`); its existing text suite explicitly checks those declarations. `CataloguedTable` has no function or trigger dimension, and `assertOnlyTablesMoved` cannot detect a changed function body. Calling the existing reader cannot replace those guards.
- The deferred policy cases are not uniformly deny-all. Migration 045 creates an authenticated owner-select policy, and 040 narrows owner-update permissions. Their behavioral oracle must distinguish the permitted owner path from forbidden access, not require zero policies.

The existing callback-based transaction wrapper can host these behavioral assertions without widening its signature. The existing catalogue model cannot express all their outcomes. The follow-up must either add deliberate function/trigger representations, with identity and relevant execution attributes, or retain catalogue checks for structural parts and add focused behavioral probes for the remainder. This is bounded extension, not a reason to preemptively build a universal PostgreSQL model in this PR.

I accept D8's scope deferral. I would record its acceptance criteria by migration category and prioritize security-sensitive owner-policy/trigger behavior, preserving the existing integration siblings for 055/056. The exact effort is unmeasured. The frozen-baseline differential design in Q1 offers a cleaner long-term route when head-dependent setup starts dominating the work.

## Low-confidence appendix — excluded from the findings table

- **Runtime superiority of scratch templates:** plausible at larger suite counts, but neither template-clone time nor competing catalogue-snapshot cost was benchmarked. No speedup or effort reduction is claimed.
- **A reproducible cross-process failure on this exact head:** the missing universal mutex participation and lock conflict mechanism are established; failure frequency and a failing schedule were not measured. No existing green result is disputed.
- **Specific deparser breakage on a future PostgreSQL release or minor update:** the dependency exists, but no concrete changed rendering was demonstrated. Do not reject PostgreSQL 17 on speculative rendering drift.
- **A PG16-only production dependency:** none was found in the targeted configuration/source search. This is not an exhaustive compatibility certification.

## Review boundaries and requested next step

Only this report was written. No migration was applied, no shared-database mutation probe was performed, and `pnpm test:db:setup`, the gate, build, and test runners were not invoked. The existing green gate and cleanup measurements are supplied evidence, not new executions by this reviewer. `pnpm agent:rules .feature/review-staging/adversarial-approach.md` returned `none`. This review has no browser-observable change to exercise.

Before merging, make migration execution disposable independently of rollback, then demonstrate in that disposable environment that an explicit transaction-terminating migration and a mid-apply failure cannot alter the database used by unrelated suites. Retain the ordinary rollback tests: rollback remains useful cleanup inside an isolated execution environment. Do not replace independent expectations with candidate-derived BEFORE/AFTER alone, and do not require the fourteen deferred conversions as part of this correction.

VERDICT: REVISE
