# Review — DATABASE/TENANCY + SECURITY/AUTHORIZATION

Branch: `fix-1171-job-outbox-rls`
Merge base: `602e98930810177230c0edbc0830063db5f75d43` · HEAD: `3a7d0ca9930ae60c5ebbafb25cd962675d751e78`
Reviewer posture: read-only. No `apply_migration`, no writes, no mutating shell. All database facts
below come from `execute_sql` SELECTs against the two live projects on 2026-09-07.

---

## Findings

| # | Severity | file:line — or introspected fact | Finding |
|---|---|---|---|
| F1 | medium | `docs/superpowers/plans/fix-1171-job-outbox-rls-intake.json` → `rollback_plan` | The rollback restores 4 of the 8 revoked privileges and, applied as written, drops production **below** its pre-119 baseline by disabling RLS that was already on. |
| F2 | medium | `supabase/migrations/119_job_outbox_rls.sql:69-72` (+ intake `edge_cases[0]`) | "The ALTER is a no-op on production" is false where it matters — the statement still takes `ACCESS EXCLUSIVE` on the busiest table, contradicting the file's own LOCKING section, and on prod it buys nothing. |
| F3 | medium | `supabase/migrations/119_job_outbox_rls.sql:39-40` (echoed in migrations-log 119 and arch-review-log) | "production has run **this exact posture** for five months" is refuted by introspection: prod still holds the `anon`/`authenticated` grants, so the post-119 posture has run nowhere. The branch's own `edge_cases[1]` says so. |
| F4 | medium | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:194-252` (comment at :238-242, header at :36-40) | The catalogue privilege case is vacuous in **every** environment it can execute in — including its four "load-bearing" owner arms — and its comments assert the opposite; one of them also cites a `service_role` assertion D2 deleted. |
| F5 | low | `docs/security/rls-inventory.md:46` vs. the 119 diff | The human-facing RLS register gains no row for the platform's dispatch spine, while `admin_audit_log` — the precedent this branch cites four times — is listed there in exactly this shape. Declared a non-goal; flagged so the owner re-confirms knowingly. |

---

## 0. What the introspection actually says

Both projects, schema `public`, 2026-09-07, `current_user = postgres` (not superuser, `rolbypassrls = true`).

```
prod    udeyaqnvpojbwgoaxwdg  job_outbox  owner=postgres  relrowsecurity=true   relforcerowsecurity=false  policies=0
                              relacl = {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
                                        authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}

staging kubdiqdhqbhwmqfditeg  job_outbox  owner=postgres  relrowsecurity=FALSE  relforcerowsecurity=false  policies=0
                              relacl = (byte-identical to prod)
```

`arwdDxtm` = INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN. Note that
`anon` holds **eight** privileges, not four. Column-level ACLs on `job_outbox`: **0** on both
projects, so a table-level `REVOKE ALL` is sufficient (a column grant would have survived it).

---

## 1. Trust boundary — each of the three claims, verified independently

**(a) `relforcerowsecurity` stays false.** True, and asserted twice (catalogue + file text). But
note the claim it supports is stronger than it needs to be: `postgres` carries
`rolbypassrls = true` on **both** projects (`pg_roles`), and PostgreSQL's BYPASSRLS attribute
bypasses row security *unconditionally*, including under FORCE. So on these two projects even
`FORCE ROW LEVEL SECURITY` would not have locked the worker out. The migration's
"setting it would deny the outbox to its only writer and stop every async job in the platform"
(`119:36-38`) is therefore false as stated for staging and production — it is true only for a
database where the owner lacks BYPASSRLS, which is the local test container. The assertion is
correct-by-conservatism and I am **not** raising it as a finding; recording it so a future reader
does not build on the stated mechanism.

**(b) every access goes through Postgres.js as the table owner.** Verified from three directions:

- `rg "from\('job_outbox'"` over `src` + `worker`: zero non-test matches. Confirmed.
- `.rpc(` over `src` + `worker`: **zero matches anywhere in the repo**. There is no PostgREST RPC
  surface at all, so no function can reach the table on a client role's behalf.
- Catalogue sweep on both projects for anything that could reach `job_outbox` on a non-owner role:
  - views / matviews depending on `job_outbox` (`pg_depend` → `pg_rewrite`): **none**
  - functions whose body mentions `job_outbox` (`pg_proc.prosrc ILIKE`): **none** — so no
    SECURITY DEFINER wrapper exists
  - non-internal triggers on `job_outbox`: **none** (so no trigger body runs as another role)
  - publication membership (`pg_publication_tables`): **none** — the table is not in
    `supabase_realtime`, so Realtime cannot subscribe to it
  - Edge Functions: `list_edge_functions` returns `[]` on **both** projects
  - `graphql_public.graphql`: `prosecdef = false` (SECURITY **INVOKER**), so a pg_graphql query
    executes as `anon`/`authenticated` and is subject to the same grants and RLS. No bypass.
  - event triggers: the six Supabase defaults only. `ensure_rls` is **gone from both projects** —
    migration 107's removal is confirmed, so nothing will silently re-enable RLS on a future table.

**(c) `service_role` carries BYPASSRLS.** True on both projects (`pg_roles.rolbypassrls = true`),
and the REVOKE does not name it, so the service key retains full PostgREST access to `job_outbox`
after 119. That is unchanged and intentional (`SUPABASE_SERVICE_KEY` is server-only, invariant #8),
but it is worth being explicit that 119 does **not** remove `job_outbox` from the PostgREST surface
— it removes it from the surface the two *public* keys reach.

**DATABASE_URL vs DATABASE_POOL_URL.** `.env.example:9-10` shows both resolving to the same role:
`postgres@db.<ref>.supabase.co:5432` (direct) and `postgres.<ref>@…pooler.supabase.com:6543`
(Supavisor transaction mode) — Supavisor's `postgres.<ref>` username maps to the `postgres` role.
`src/lib/db/server.ts` builds `sql`, `sqlRead` and `sqlUnsubscribe` from `DATABASE_POOL_URL` only;
`DATABASE_URL` is `opt` in both `src/lib/config/worker.ts:74` and `src/lib/config/server.ts:95` and
is used by `scripts/wedge-repro.ts` and the E2E helpers. Empirically confirmed on both projects:

```
pg_stat_activity (datname=postgres):
  postgres      / Supavisor              ← the worker + Vercel pools
  postgres      / mgmt-api
  authenticator / postgrest
  pgbouncer     / Supavisor (auth_query)
  supabase_admin/ pg_cron, pg_net, postgres_exporter
```

Every application connection authenticates as `postgres`, which both **owns** `job_outbox` and
holds **BYPASSRLS**. Supavisor session-vs-transaction pooling is irrelevant here: pooling mode does
not change the authenticated role, and RLS/privilege checks are per-statement.

**Conclusion on the trust boundary: the change is inert for the worker.** I could not construct any
path that newly meets RLS or newly loses a privilege other than the two client roles. The
*conclusion* is sound; two of the three *arguments* offered for it are not (see F3 and (a) above).

---

## 2. Is the empirical argument sound? (prod flags OFF vs. staging `TRIAGE_ENABLED` on)

**No code path is dark in prod, live in staging, that would newly meet RLS.** RLS is only ever
evaluated for a role that is neither the table owner nor BYPASSRLS. Every path in this codebase —
triage included — reaches `job_outbox` through the injected `sql`/`tx` Postgres.js client on the
`postgres` role. `TRIAGE_ENABLED` changes *which rows* get enqueued, never *which role* enqueues
them. I checked the enqueue seam specifically (invariant #2's helper-owned topics plus the
sanctioned raw `INSERT INTO job_outbox` sites): all of them are template-literal SQL on an injected
client, none is a supabase-js call.

So the flag asymmetry is a red herring for the RLS half. It is **not** a red herring for the REVOKE
half — but for the opposite reason to the one the branch gives: the REVOKE's blast radius is nil in
both environments because `anon`/`authenticated` are used by *no* path on this table in *either*
environment, not because prod has been running the posture. See F3.

---

## 3. REVOKE consequences

**Would a future object re-grant?** `pg_default_acl` on **both** projects carries, for schema
`public`, two `ALTER DEFAULT PRIVILEGES` entries (grantor `postgres` **and** grantor
`supabase_admin`) granting `arwdDxtm` on TABLES to `anon`, `authenticated`, `service_role`. These
apply at `CREATE TABLE` time only, so they cannot re-grant on the existing `job_outbox` — the
migration is durable. They **do** mean every future table in `public` is born with `anon` INSERT,
which is why the deny-all-RLS convention is load-bearing and why 117/118/119's per-migration REVOKE
is the right pattern. Nothing in the diff is wrong here; recorded because the intake's non-goal
("do not REVOKE on any other deny-all table — separate reviewed change") leaves a standing class,
not a closed one.

**Grantor semantics.** A `REVOKE` only removes grants made by the executing role (or roles it is a
member of). `relacl` shows every `anon`/`authenticated` grant on `job_outbox` was made **by
`postgres`** (`anon=arwdDxtm/postgres`), and `apply_migration` executes as `postgres`
(`current_user` = `postgres`, verified). So the REVOKE will bite rather than emit
`WARNING: no privileges could be revoked`. This was the single most likely silent-no-op failure
mode and it is **clear**.

**Column-level grants.** `pg_attribute.attacl IS NOT NULL` count for `job_outbox`: **0** on both
projects. A table-level `REVOKE ALL` does not remove column grants, so a non-zero count would have
left `anon` with residual column SELECT and a still-readable PostgREST projection. Clear.

**PostgREST schema cache.** `pgrst_ddl_watch` (`ddl_command_end`) and `pgrst_drop_watch` exist on
both projects. `GRANT`/`REVOKE` and `ALTER TABLE` both emit `ddl_command_end`, so PostgREST reloads
without operator action. No stale-cache window.

**Error code the client sees.** This does change, and only prod's change is unstated. Today on
prod (RLS on, grants present) an anon `GET /rest/v1/job_outbox` returns `200 []` and an anon INSERT
returns a `42501` row-security violation. After 119 both become `permission denied for table
job_outbox` (`42501` → HTTP 403) — a *table*-level denial. The intake's `user_visible_behavior`
describes this for staging; it is also a prod-observable change. Strictly an improvement (no
existence-vs-emptiness signal), so not a finding.

**Anything PostgREST exposes that reads `job_outbox` transitively.** None — no views, no functions,
no RPC, no Realtime publication, no Edge Functions (all enumerated in §1). Verified rather than
assumed.

---

## F1 — the rollback plan is wrong in two independent ways (medium)

**Evidence.** `rollback_plan` in the intake:

> write migration 120 with `ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY` and
> `GRANT SELECT, INSERT, UPDATE, DELETE ON job_outbox TO anon, authenticated`, and apply it staging
> first.

Introspected pre-119 ACL on **both** projects: `anon=arwdDxtm/postgres`. That is eight privileges —
INSERT, SELECT, UPDATE, DELETE, **TRUNCATE, REFERENCES, TRIGGER, MAINTAIN**. The proposed GRANT
restores four.

Introspected pre-119 `relrowsecurity`: **prod `true`**, staging `false`. The proposed
`DISABLE ROW LEVEL SECURITY` is correct for staging and correct for the local container, and
**wrong for production**, where it would move the table to a posture prod has not been in since it
was provisioned on 2026-04-05.

**Concrete failure scenario.** Dispatch appears to stall after the change window (in practice for
an unrelated reason — the crash-net, a Redis blip, a Railway restart). The operator follows the
recorded rollback, writes 120 verbatim and applies it to both projects. Dispatch does not recover,
because RLS was never the cause. Prod is now the only environment in the fleet with RLS **off** on
its dispatch spine, and both projects carry a `job_outbox` ACL that matches neither the pre-119
state nor each other's documented baseline. The next lockstep audit — the very check that produced
this ticket — reports fresh drift on the table this ticket exists to converge.

**Concrete fix.** Make the rollback environment-aware and use the introspected ACL:
`GRANT ALL ON job_outbox TO anon, authenticated;` and issue
`ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY` **only** where `relrowsecurity` was false before
119 (staging + local), never on prod. Also worth recording that the rollback answers only
"dispatch stopped"; it answers nothing for the far more likely operational failure, F2's
lock timeout, where there is nothing to roll back and the correct response is to retry in a quieter
window.

---

## F2 — "a no-op on production" is not a no-op at the lock level (medium)

**Evidence.** `supabase/migrations/119_job_outbox_rls.sql:69-72`:

> The ALTER is a no-op on production (already enabled) and does not error

and intake `edge_cases[0]`: *"Production already has relrowsecurity=true, so ALTER TABLE …
ENABLE ROW LEVEL SECURITY is a no-op there."*

PostgreSQL does not short-circuit this. `ATExecSetRowSecurity` writes the `pg_class` tuple
unconditionally — there is no `if (already == requested) return`. And `AlterTableGetLockLevel`
maps `AT_EnableRowSecurity` to `AccessExclusiveLock`. So on production the statement still:
takes `ACCESS EXCLUSIVE` on `job_outbox`, writes a new `pg_class` row, bumps the relcache and
invalidates cached plans referencing the relation — for zero change in outcome, since
`relrowsecurity` is already `true`.

This directly contradicts the same file's own LOCKING section at `119:63-67`, which correctly
says the ALTER takes `ACCESS EXCLUSIVE` and is why `lock_timeout` is there. A reader who takes
"no-op on production" at face value has no reason to schedule a window.

**Why it bites here specifically.** `worker/background/pollers/OutboxPoller.ts:33` polls every
**5 s** by default and `:201` claims rows with `FOR UPDATE SKIP LOCKED` inside a transaction, on top
of every request-path enqueue (78 non-test files in `src` + `worker` bind this table — verified,
the migration's own figure is right). A pending `ACCESS EXCLUSIVE` request does not merely wait: it
**blocks every new lock request queued behind it**. So `SET lock_timeout = '5s'` bounds *acquisition*
but not *collateral blocking* — for up to five seconds every outbox write on production stalls, and
each of those writes sits inside the same transaction as its state change (invariant #2), behind an
admission cap of 10 on the worker and 3 per Vercel isolate (`src/lib/db/server.ts`). A five-second
stall on a five-second poll cadence is a coin flip on acquisition and a guaranteed cost on the
attempt, and it can push routes past the admission deadline into sanitized 503s.

**Concrete fix.** Guard the statement so it is genuinely inert where it has nothing to do:

```sql
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_outbox'::regclass) THEN
    EXECUTE 'ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;
```

That makes prod's apply a pure `REVOKE` + `COMMENT` — and `REVOKE` on a table takes **no** relation
lock (`objectNamesToOids` opens the target with `NoLock`; only the `pg_class` row is locked), so the
prod apply becomes lock-free. Staging still gets the substantive ALTER, under the same `lock_timeout`,
where the blast radius is a staging worker. At minimum, if the statement stays unguarded, the
migration header and the intake edge case must stop calling it a no-op and the change window must
say "expect up to 5 s of blocked outbox writes on production, and expect `55P03` retries".

---

## F3 — the "five months" evidence does not cover the statement it is used to justify (medium)

**Evidence.** `supabase/migrations/119_job_outbox_rls.sql:39-40`:

> The strongest evidence is empirical: production has run **this exact posture** for five months.

Introspected prod ACL on 2026-09-07:
`{postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}`.

Production has run **RLS-on with the client grants intact**. The posture 119 produces — RLS-on with
`anon`/`authenticated` revoked — has run in **no** environment, for zero months. The branch knows
this; intake `edge_cases[1]` says *"Production still carries anon/authenticated grants, so the
REVOKE is a real production change, not a no-op."* The two statements cannot both be true.

**Where it propagates** (the checklist's "rationale duplicated four ways" class, and the reason all
four go stale at once):

- `supabase/migrations/119_job_outbox_rls.sql:39-40` — "this exact posture … five months"
- `.claude/reference/migrations-log.md`, entry 119 — "that five months is the strongest safety
  evidence the change has"
- `.claude/reference/arch-review-log.md`, 2026-09-07 row — "the posture prod has run without
  incident for five months"
- `supabase/migrations/119_job_outbox_rls.sql:29-30` — "the stricter posture that production has
  already run without incident since 2026-04-05"

(The intake's `rollback_plan` phrasing — "production has already run with RLS enabled since
2026-04-05" — is the one accurate copy, because it scopes the claim to RLS.)

**Concrete failure scenario.** The reviewer or the operator accepts "prod has run this for five
months" and skips a prod-specific pre-check on the only statement that is new on prod. The REVOKE
happens to be safe — I verified that independently in §1 and §3, from the absence of any
supabase-js, RPC, view, function, trigger, publication, Edge Function or column-ACL path — but the
branch's argument does not establish it, and the next migration that reuses this sentence as
precedent (117 and 118 are already cited as precedent four times each here) inherits a claim that
was never true.

**Concrete fix.** One-line correction in all four copies: prod has run *RLS-enabled* since
2026-04-05; the REVOKE is new everywhere, and its safety rests on the enumerated absence of any
client-role path to the table, not on elapsed time. Keeping the argument in one place and citing it
by name from the other three would also stop the next drift.

---

## F4 — the catalogue privilege case proves nothing anywhere it can run (medium)

**Evidence chain.**

1. `src/lib/shared/__tests__/helpers/live-db-lock.ts:87-93` — `assertLocalTestDatabaseUrl` throws
   unless the hostname is `localhost` or `127.0.0.1`. The suite calls it in `beforeAll`
   (`migration-119-job-outbox-rls.integration.test.ts:138`). **The suite can never execute against
   staging or production.**
2. The database it *does* execute against, in both lanes, is
   `postgres://test:test@localhost:5433/test` locally (`docs/runbooks/e2e-local-setup.md:10,17`,
   created with `POSTGRES_USER=test`) and `postgres://test:test@localhost:5432/test` in CI
   (`.github/workflows/ci.yml:263`). `POSTGRES_USER` in the `postgres` docker image is the initdb
   **bootstrap superuser**. `scripts/ci/test-db-bootstrap.sql:54-55` says so in as many words:
   *"The suite connects as a superuser/service identity."*
3. `scripts/test-db-setup.sh` applies the chain as that same role, so `test` **owns** every table
   and `pg_get_userbyid(relowner)` resolves to `test`.
4. `has_table_privilege` returns `true` unconditionally for a superuser, regardless of `relacl`.

Therefore all four owner arms at `:227-230` are **constant true** in every environment the suite can
reach. The `anon`/`authenticated` arms are already documented vacuous there (D5,
`test-db-bootstrap.sql` grants the client roles schema USAGE and nothing on any table). Net: the
entire `expect(privileges).toEqual({...})` at `:243-252` is vacuous — it would pass byte-identically
if migration 119 read `REVOKE ALL ON job_outbox FROM anon, authenticated, postgres, service_role`,
which is precisely the mutation the comment at `:238-242` claims it catches:

> The four owner arms are the load-bearing half — NOT vacuous on any container, and exactly what a
> widened REVOKE would break.

**A second, independent defect in the same case.** The suite header at `:36-40` reads:

> The catalogue case (title 4) still runs, because on staging and production the grants ARE present
> before apply and absent after, and because the assertion that `postgres` **and `service_role`**
> keep their privileges is NOT vacuous anywhere.

Two things wrong: the suite asserts nothing about `service_role` — D2 removed those arms — so this
is a leftover from the pre-D2 draft; and "on staging and production" describes environments step 1
makes unreachable. This is the checklist's stale-claim-survives-the-edit class, in the same
paragraph that was rewritten to record a limit.

**Concrete failure scenario.** A later change widens the REVOKE (say, someone "tidies" it to
`REVOKE ALL ON job_outbox FROM PUBLIC` on the theory that PUBLIC subsumes the client roles — on
these projects `postgres` holds its grants *from itself*, so the outcome is not obvious). The
catalogue case stays green. The only guard that fires is the file-text case at `:108-120`, whose
regex is `revokes[0]).not.toMatch(/\b(postgres|service_role|PUBLIC)\b/)` — that specific mutation
would be caught, but any widening that does not literally spell one of those three words would not
be, and the case that is supposed to be the semantic backstop cannot help.

**Concrete fix.** Either (a) delete the four owner arms and state plainly that the file-text case is
the *only* guard, matching D2/D5's honesty about the anon arms — the suite is then smaller and says
what it means; or (b) make the case non-vacuous by asserting against a purpose-made non-superuser,
non-owner probe role in the bootstrap. (a) is the right call under "no abstraction before the second
use" and is the same reasoning D4 used. Either way both comments at `:36-40` and `:238-242` must be
corrected — as written they are the coverage claim the branch does not have.

---

## F5 — the security RLS register gains no row for the dispatch spine (low)

`docs/security/rls-inventory.md` is the human-facing register of RLS posture. Its header (`:7`)
scopes it to rows that are *"listed here (and in `TENANT_TABLES`)"*, but that parenthetical is
already inaccurate: `admin_audit_log` is listed at `:46` and is **not** a `TENANT_TABLES` member —
its entry reads *"Deny-all RLS with zero policies AND `REVOKE ALL … FROM anon, authenticated` … Not
a `TENANT_TABLES` member — `ci:rls-audit` does not cover it;
`migration-117-admin-audit-log.integration.test.ts` is the guard."* That is 119's shape verbatim,
and 117 is the precedent this branch cites in four documents.

After 119, `job_outbox` — the table every async workflow in the platform depends on — has deny-all
RLS plus a client-role REVOKE and appears nowhere in the register. The intake's `non_goals` forbid
touching the file ("owner decision 2026-09-07: future tables state their RLS posture in their own
migration instead"), so this is a knowing omission rather than an oversight. Raising it at [low] so
the owner re-confirms with the 117 asymmetry in view: the decision means the register now
under-reports relative to its own contents, and the next reader who greps it for "what is deny-all"
gets an answer that is missing the dispatch spine.

---

## 4. Locking and partial application — full answer

- **Is the prod ALTER a genuine no-op?** No. See F2.
- **Is `SET lock_timeout = '5s'` correctly scoped?** For `scripts/test-db-setup.sh`: yes. The driver
  (`:79-81`) emits `RESET ALL;` after **every** `\i`, so the session-scoped `SET` cannot leak into
  migration 120+, and the script's own header (`:35-40`) already names bare `lock_timeout` as a
  known hazard it handles. D3's switch from `SET LOCAL` to `SET` is correct and the reasoning is
  sound.
- **Half-applied windows.** I could not construct one that breaks anything:
  - *`apply_migration`*: a multi-statement string sent over the simple query protocol runs in an
    implicit transaction and aborts as a unit, so `SET` + `ALTER` + `REVOKE` + `COMMENT` is
    all-or-nothing. (Medium confidence on the transport — see the appendix.)
  - *psql via `test-db-setup.sh`*: `-v ON_ERROR_STOP=1` (`:132`) aborts the whole provision on the
    first error, and the `test_meta.provision` marker is written **last**, so an interrupted run
    reads as not-at-head to `ci:rls-audit` rather than as a false green. This is the right shape.
  - *Statement ordering if it ever did tear*: the ALTER is the only statement that can fail on lock
    contention, and `REVOKE` takes no relation lock. A tear that applied the REVOKE but not the
    ALTER would leave the table *more* locked down than intended for `anon`, not less — the safe
    direction.
  - *The genuine cross-environment window* is the intended one: between the staging apply and the
    prod apply, staging is at the new posture and prod is at RLS-on-with-grants. Nothing reads
    `job_outbox` on a client role in either, so nothing breaks. The staging-first order is correct.
- **What is missing** is a stated response to the likeliest operational outcome: `55P03
  lock_not_available` after 5 s on the production apply. Neither the migration, the intake's
  `observability`, nor the `rollback_plan` says what to do. It is not a rollback situation — it is a
  retry-in-a-quieter-window situation — and saying so costs one line.

---

## 5. Lockstep completeness — the branch's claim is CONFIRMED

Independent introspection, both projects, schema `public`, all `relkind IN ('r','p','v','m','f')`:

| Measure | prod | staging |
|---|---|---|
| relations | 54 | 54 |
| ordinary tables | 54 | 54 |
| `md5` of `relname:relrowsecurity:relforcerowsecurity:relacl:owner` over **all** relations | `5fe85b60…` | `1eb0f356…` |
| same `md5` **plus column ACLs**, over the 53 relations **excluding `job_outbox`** | `d32df96d25d9e466c7060b8ff716edda` (n=53) | `d32df96d25d9e466c7060b8ff716edda` (n=53) |
| `md5` of every `pg_policies` row (`table:policy:permissive:roles:cmd:qual:with_check`) | `ec629a1ee20641b267540ab61346c63b` | `ec629a1ee20641b267540ab61346c63b` |

The excluding-`job_outbox` hash is byte-identical across the two projects, and it covers RLS flag,
FORCE flag, full table ACL, ownership **and** column-level ACLs. Policy definitions — not just
counts — are byte-identical. **`job_outbox` is the only difference, and the migration's "the ONLY
table of the 54 in schema `public`" is exactly right, count included.** No additional drift to
report.

Two adjacent facts worth carrying forward, neither a finding:

- `relforcerowsecurity` is `false` on all 54 tables in both projects; `relowner` is `postgres` on all
  54 in both.
- The RLS-on-with-`anon`-INSERT combination the ticket flags for `job_outbox` is the *default* shape
  across the schema — 44 of 54 tables hold `anon` INSERT — but on every one of them RLS is enabled,
  and the deny-all ones carry zero policies, so the grant is inert. `job_outbox` on staging was the
  one place both controls were off simultaneously. The ticket's threat model is correct.

---

## Appendix — below the reporting bar

- **`SET lock_timeout` leaking onto the mgmt-api session.** `pg_stat_activity` shows a long-lived
  `mgmt-api` backend on both projects. If Supabase's `apply_migration` reuses that connection, the
  session-scoped `SET lock_timeout = '5s'` would persist for subsequent management SQL on it. I
  cannot determine the applier's connection lifecycle read-only, and migrations 092/101 already set
  the precedent, so this is not this branch's defect. ~50% confidence it is even real.
- **Implicit-transaction assumption for `apply_migration`.** §4's all-or-nothing claim rests on the
  applier sending the file as one simple-query string. Very likely, not verified.
- **Unqualified `job_outbox` in the ALTER/REVOKE.** Relies on `public` being in `search_path`. Under
  `test-db-setup.sh` the driver's `RESET ALL` guarantees the default; under `apply_migration` it is
  the mgmt session's. A wrong `search_path` would raise `42P01` rather than hit the wrong relation,
  so it fails loudly. Not worth a line in the migration.
- **Markdown nit.** The migrations-log 119 entry ends without a blank line before `- **118**`
  (`.claude/reference/migrations-log.md`, end of the added block), which makes the previously-loose
  list render tight from 118 downward. One newline.
- **`COMMENT ON TABLE` locking.** Takes `ShareUpdateExclusiveLock`, which does not block readers or
  writers. Correctly ignored by the migration's LOCKING section.
