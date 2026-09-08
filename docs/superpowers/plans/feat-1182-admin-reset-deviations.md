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
