# feat/1182-admin-reset — deviations

Every entry is something the locked intake did not anticipate. Each carries a
resolved verdict (ACCEPT / RE-PLAN); the `reviewed` transition refuses without one.

## D1 — the developer's staging admin already exists, so it is restored, not minted

**Planned:** the orchestrator brief said to MINT `yoknyei@repworth.net` fresh with
`scripts/mint-admin.ts --env staging`.
**Found:** the read-only roster shows `yoknyei@repworth.net` already holds a staging
admin row (`users.id 01a0685d-9739-743b-aa69-c8888b455cfc`, created 2026-09-03,
one verified MFA factor, last sign-in 2026-09-04). `mintAdmin`'s first read-only
pre-check refuses that email with `REFUSED (users_row_exists)` and exit code 3
before any Auth call, so minting is not merely redundant — it is impossible.
**Did:** treated it exactly like the owner's account — revoke, then `--restore`.
Nothing is minted on staging in this run. Recorded in the roster doc § Findings.
**Verdict:** ACCEPT — the intake's goal (two working admins before Gate B) is met
by the reversal path the script already owed, and no new capability was needed.

## D2 — the audit sink is `admin_audit_log`, not `account_audit_log`

**Planned:** the ticket comment and the orchestrator handoff both say the revoke
writes "an `account_audit_log` entry via `writeAccountAuditLog`".
**Found:** impossible for an admin. `account_audit_log.account_id` is NOT NULL
(migration 034) and an admin's `account_id` is NULL (invariant #9). Migration 117's
header says so in as many words: that table's constraint is the entire reason
`admin_audit_log` exists. Relaxing 034 was explicitly rejected there.
**Did:** wrote `admin_revoked` / `admin_restored` through `writeAdminAuditLog`,
following the `admin_minted` self-actor precedent `scripts/mint-admin.ts` set.
**Verdict:** ACCEPT — the schema forces the choice and the intake already named
`writeAdminAuditLog` as the writer. Reported to the owner so the ticket wording is
corrected rather than silently diverged from.

## D3 — two helpers exported from `scripts/mint-admin.ts` (surface amendment #1)

**Planned:** the surface was `scripts/revoke-admin.ts` + its two suites + docs.
**Found:** the revoke CLI needs the same argument parser (`flagValue`, whose
`--email --dry-run` trap is a FIXED review finding — #1178 S3 / red team RT2-01)
and the same operator-provenance shape (`describeOperator`). Re-typing either is
how a fixed trap comes back and how one payload vocabulary becomes two.
**Did:** added `export` to those two functions in `scripts/mint-admin.ts` — no
behaviour change, no signature change — and amended the surface to include that
file. Counted mechanically: `surfaceAmendments=1`.
**Verdict:** ACCEPT — auto-approved band (≤2 files inside a tree the surface
already covers), and it keeps one owner per shared fact.

## D4 — three live-DB test titles lost their "(live DB)" suffix

**Planned:** the intake spelled three titles with a trailing "(live DB)" marker.
**Found:** the gate's promised-tests row matches titles VERBATIM, and the marker
does not belong in a test name.
**Did:** dropped the suffix from the intake's `tests_to_add`; the titles are
otherwise unchanged and all three live in the `.integration.test.ts` sibling.
**Verdict:** ACCEPT — a `tests_to_add` retitle, which the pipeline classifies as a
deviations entry rather than a surface amendment.

## D5 — one test title lost its leading `--`

**Planned:** the intake promised `"--dry-run runs every refusal check and writes
nothing to Postgres or Supabase Auth"`.
**Found:** the gate's promised-tests row matches with `grep -rqF "$TITLE"`, and a
pattern beginning with `--` is parsed by grep as an OPTION, so that title could
never be found however it was written. The gate reported it missing while the
test existed and passed.
**Did:** retitled to `"a --dry-run runs …"` in the test and both intake copies.
The gate's matcher is the defect (it wants `grep -rqF -e "$TITLE"`), but
`scripts/verify-gate.sh` is outside this branch's surface; reported to the owner
as a follow-up rather than patched here.
**Verdict:** ACCEPT — a `tests_to_add` retitle, which the pipeline classifies as
a deviations entry, not a surface amendment.

## D6 — the line estimates were roughly half the real diff

**Planned:** `estimated_prod_lines` 320, `estimated_test_lines` 420.
**Found:** the reclassify row fired at 657 production lines. The script carries
its reasoning in-file the way `mint-admin.ts` does, and `docs/runbooks/` counts
as production in that bucket.
**Did:** re-ran step 0 with the real numbers (700 / 620). **The classification
itself did not move** — SMALL, RISK = high, backend, one new script plus its two
suites and a runbook section. Only the estimates were wrong.
**Verdict:** ACCEPT — an estimate correction, and the same shape #1178 recorded
(982 actual against 300 estimated).

## D7 — the review wave found a P0 and four P1s; all fixed in one round

**Planned:** the wave was expected to confirm the change.
**Found:** it disproved "done".
- **RT-01 (P0)** — `REVOKE_BAN_DURATION`'s VALUE was pinned by nothing:
  `expect(banDurationFor('revoke')).toBe(REVOKE_BAN_DURATION)` is a tautology
  (both sides the same import). Setting the constant to `'none'` made `--revoke`
  send GoTrue the documented UNBAN verb while the report still printed "the
  Supabase Auth identity is banned", and it passed all 30 tests. The restore side
  was pinned one line below; the revoke side was not.
- **RT-02/RT-03 + spec P1** — the ban-state predicate lived inside the SQL
  string, where no test could reach it (the unit suite mocks `sql`; the live DB
  has no `auth.users`), and it collapsed "no `auth.users` row" into "not banned".
  On `--restore` that returned `ALREADY ACTIVE` with **exit 0** for an identity
  that cannot sign in — and step 4 of the production plan is a `--restore` of the
  ONLY production admin.
- **RT-04** — deleting the `assertMintTarget` call from `main()` was invisible to
  the whole suite. `buildRevokeGuardInput` had pinned the guard's INPUT, moving
  the seam one line outward instead of closing it.
- **RT-05** — the `audit_failed` recovery was not executable: it asked for a
  hand-written `admin_audit_log` row without SQL, and that table's `id` has no
  default, so the obvious INSERT fails.

**Did:**
- pinned the literals (`expect(REVOKE_BAN_DURATION).toBe('876000h')`);
- moved the decision out of SQL into a pure, injected-clock `classifyBanState`,
  so the predicate is unit-testable and the mutants are killable. `present` is
  now explicit and absence is a REFUSAL (`auth_identity_missing`), never a
  state; a soft-deleted identity refuses too (`auth_identity_deleted`);
- added `REVOKE_HORIZON_MS`, so a short pre-existing ban is re-applied rather
  than mistaken for this script's completed revoke;
- extracted `resolveRevokeTarget`, which asserts and then describes, with a test
  that fails when the guard call is removed;
- gave the runbook runnable recovery SQL and two new refusal rows;
- fixed the `RESTORED` line, which claimed the proxy enrols an unenrolled admin
  — ADR 0025 § Consequences says the form is lenient and does not prompt;
- bounded the Auth call (`AUTH_REQUEST_TIMEOUT_MS`, no retry — a re-run IS the
  retry, and it is idempotent);
- replaced the owner's REAL staging `users.id`/`auth_id` in the fixtures with
  synthetic UUIDs (RT-09), and killed the `lower(email)`, operator-provenance
  and swapped-`unchanged`-message mutants.

**Verified by re-running the mutations, not by reading the code:** all ten
mutants — the seven survivors plus three new seam mutants — now fail the suite.
42 unit + 5 live-DB tests.
**Verdict:** ACCEPT — no locked decision was invalidated. The revoke/restore
contract, the audit sink and the targeting controls are unchanged; what changed
is that they are now pinned.
