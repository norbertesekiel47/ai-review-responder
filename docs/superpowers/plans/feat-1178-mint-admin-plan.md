# Plan — #1178 a single admin-minting path (`scripts/mint-admin.ts`)

Branch `feat/1178-mint-admin`. Intake: `docs/superpowers/plans/feat-1178-mint-admin-intake.json`
(`size=standard`, `risk=high`, `surface=backend`, `db_touching=true`).
Ticket: RepWorth/ai-review-responder#1178. Sign-off is **inherited from the
ticket body plus ADRs 0024–0031** per
`docs/superpowers/plans/2026-09-08-admin-split-orchestrator-handoff.md` §4
("the ticket IS the locked intent — grill only deltas"). No decision below
re-litigates a locked one.

## 1. Modules and seams (`codebase-design` pass)

| Seam | Decision |
|---|---|
| `scripts/mint-admin.ts` | **New file, and the only new production file.** No existing module fits: there is no admin-minting path at all (that is the ticket), and the one adjacent module — `src/lib/onboarding/admin-onboarding-service.ts` — mints an **owner** inside an account/business graph through a route composition root. Deepening it into "owner or admin" would put a `role` branch through the invite funnel and the Beta comp coupon path. |
| Placement — `scripts/`, not `src/lib/` | The ticket's own constraint: the operation needs `SUPABASE_SERVICE_KEY` and has no request context, so it is a script and never a route. Keeping it out of `src/lib/` also keeps a service-key-shaped module out of the tree the Vercel bundle walks, costs no `docs/directory/` row (`ci:directory-map` scans `worker/` + `src/lib/`), and matches the four sibling operator scripts. |
| Testing a `scripts/` module | Precedent, not invention: `scripts/staging-guard.ts`, `scripts/wedge-repro.ts`, `scripts/burst-drill-load.ts` and `scripts/health-bundle-differential.ts` are all tested from `scripts/ci/__tests__/`. `vitest.config.ts` includes `scripts/ci/**/__tests__/**/*.test.ts`, so **no config change is needed** — and `INTEGRATION_GLOB` is `**/__tests__/**/*.integration.test.ts`, so the live-DB suite lands there too. |
| Import-safety | `runDirectCli` (`scripts/run-direct-cli.ts`) — the module runs `main()` only when Node invoked it directly, which is what lets the unit suite import its exports. |
| DB client | The script is a **composition root** (invariant #15): it builds its own `postgres` client from `DATABASE_POOL_URL` exactly like `scripts/ws8-staging-smoke.ts`'s `connect()` (`prepare: false`, explicit `connect_timeout`, `statement_timeout: 30_000`), rather than importing the `src/lib/db/server` singleton. The singleton reads `process.env` **at module scope**, and ESM hoists imports above the statement that would populate it — so a `--env staging` selection could not reach it. |
| Audit sink | `writeAdminAuditLog` (`src/lib/audit/log.ts`) — the only sanctioned `admin_audit_log` writer (migration 117). It already accepts a `TransactionSql`, so no interface widens. |
| Reused guards | `PROD_PROJECT_REFS` / `describeConnectionTarget` / `extractProjectRefForLog` from `scripts/staging-guard.ts`. **Not** `assertStagingTarget`: that is a positive allowlist pinned to the staging ref, and #1179 must eventually mint into production. `assertMintTarget` is a new, **stricter** guard — it keeps the prod denylist unweakened and requires the confirmed ref to EQUAL the ref parsed out of both halves of the target, rather than the `includes()` test `staging-guard.ts:65,76` uses (see finding F2). |
| Reset path | `resetPasswordPathForFlow('admin')` (`src/lib/shared/auth-flow.ts`), never a hardcoded `/admin/reset-password`. |

Nothing else widens. No abstraction is introduced for a single caller: every
export below is a seam the test suites drive directly.

## 2. Deltas resolved from the code (not from the owner)

| Delta | Resolution | Evidence |
|---|---|---|
| **(a) `admin_audit_log.actor_user_id` is NOT NULL — who is the actor when a script mints?** | **The minted admin is its own actor**, resolved inside the same transaction as the `users` INSERT so the FK is satisfied. **No migration.** `writeAccountAuditLog` models a system actor as `actorUserId: null`; `admin_audit_log` structurally cannot (117 made the column NOT NULL deliberately — "admin users are never purged … a delete that would cascade a security trail away must fail loudly"). Requiring an *existing* admin as actor is impossible by construction: #1182 revokes every admin and then re-mints with this script, so the bootstrap case has an empty admin set. Self-actor is the shape `mfa_factor_enrolled` already uses — the admin is actor and subject of their own enrolment (`src/app/api/auth/mfa/challenge/route.ts:88`). The operator is recorded in the payload, not in the FK column. | `supabase/migrations/117_admin_audit_log.sql:32-35,51`; `src/lib/audit/log.ts:66-101`; `src/app/api/auth/mfa/challenge/route.ts:76-99`; handoff §2.1 |
| **(b) `users` column facts** | `users.id` has no default (`002_prompt2_fixes.sql:31` dropped it) → the script supplies `randomUUID()` from `node:crypto` (invariant #10; same as `e2e/harness.ts` and `scripts/ws8-staging-smoke.ts` for `users` rows). `users.auth_id` is `VARCHAR(255) UNIQUE` (`001:53`) → bound as text, never `::uuid`. `users_role_check` allows only `'owner'`/`'admin'` (`053`). `users.account_id` is nullable since `039` and is `NULL` for an admin. | `001_initial_schema.sql:45-57`, `002_prompt2_fixes.sql:31`, `039:51`, `053:29-30` |
| **(c) Refusals** | Three, and the two that matter run **inside the transaction** so they are serialized against the INSERT rather than racing it: an existing `users` row for the email (any role — `users_email_key` is unique per value and an owner with that email must never be silently converted), and an existing `users` row for the resolved `auth_id`. A cheap read-only email pre-check runs **before** the Auth call so the happy refusal path creates no Auth user to compensate for. | `001:47,53`; `provision-auth-user.ts:47-56` (the pre-check-then-constraint shape) |
| **(c′) The existing-Auth-login refusal has TWO independent closers** | (1) A **read-only `auth.users` probe over Postgres**, run BEFORE the dry-run return so dry run and real run make the same refusals — the shape `provisionAuthUser` already uses (`src/lib/auth/provision-auth-user.ts:67-77`). It is guarded by `SELECT to_regclass('auth.users')` because `scripts/ci/test-db-bootstrap.sql:57-60` creates schema `auth` with `auth.uid()` and **no `auth.users` relation**; when the relation is absent the probe reports `unavailable` **loudly** rather than silently passing, and dry run says it could not verify the Auth half. (2) On the real run, `auth.admin.createUser`'s own duplicate-email error, classified (`code === 'email_exists'`, HTTP 422, or an "already registered" message) into `refused: auth_user_exists` — mirroring `classifyAuthError` (`:135-160`) and closing the TOCTOU window the probe leaves open. | `scripts/ci/test-db-bootstrap.sql:57-60`; `src/lib/auth/provision-auth-user.ts:67-77,135-160` |
| **(d) Print a link, never a password** | `createUser` is called with **no `password` field at all**, so there is no password to leak — the property is structural, not a redaction rule. The link comes from `generateLink({ type: 'recovery' })` → `properties.hashed_token`, rebuilt onto **this app's** `/api/auth/callback` exactly as `e2e/harness.ts:127-142` does. **Never `properties.action_link`**: that is Supabase's hosted `/verify`, which honours only the project's Redirect-URL allowlist. | `e2e/harness.ts:118-142`; `src/app/api/auth/callback/route.ts`; `src/lib/shared/auth-flow.ts:17-19` |
| **(e) Both projects, staging first** | Environment selection, per the handoff. `--env staging` parses `.env.staging.local` with `dotenv.parse` (never `source` — the file has an unquoted `<…>` value that a shell reads as a redirection) and maps `STAGING_X → X`, **falling back to `STAGING_NEXT_PUBLIC_SUPABASE_URL` when `STAGING_SUPABASE_URL` is empty**, which it is in this repo's copy. `--env local` does the same for `.env.local` with no prefix. With no `--env`, the ambient environment is used — the `railway run` / prod-scoped-shell form. | `docs/runbooks/mfa-factor-reset.md:150-180`; `docs/runbooks/deployment-guide.md:1431` |
| **(f) Composition-root shape** | Named precedent: **`scripts/ws8-staging-smoke.ts`** (`requireEnv` + its own `postgres()` client, no `src/lib/db/server` import). Secondary: `scripts/zernio-backfill-external-replies.ts` shows the singleton-import form, which this script deliberately does not take, for the hoisting reason in §1. | `scripts/ws8-staging-smoke.ts:88-104` |

**Ordering decision (auth-first, then one DB transaction).** A true two-phase
commit across Supabase Auth and Postgres does not exist. What
`admin-onboarding-service.ts` supplies is the **compensation** precedent, not
the ordering one: it creates the database rows FIRST
(`src/lib/onboarding/admin-onboarding-service.ts:252`), then invites (`:286`),
then patches `auth_id` (`:335`), compensating at each failure. **Auth-first is
this script's own decision**, and the reason is that same file's warning: an
admin-created row whose `auth_id` stays NULL locks the person out
(`:231`). Because the mint
knows the `auth_id` before it INSERTs, both DB rows go into ONE `sql.begin`
and there is **no `auth_id IS NULL` window at all** — a window the onboarding
service can only close by patching afterwards.

**Compensation is conditional, never unconditional (finding F1).** A rejected
`sql.begin` does **not** prove the transaction rolled back: a lost COMMIT
acknowledgement rejects on a transaction that actually committed —
`src/lib/db/transient-error.ts:74` names it exactly ("`08007`
transaction_resolution_unknown — ambiguous COMMIT outcome, no reconciler") and
deliberately EXCLUDES it from the crash-net's recoverable set for want of a
reconciler. This script has one. (And
`src/lib/db/server.ts`'s `supabaseServer` doc comment records the same
ambiguity for the Auth side — "a mutation that commits remotely but responds
slowly must NOT surface as a TimeoutError with no reconciliation path"). So on
a transaction error the script **reconciles first**: it re-reads
`SELECT id FROM users WHERE auth_id = <new auth id>`.

**An absent row is not a rollback either (round-2 follow-up).** A read on a
second connection that finds nothing is equally consistent with "the original
transaction is still in flight and its COMMIT lands a moment later" — delete
the Auth user there and the dangling-`auth_id` row appears anyway. So the
script deletes **only on CONFIRMED rollback**, and confirmation has exactly two
sources:

1. **A refusal this script itself raised** inside the transaction body
   (`MintRefusal`, thrown before any COMMIT is issued). The statement never
   reached COMMIT, so the rollback is certain by construction.
2. **A server-raised SQLSTATE in a deterministic, statement-level class** —
   `22` (data exception), `23` (integrity constraint violation), `42`
   (syntax/access rule). Postgres processed the statement, rejected it, and
   postgres.js rolled the transaction back. Anything else — **no `code` at
   all** (a client/socket failure), class `08` (connection exception), `57`
   (operator intervention / `57014 query_canceled`), or any unrecognised
   code — is AMBIGUOUS and never confirms a rollback. This is the same
   conservative direction `src/lib/db/transient-error.ts:70-77` takes when it
   omits `08007` and every unlisted `08xxx` from the crash-net's recoverable
   set: "anything ambiguous or unknown still fails fast".

   Mechanically this is safe to test structurally, and the house shape for
   doing so is `src/lib/channels/unique-violation.ts` (`asPostgresError` plus a
   `code` test, no import of postgres's error class):
   `node_modules/postgres/src/errors.js:30-33` builds a `PostgresError` by
   `Object.assign`-ing the server's error message onto it, so `code` is the
   five-digit SQLSTATE; `:16-27` gives every connection failure a NON-numeric
   code (`CONNECTION_CLOSED`, `ECONNRESET`, …) and `:35-38` does the same for
   generic errors. So `/^(22|23|42)\d{3}$/` matches server rejections and can
   never match a socket failure.

**Every post-transaction path runs the SAME reconciliation, with no
special case (round-3 follow-up G2).** Confirmed rollback proves only that
*this invocation's* transaction did not commit — it says nothing about whether
some other row is already linked to the Auth identity. So the read happens
first, unconditionally, and the refusal reason only decides what is REPORTED:

| Reconciliation outcome | Action |
|---|---|
| The read itself fails | **Do not delete.** `failed`, with `orphanAuthId` and the reconciliation-uncertain reason. |
| Row present, `id` EQUALS this invocation's generated `userId` | The COMMIT landed. **Do not delete.** `minted`; carry on to the recovery link. |
| Row present, `id` DIFFERS | Another `users` row is linked to this Auth identity. **Do not delete** — that would revoke a different admin's login. `refused` (`auth_id_taken`) when a `MintRefusal` was raised, otherwise `failed`; either way name both ids and the orphan Auth id. |
| No row, and rollback is CONFIRMED (a `MintRefusal`, or a class-22/23/42 SQLSTATE) | The Auth user is genuinely orphaned. Compensate with `deleteUser`; a failing delete surfaces `orphanAuthId`. Return `refused` when a `MintRefusal` was raised, otherwise `failed`. |
| No row, and the error is AMBIGUOUS | **Do not delete** — the transaction may still be in flight. `failed`, with `orphanAuthId` and the reconciliation-uncertain reason. |

Classification always keys on the error that ESCAPED the awaited `sql.begin`
call, never on an earlier body error: postgres.js awaits the ROLLBACK before
rethrowing (`node_modules/postgres/src/index.js:267`), so a rollback that
itself fails surfaces its own error and is correctly treated as ambiguous.

The bias is the same in every uncertain row: an orphan Auth user is a nuisance
the runbook cleans up in one command, whereas deleting the identity behind a
committed `users` row produces exactly the unusable half-2 state the ticket
exists to prevent (invariant #8).

## 3. Public surface (`scripts/mint-admin.ts`)

```ts
export interface MintAdminArgs {
  email: string; name: string; confirmRef: string;
  envMode: 'ambient' | 'local' | 'staging'; dryRun: boolean;
}
export class MintAdminUsageError extends Error {}

export function parseMintAdminArgs(argv: readonly string[]): MintAdminArgs;
export function resolveMintEnv(fileVars: Record<string, string>, prefix: string): Record<string, string>;
export function assertMintTarget(input: { supabaseUrl: string; dbTarget: string; confirmRef: string }): void;
export function buildAdminRecoveryUrl(appUrl: string, hashedToken: string): string;

export type MintRefusalReason = 'users_row_exists' | 'auth_user_exists' | 'auth_id_taken';
export class MintRefusal extends Error { constructor(readonly reason: MintRefusalReason, readonly detail: string) { super(detail); } }
export function confirmsRollback(error: unknown): boolean;   // SQLSTATE class 22/23/42 only
export type AuthProbeState = 'checked' | 'unavailable';
export type MintAdminResult =
  | { status: 'minted'; userId: string; authId: string; recoveryUrl: string | null; recoveryLinkError: string | null }
  | { status: 'would_mint'; authProbe: AuthProbeState }
  | { status: 'refused'; reason: MintRefusalReason; detail: string }
  | { status: 'failed'; detail: string; orphanAuthId: string | null };

export async function mintAdmin(
  sql: Sql, supabase: SupabaseClient,
  input: { email: string; name: string; appUrl: string; dryRun: boolean },
): Promise<MintAdminResult>;
```

`assertMintTarget` (finding F2) — the confirmed ref must (1) match
`/^[a-z0-9]{20}$/`, the Supabase project-ref shape both known refs have, so a
partial or common substring such as `supabase` is refused outright; (2) not be,
and not contain, any `PROD_PROJECT_REFS` member, and neither may either actual
target (the denylist runs FIRST and beats every flag, exactly as
`scripts/staging-guard.ts:41-49` does); and (3) EQUAL the ref parsed out of the
Supabase URL host (`<ref>.supabase.co`) **and** the ref parsed out of the
database connection target (`db.<ref>.…` or `postgres.<ref>@…`, the two forms
`extractProjectRefForLog` already knows). Exact equality on parsed refs — not
`includes()` — is what makes a mismatched credential pair (staging Supabase URL
beside a different project's database URL) impossible to confirm, and an
unparseable target is a refusal, never a pass.

`mintAdmin` steps: normalise the email (trim + lowercase) → read-only
`users`-by-email pre-check → read-only `auth.users`-by-email probe, guarded by
`SELECT to_regclass('auth.users')` (finding F3: this runs BEFORE the dry-run
return, so dry run makes every refusal the real run makes; when the relation is
absent the state is `unavailable` and is printed as a loud caveat) → `dryRun`
returns `would_mint` here → `createUser({ email, email_confirm: true,
user_metadata: { full_name } })` with **no `password` field at all** → one
`sql.begin` that re-checks email and `auth_id` (serialised against the INSERT,
each raising `MintRefusal` so the refusal is nameable rather than swallowed by
the reconciliation path) then INSERTs `users (id, name, email, role='admin',
auth_id, account_id=NULL)` and calls `writeAdminAuditLog(tx, { actorUserId:
userId, eventType: 'admin_minted', entityType: 'users', entityId: userId,
payload })` → on throw, the **conditional** compensation table above →
`generateLink` → `buildAdminRecoveryUrl`. A `generateLink` failure after a committed mint is
**not** a failed mint: the result is `minted` with `recoveryUrl: null` and a
`recoveryLinkError`, and the runbook says re-issue a link, never re-mint.

**The Supabase client is UNBOUNDED, deliberately.** `src/lib/db/server.ts`
(the `supabaseServer` doc comment) forbids routing identity-CREATING mutations
through the bounded client: "an aborted-but-committed signUp/createUser leaves
an orphaned Auth identity and later `account_exists` lockouts." For the same
reason `createUser` is **never auto-retried** — a retry is what would create
the second identity for one human that the ticket's own §"Why it matters"
warns about. The operator re-runs, and the refusals make that idempotent. The
Postgres side is bounded by `connect_timeout` and `statement_timeout`.

`main()` parses, resolves config, builds both clients, calls
`assertMintTarget`, prints `TARGET` (project ref + Supabase host +
`user@host:port`, never a password or key), runs `mintAdmin`, prints, and
`sql.end()`s in a `finally`. Exit codes: `0` mint or dry run, `2` usage, `3`
refusal, `4` failure.

## 4. Tracer bullets

Every tracer touches the same one production file, so they are **strictly
serial and implemented in this session — no subagent fan-out.** Two editing
agents on `scripts/mint-admin.ts` would violate the delegation contract's
disjoint-lease rule for zero wall-clock gain.

| # | Tracer | Turns green (verbatim `tests_to_add` titles) | Files |
|---|---|---|---|
| **T1** | **EVAL, first and committed before any implementation.** Both suites authored RED against the not-yet-existing exports. | all 30 | `scripts/ci/__tests__/mint-admin.test.ts`, `scripts/ci/__tests__/mint-admin.integration.test.ts` |
| **T2** | CLI contract + target guard + link builder | `refuses when the Supabase host does not contain the confirmed project ref`; `refuses when the database target does not contain the confirmed project ref`; `refuses a confirmed ref that is not a full Supabase project ref`; `refuses a production project ref outright`; `refuses when --confirm-ref is missing`; `refuses when --email or --name is missing`; `parses email, name and the dry-run flag`; `lowercases and trims the email before use`; `maps STAGING_-prefixed variables onto their bare names`; `falls back to STAGING_NEXT_PUBLIC_SUPABASE_URL when STAGING_SUPABASE_URL is empty`; `builds the admin recovery URL from hashed_token and the admin reset path` | `scripts/mint-admin.ts` |
| **T3** | `mintAdmin` — refusals, probe, transaction, audit, conditional compensation | `refuses when a users row already exists for the email`; `refuses when an auth user already exists for the email`; `refuses when a users row already exists for the resolved auth id`; `deletes the created auth user when the mint transaction fails`; `does not delete the auth user when the mint transaction committed despite an error`; `does not delete the auth user when the post-failure reconciliation read also fails`; `preserves the auth user when the transaction outcome is ambiguous`; `treats a reconciled row with a different id as a failure, not a mint`; `auth_id_taken returns refused without deleting the linked auth identity`; `returns a refusal when the in-transaction email re-check fires`; `reports the orphan auth id when the compensating delete also fails`; `dry run performs the refusal checks and writes nothing`; `refuses in dry run when an auth identity already exists for the email`; `reports the auth probe as unavailable when auth.users is absent`; `never prints a password`; `records the mint through writeAdminAuditLog with the new admin as its own actor` | `scripts/mint-admin.ts` |
| **T4** | Live-DB proof against the real schema | `commits the users row and its admin_audit_log row in one transaction`; `leaves no users row when the audit write fails`; `refuses a second mint for the same email against the live schema` | `scripts/mint-admin.ts` |
| **T5** | Entry point + runbook | (covered by T2–T4; the CLI glue is `scripts/`-only, which `scripts/diff-coverage.ts:6-8` puts out of the changed-line-coverage scope by design) | `scripts/mint-admin.ts`, `docs/runbooks/mint-admin.md` |

Blocking edges: T1 → T2 → T3 → T4 → T5. T4 additionally requires the local
test DB at migrations head (`pnpm test:db:setup`) — the container is up and
`TEST_DATABASE_POOL_URL` resolves; `assertSchemaReady` fails loudly otherwise.

**Live-DB suite conventions** (`.claude/rules/live-db-tests.md`): named
`*.integration.test.ts` so it joins vitest's serialized `integration` project;
**no run-time DDL** — it declares a local `SchemaRequirement` for migration 117
(`admin_audit_log` + `admin_audit_log.actor_user_id`) and asserts it, exactly
as `src/lib/refusals/__tests__/write.integration.test.ts` declares migration
116's inline rather than editing `schema-ready.ts` (which is outside this
branch's `allowed_edit_surface`). It seeds and cleans by `INSERT`/`DELETE` on
its own unique `@mint-admin.test` emails only.

**Property tests**: not owed. The intake touches no billing, approval /
auto-approval, or escalation state machine; the invariants here are structural
(one transaction, one audit row, no password) and are pinned by example plus
the live-DB suite.

## 5. Rollback, authority, evidence

- **Rollback**: intake `rollback_plan`. No migration, no flag, no schema change,
  no runtime caller.
- **Authority**: `commit`, `push`, `pull_request`, `staging_deploy`, `merge`.
  The staging ride and the staging smoke are authorised by the orchestrator
  brief §"Step 8 authority". **Production Supabase is not touched.** No flag
  flip. No migration.
- **Staging smoke** (step 8): dry run first, then one disposable
  `mint-admin-smoke-<yyyymmdd>@repworth.net` admin against **staging only**,
  proving both halves linked, the re-run refusal, the `admin_audit_log` row and
  the printed link. The identity is named in the PR and the report for the
  owner to revoke; its rows are left in place (#1182 revokes, never deletes).

## 6. Review appendix

### Plan round 1 — Codex plan skeptic, `VERDICT: REVISE`

Session id `01a07ebd-d9b8-71b0-9efa-06244a09abff` (record it: a verification
round RESUMES this session, never starts cold). Dispatched read-only via
`codex exec` with the failability / cited-artifacts / invariants brief. The
first invocation was killed by the harness mid-round; the same session was
RESUMED to emit its deliverable from analysis it already held — a continuation
of round 1, not a second round, and not an independent axis.

Its lead finding is the one that matters: **yes, all 21 promised tests could
pass while minting remained wrong.**

| # | Sev | Finding | Verdict | Disposition |
|---|---|---|---|---|
| F1 | High | Lost COMMIT acknowledgement: `sql.begin` rejects on a transaction that committed, so unconditional compensation deletes the Auth identity behind committed `users` + `admin_audit_log` rows (invariant #8). | **ACCEPT** | §2 gains the conditional-compensation table (reconcile by `auth_id`, compensate only on confirmed absence, fail closed toward keeping the Auth identity). Two new failing tests: `does not delete the auth user when the mint transaction committed despite an error`, `does not delete the auth user when the post-failure reconciliation read also fails`. Evidence for the class: `src/lib/db/transient-error.ts:74` ("`08007` … ambiguous COMMIT outcome, no reconciler"). |
| F2 | High | `--confirm-ref supabase` is a substring of both ordinary Supabase targets, so a substring check proves no target agreement. | **ACCEPT** | `assertMintTarget` now requires the confirmed ref to match `/^[a-z0-9]{20}$/` and to EQUAL the ref PARSED out of each target; the prod denylist still runs first over both actual targets. New failing test: `refuses a confirmed ref that is not a full Supabase project ref`. |
| F3 | Medium | Dry run returns `would_mint` before consulting Auth, so it contradicts its "every refusal check" contract for an Auth-only identity. | **ACCEPT** the gap; **REJECT** the proposed remedy | The gap is real and the probe moves BEFORE the dry-run return. The proposed remedy — "a paginated, read-only Auth API lookup" — is rejected on the installed SDK's own type: `listUsers(params?: PageParams)` where `PageParams = { page?: number; perPage?: number }` and nothing else — read from the installed package's own `dist/module/lib/types.d.ts` (auth-js 2.106.2, resolved through pnpm's nested store, the same lookup `docs/runbooks/mfa-factor-reset.md` documents) — so there is no email filter and the lookup means walking an entire project's Auth users on every dry run. The read-only `auth.users` Postgres probe gets the same property in one indexed query and is the shape `src/lib/auth/provision-auth-user.ts:67-77` already uses. Its one weakness — `scripts/ci/test-db-bootstrap.sql:57-60` creates no `auth.users` — is met by reporting `authProbe: 'unavailable'` LOUDLY rather than passing silently, which is exactly the reviewer's "lookup failure must prevent an unqualified `would_mint`". Three new failing tests: `refuses in dry run when an auth identity already exists for the email`, `reports the auth probe as unavailable when auth.users is absent`, and the real-run `refuses when an auth user already exists for the email`. |
| F4 | Low | The cited ordering precedent is mischaracterised: `admin-onboarding-service.ts` creates DB rows first, then invites, then links `auth_id`. | **ACCEPT** | §2's ordering paragraph rewritten: that file is the COMPENSATION precedent (`:252`, `:286`, `:335`); Auth-first is this script's own decision, justified by the same file's `auth_id`-must-never-stay-NULL warning (`:231`). |

`tests_to_add` grows 21 → 26; `allowed_edit_surface` is unchanged, so this is
**not** a surface amendment (`incr-amendment` not called). Both intake copies
were re-installed with the new titles and the F1/F3 edge cases.

### Plan round 2 — verification only, `VERDICT: REVISE`

`contract-changed` reported CHANGED (the round-1 fixes moved `tests_to_add`),
so the round was owed. Dispatched by RESUMING session
`01a07ebd-d9b8-71b0-9efa-06244a09abff` rather than cold, per
`review-prompts.md` § Dispatching a Codex round rule 2.

Result: **F2 ADDRESSED, F3 ADDRESSED** (it accepted the `auth.users` probe over
its own `listUsers` proposal — "reasonably addresses the gap without listing
every Auth user"). **F1 and F4 NOT ADDRESSED**, plus two defects the fixes
introduced:

| # | Sev | Finding | Verdict | Disposition |
|---|---|---|---|---|
| G1 | High | A negative reconciliation read does not prove rollback: the original transaction may still be IN FLIGHT and commit a moment after the Auth user is deleted. | **ACCEPT** | Compensation now requires a **confirmed** rollback, with exactly two sources — a `MintRefusal` this script raised inside the transaction body (before any COMMIT), or a server-raised SQLSTATE in class `22`/`23`/`42`. No code, class `08`, class `57`, or an unrecognised code is AMBIGUOUS and preserves the Auth identity. Direction copied from `src/lib/db/transient-error.ts:70-77`. New failing test: `preserves the auth user when the transaction outcome is ambiguous`. |
| G2 | High | Any row matching the `auth_id` was treated as this mint: an `auth_id_taken` refusal would throw, reconciliation would find that OTHER row, and the run would report `minted`. | **ACCEPT** | Two changes. The in-transaction re-checks now raise a typed `MintRefusal`, caught FIRST and returned as `refused` — it never reaches the reconciliation path. And reconciliation requires the returned `users.id` to EQUAL this invocation's generated `userId`; a different id is `failed` (and is never deleted — it is another admin's identity). New failing tests: `treats a reconciled row with a different id as a failure, not a mint`, `returns a refusal when the in-transaction email re-check fires`. |
| G3 | Low | F4's correction landed in the plan but the intake's `existing_patterns_to_follow[0]` still said "Auth identity first, then the database rows". | **ACCEPT** | Intake entry rewritten to name the file as the COMPENSATION precedent and Auth-first as this script's own decision. |

`tests_to_add` grows 26 → 29; `allowed_edit_surface` still unchanged, so still
not a surface amendment.

### Plan round 3 — verification only, the CAP. `VERDICT: REVISE`, one finding, applied

`contract-changed` reported CHANGED again (round 2's fixes moved
`tests_to_add`), so the round was owed. Resumed the same session.

Result: **G1 ADDRESSED, G3 ADDRESSED.** It also judged the confirmed-rollback
rule explicitly, which is what it was asked to do: *"sound and conservative for
errors escaping the awaited `sql.begin` call — postgres.js awaits rollback
before rethrowing a transaction-body error
(`node_modules/postgres/src/index.js:267`) … Server-origin SQLSTATE classes
22/23/42 are reasonable here; preserving Auth for everything else is
conservative."* Its one caveat — classify on the error that ESCAPES, never
substitute the earlier body error — is now stated in §2.

| # | Sev | Finding | Verdict | Disposition |
|---|---|---|---|---|
| G2′ | High | The refusal row compensated EVERY `MintRefusal`, `auth_id_taken` included, before checking whether another `users` row holds that Auth identity — so the one branch that means "another row is linked" was the one branch that skipped the new protection. Confirmed rollback proves only that THIS transaction did not commit; it proves nothing about another row. | **ACCEPT** — the reviewer's own smallest correction, applied verbatim | The `MintRefusal` special case is DELETED. Every post-transaction path now runs the same reconciliation read first, and the refusal reason only decides what is reported. New failing test: `auth_id_taken returns refused without deleting the linked auth identity`. |

**Round cap reached; no round 4, and nothing is being escalated to the owner.**
`/feature` §3 step 4 stops the loop after round 3 and asks the root to surface
*unresolved disagreement*. There is none: G1 and G3 came back ADDRESSED, the
confirmed-rollback rule was judged sound, and G2′ is the reviewer's own
proposed correction adopted without modification. `tests_to_add` 29 → 30;
`allowed_edit_surface` unchanged across all three rounds — zero surface
amendments. The step-7 branch wave re-checks the implementation of every one of
these against the actual diff.

**PLAN LOCKED.**
