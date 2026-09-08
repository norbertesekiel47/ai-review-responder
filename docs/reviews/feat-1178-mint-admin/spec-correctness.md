# Review — SPEC & CORRECTNESS axis · feat/1178-mint-admin

Read-only pass. Every file read with `git show 8c4108b4…:<path>` at the pinned
HEAD `8c4108b4bd2a6a50a2a63b5b7a044fd050719a39`; diff taken against the pinned
merge-base `b23172836bc5c435dc429f1fa7505812c168fa87`. The working tree was
never read for a production file (a red-team mutation pass is live in this
worktree). The one exception is `docs/reviews/feat-1178-mint-admin/blast-radius.md`,
which **does not exist at the pinned SHA** (`fatal: … exists on disk, but not in
8c4108b4…`) — it is untracked, so it could not be read at HEAD and is not
relied on by anything below.

## Findings

| Sev | file:line | Contract field | Finding |
|---|---|---|---|
| medium | scripts/mint-admin.ts:790 | `user_visible_behavior[0]`, `observability[0]`, plan §3 `main()` | TARGET is printed only inside `formatMintReport` AFTER `mintAdmin` returns, so it is never printed *before* a write, and not printed at all when `mintAdmin` throws. |
| medium | scripts/mint-admin.ts:525 | `user_visible_behavior[5]`, `edge_cases[1]` | `isDuplicateEmailError` accepts ANY `status === 422`, so a non-duplicate GoTrue validation failure is reported as `REFUSED (auth_user_exists)` and routes the operator to a runbook section for an identity that does not exist. |
| low | scripts/mint-admin.ts:86 | `user_visible_behavior[0]`, `tests_to_add[6]` | `flagValue` returns the next argv token unconditionally: `--email --dry-run …` parses `email='--dry-run'` and passes the required-flag checks; feeds the 422 misclassification above. |
| low | docs/superpowers/plans/feat-1178-mint-admin-handoff.md:43 | run-doc accuracy (checklist class, `feat/1088` precedent) | "Phase `plan_approved`. Tracers T1–T5 registered" is stale at HEAD — all five tracers landed; a resuming session would re-execute T1. |
| low | scripts/ci/__tests__/mint-admin.test.ts:545 | `tests_to_add[26]` | "…with the new admin as its own actor" asserts only `values` *contains* `userId`; `entity_id` alone satisfies it, so a mutant binding a different `actor_user_id` survives this test (the live suite does pin it). |
| low | scripts/ci/__tests__/mint-admin.integration.test.ts:179 | `tests_to_add[28]` | "leaves no users row when the audit write fails" never fails the audit write: the real `writeAdminAuditLog` succeeds and a *separate* forced `INSERT INTO admin_audit_log` is appended after the callback. It proves the tx boundary, not the titled cause. |

## Detail

### M1 — TARGET is printed after the write, not before

`main()` builds `target` at `scripts/mint-admin.ts:764-768`, then calls
`mintAdmin` at `:784` and only prints at `:790`, because the TARGET line is the
first element `formatMintReport` returns (`:701-703`).

The intake is explicit twice:

* `user_visible_behavior[0]` — "…the script prints TARGET (project ref, Supabase
  host, user@host:port database descriptor) **before it writes anything**".
* `observability[0]` — "Every run prints TARGET … **before any write**, and every
  refusal exits non-zero naming the reason — the script is interactive, so the
  terminal is the primary signal".

The plan's own `main()` description (§3) states the same order: "calls
`assertMintTarget`, prints `TARGET` …, runs `mintAdmin`, prints".

Failure scenario. `mintAdmin`'s first statement (`findUserByEmail`, `:544`) and
the probe (`:553`) are not wrapped; a Postgres connect/`statement_timeout`
failure, or a network throw out of `supabase.auth.admin.createUser` (`:576`,
deliberately unwrapped and never retried), propagates out of `mintAdmin`, out of
`main`, into `runDirectCli`'s `onError`, which prints only `error.message`
(`scripts/run-direct-cli.ts:17`, `mint-admin.ts:807`). The operator gets a bare
`connect ETIMEDOUT` with **no record of which project the run was pointed at** —
which is precisely the signal the runbook calls "the only thing standing between
you and the wrong project" (`docs/runbooks/mint-admin.md:59-60`). On a *successful*
real run TARGET does appear, but only after both the Auth `createUser` and the
Postgres transaction have already executed, so the stated pre-write ordering is
unmet in every case.

Mitigating: `assertMintTarget` (`:758`) still runs before any client is built,
so this is an observability/ordering defect, not a mis-targeting hole.

Smallest fix consistent with the plan: emit the TARGET line in `main()`
immediately after `assertMintTarget`, and have `formatMintReport` return the
result lines only (the `never prints a password` test at
`scripts/ci/__tests__/mint-admin.test.ts:514-525` asserts on the joined report
and would need its TARGET expectations moved with it).

### M2 — `status === 422` alone is not "duplicate email"

```ts
// scripts/mint-admin.ts:522-528
function isDuplicateEmailError(error: { code?: string; status?: number; message?: string }): boolean {
  return (
    error.code === 'email_exists' ||
    error.status === 422 ||
    /already (been )?registered|already exists/i.test(error.message ?? '')
  );
}
```

422 is GoTrue's generic unprocessable-entity status: `email_address_invalid`,
`weak_password` and `validation_failed` all carry it, not only `email_exists`.
The cited precedent does **not** do this — `classifyAuthError`
(`src/lib/auth/provision-auth-user.ts:149-170`) keys the positive branch on
rate-limit codes plus `status === 429` and reaches `account_exists` only as a
deliberate **anti-enumeration fallback** in a public signup route. This script is
operator tooling with no enumeration concern, so inheriting the fallback as a
positive test is an inversion of the precedent's reason.

Concrete failure: with the argv hole in L1 below, `pnpm tsx scripts/mint-admin.ts
--email --name "New Admin" --confirm-ref <ref> --env staging` parses
`email='--name'`, passes both guards, calls `createUser({ email: '--name' })`,
and GoTrue answers 422 `email_address_invalid`. The script prints
`REFUSED (auth_user_exists): Supabase Auth already has an identity for --name.
Resolve it by hand (docs/runbooks/mint-admin.md § An Auth identity with no users
row)` and exits 3. The operator follows that section, runs
`SELECT … FROM auth.users WHERE lower(email) = lower('--name')`, gets zero rows,
and has no signal that the real cause was a malformed argument. The correct
outcome for a non-duplicate 422 is `status: 'failed'` with the provider message
(the branch already at `:591-595`).

Contract violated: `user_visible_behavior[5]` — the refusal is specified as
riding "the Auth API's own **duplicate-email** refusal", and plan §2 (c′) names
the intended classifier as "`code === 'email_exists'`, HTTP 422, or an 'already
registered' message" — the implementation is faithful to the plan text, so the
defect is in the plan's classifier as adopted, not a deviation from it. Suggested
narrowing: `code === 'email_exists' || (status === 422 && /already …/.test(message))`.

### L1 — `flagValue` swallows the following flag as a value

`scripts/mint-admin.ts:83-87` does `argv.indexOf(flag)` then returns
`argv[index + 1]` with no check that the next token is not itself a `--flag`.
`parseMintAdminArgs` only rejects *empty* values (`:96-98`), so:

* `--email --dry-run --name X --confirm-ref <ref>` → `email='--dry-run'`, and
  `dryRun` is still `true` (it is computed by `argv.includes('--dry-run')`,
  `:103`), so a dry run silently probes the wrong email;
* `--name --dry-run …` → an admin minted with `users.name = '--dry-run'`;
* `--confirm-ref --dry-run` is safe by accident — it fails
  `PROJECT_REF_PATTERN` at `:252`.

`tests_to_add[5]` (`refuses when --email or --name is missing`) is satisfied by
the *omitted-flag* case only; the suite
(`scripts/ci/__tests__/mint-admin.test.ts:101-108`) never passes a flag-shaped
value. One `value.startsWith('--')` guard in `flagValue` closes it.

### L2 — the handoff's phase is stale at HEAD

`docs/superpowers/plans/feat-1178-mint-admin-handoff.md:41-44` still reads
"Phase `plan_approved`. Tracers T1–T5 registered". At HEAD all five have landed:
`scripts/mint-admin.ts` (810 lines), both suites, `docs/runbooks/mint-admin.md`,
and the `arch-review-log.md` entry. This is the accepted defect class recorded on
`feat/1088-chart-readability` ("the handoff still claims 'T1 done, no production
code yet'") — a session resuming from this document would re-execute T1 and
restore RED tests over a finished implementation.

### L3 / L4 — two titles that assert less than they claim

Both are cross-covered, which is why they are low rather than medium.

* `mint-admin.test.ts:528-547` — `expect(auditCall?.values).toContain(result.userId)`
  cannot distinguish `actor_user_id` from `entity_id`, both of which are bound to
  `userId` (`mint-admin.ts:644,647`). Mutant `actorUserId: authId` survives this
  test. The live suite closes it: `mint-admin.integration.test.ts:151-156`
  selects `WHERE actor_user_id = ${result.userId}` and asserts length 1.
* `mint-admin.integration.test.ts:159-201` — the intercepting `begin` runs
  `callback(tx)` to completion (so the real `writeAdminAuditLog` **succeeds**)
  and then appends its own `INSERT INTO admin_audit_log … 'forced_failure'` with
  an unsatisfiable FK. The rollback proven is "any class-23 failure inside the tx
  removes the users row", which is the invariant — but not the titled cause. The
  "one transaction" half is pinned instead by the unit assertion
  `expect(auditCall?.inTransaction).toBe(true)` (`mint-admin.test.ts:544`), which
  a mutant moving `writeAdminAuditLog` outside `sql.begin` would fail.

## Checks that PASSED

Recorded so a later reader does not re-derive them.

**All 30 `tests_to_add` titles exist verbatim** — 27 in
`scripts/ci/__tests__/mint-admin.test.ts`, 3 in the `.integration.test.ts`
sibling, plus one non-intake positive case (`accepts a staging target whose
parsed refs both equal the confirmation`). 28 unit + 3 live = 31, matching the
arch-log entry's count. Every title's body was read; only the two in L3/L4 assert
less than the title claims.

**`confirmsRollback` (`:363-370`)** — the class set is right and the
classification keys on the error that ESCAPED the awaited `sql.begin`
(`:651` catches the rejection of the `await sql.begin(...)` at `:610`, and
`refusal` is derived from that same escaped error at `:453`), exactly as plan §2
requires. `/^(22|23|42)\d{3}$/` cannot match a postgres.js client error, whose
codes are non-numeric (`CONNECTION_CLOSED`, `ECONNRESET`). Nothing is wrongly
included. Class `40` (`40001` serialization_failure, `40P01` deadlock_detected)
is omitted although Postgres definitively aborts those — the effect is a
preserved-but-orphaned Auth identity, i.e. the same safe direction the plan chose
deliberately, so this is a conscious conservatism, not a defect (appendix A1).

**`assertMintTarget` (`:235-276`)** — no input reaches a mint against an
unnamed project. Order is denylist (over *both* actual targets and the
confirmation) → full-ref shape → exact equality against the ref parsed from the
Supabase host → exact equality against the ref parsed from the database
descriptor. Real-world shapes exercised by hand against the regexes:
`postgres@db.<ref>.supabase.co:5432` → `refFromDatabaseTarget` host arm matches;
`postgres.<ref>@aws-0-eu-west-2.pooler.supabase.com:6543` → user arm matches;
IPv6 (`user@[::1]:5432`) → both arms miss → `null` → refusal;
no port (`user@host:(no-port)`) → parses normally; unparseable URL → thrown by
`describeConnectionTarget` (`scripts/staging-guard.ts:141-151`) before
`assertMintTarget` is reached, i.e. still before any write. `refFromSupabaseUrl`
takes the first host label and requires `/^[a-z0-9]{20}$/`, so a custom domain is
a refusal rather than a pass.

**Reconciliation table** — plan §2 has **five** outcome rows (plan lines
104-108), not six as the review brief states. All five are realised, in the
plan's own order, at `mint-admin.ts:456-506`: read fails → `failed` + orphan;
`id` EQUALS → `committed`, no delete, falls through to `generateLink`; `id`
DIFFERS → `refused`/`failed`, never deleted; no row + ambiguous → `failed` +
orphan preserved; no row + confirmed → `deleteOrphanAuthUser` then
`refused`/`failed`. There is no `MintRefusal` special case ahead of the read
(plan §6 G2′), and no input reaches a sixth branch — the switch is total over
`{read threw} × {row absent, row=ours, row=other} × {confirmed, ambiguous}`.

**`buildAdminRecoveryUrl` (`:290-297`)** — the produced URL satisfies both
consumers. `type=recovery` is in `VALID_EMAIL_OTP_TYPES`
(`src/app/api/auth/callback/route.ts:46-53`); `flow=admin` passes `isAuthFlow`
so a failure lands on `/admin/login` (`auth-flow.ts:5,12`); and for `role='admin'`
`resolveCallbackDestination` returns
`{ kind: 'redirect', destination: '/admin/reset-password' }` via the explicit
reset-path allowlist at `auth-flow.ts:66-71`, ahead of the role-home fallback.
`next` comes from `resetPasswordPathForFlow('admin')`, not a literal.

**Non-goals** — the diff is nine files
(`git diff --stat b2317283..8c4108b4`) and touches none of impersonation, the
dual-mode admin gate, `src/proxy.ts`, CORS, `supabase/migrations/`, or any
feature flag. No new env var (the four read at `:171-174` all pre-exist). No
`package.json` script alias. No new top-level directory.

**`allowed_edit_surface`** — every changed path is listed:
`scripts/mint-admin.ts`, both suites, `docs/runbooks/mint-admin.md`,
`.claude/reference/arch-review-log.md`, and four files under
`docs/superpowers/plans/**`. Deviation D3 (the arch-log amendment) is accurately
described: `scripts/ci/merge-ledger-audit.ts` triggers GOVERNANCE on a
`scripts/ci/` prefix with no test-file exclusion.

**Invariants** — #8 (`auth_id` link, service key script-only), #10
(`randomUUID` from `node:crypto`, `:36`), #12/#15 (composition root; the domain
helpers take `sql`/`tx`; `writeAdminAuditLog` receives `tx`), the
single-transaction rule (`:610-650`), the self-actor rule (`actorUserId: userId`
after the `users` INSERT in the same `tx`), and the unweakened prod denylist
(`PROD_PROJECT_REFS` imported, not re-spelled). No raw
`INSERT INTO admin_audit_log` in production code — the only one is the
deliberate failure injector in the live suite.

**Cited line numbers re-resolved at HEAD** — `src/lib/admin/shell-context.ts:103`
(the `auth_id`+`role='admin'` SELECT) ✓; `signup-test-runbook.md:25` (the
hand-process step) ✓; `admin-onboarding-service.ts:231` (the "must NEVER stay
NULL" warning) ✓; `002_prompt2_fixes.sql:31` (`ALTER TABLE users ALTER COLUMN id
DROP DEFAULT`) ✓; `src/lib/audit/log.ts` `writeAdminAuditLog` signature ✓.

**Runbook consistency** — `docs/runbooks/mint-admin.md` never states an exit
code, so nothing in it contradicts `0/2/3/4`. Its `MINTED:` sample, its
`WARNING: auth.users is not readable` line, its `REFUSED (…)` table and its
`FAILED: … Orphaned Supabase Auth identity:` block all match
`formatMintReport` (`:697-746`) string for string. Its § "Reconciling an
uncertain run" matches the conditional-compensation rule.

---

## Appendix — low-confidence observations (NOT findings)

**A1. `confirmsRollback` omits class 40.** `40001`/`40P01` are definitive
server-side aborts, so including them would let the script clean up an orphan
after a deadlock. Omitting them costs an orphan Auth identity the runbook clears
in one command. Deliberate per plan §2; noted only so a future reader knows it
was considered.

**A2. Exit code for a target-guard refusal is 4, not 3.** `assertMintTarget`
throws a plain `Error`, which `onError` maps to `EXIT_FAILED` (`:807-808`),
while `REFUSED (…)` maps to `EXIT_REFUSED` (`:791`). The runbook's "Refusals"
table (`mint-admin.md:105-112`) groups both kinds of output under one heading, so
automation that keys on exit 3 would classify a mis-targeted run as a failure.
No contract field states an exit code, so this is not a violation — but a
`MintRefusal`-shaped target error would read more consistently.

**A3. Plan §3's signature comment is narrower than the behaviour.**
`export function confirmsRollback(error: unknown): boolean; // SQLSTATE class 22/23/42 only`
omits the `MintRefusal` arm that plan §2 prose and the implementation both carry
(`:366`). Prose wins; the inline comment is the stale half.

**A4. Deviation D1 and plan §2 (c′) cite `scripts/ci/test-db-bootstrap.sql:57-60`
for "creates schema `auth` with `auth.uid()` and no `auth.users`".** At HEAD the
`CREATE SCHEMA IF NOT EXISTS auth` is line 56 and the function body runs 57-58,
so the cited range excludes the schema statement it names. The substantive claim
is correct — `auth.users` is genuinely absent.

**A5. `refFromSupabaseUrl` validates ref *shape*, not domain.** A URL like
`https://<20-char-ref>.evil.example` would satisfy the guard if the operator's
environment supplied it. The guard's job is agreement between two operator-owned
values, so this is outside its remit; a `.supabase.co` suffix check would be
belt-and-braces.

**A6. `reconcileAfterTransaction` destructures `context.email` nowhere.**
`:452` takes `{ authId, userId, error }` while `MintAdminInput`-shaped callers
pass `email` too (`:652-657`). Harmless; a lint-level tidy.

**A7. `docs/reviews/feat-1178-mint-admin/blast-radius.md` is untracked at HEAD.**
It exists in the working tree but is not in the commit, so it ships with no
review artifact. `docs/reviews/**` is inside `allowed_edit_surface`, so
committing it is permitted if the run wants it durable.
