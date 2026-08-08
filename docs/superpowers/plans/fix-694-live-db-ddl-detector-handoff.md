# Handoff — fix-694-live-db-ddl-detector

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-694-live-db-ddl-detector`
**Ticket:** #694 — `ci:live-db-suites` R2 DDL detector keys on an incidental marker
**Lane:** RISK = normal · SURFACE = backend · db_touching = true

## Artifacts (read these, not this file's summary)

| What | Path |
|---|---|
| Intake contract | `docs/superpowers/plans/fix-694-live-db-ddl-detector-intake.json` (+ arming copy `.feature/intake.json`) |
| Plan (7 tickets) | `docs/superpowers/plans/2026-08-08-live-db-ddl-detector.md` |
| Deviations | `docs/superpowers/plans/fix-694-live-db-ddl-detector-deviations.md` |
| Reviews | `docs/reviews/fix-694-live-db-ddl-detector/` |
| Phase record | `.feature/state.json` |

## State

- Phase: `reviewed`, gate GREEN at `05f8a93f` (`--review`: 30 rows incl. `diff-coverage`).
- All 7 plan tasks complete. Branch review **rounds 2 of 3 used**; surface amendments **0 of 2**.
- Round 1: 13 findings, 12 accepted + fixed (`415c7d1c`, `1301455f`), 1 rejected (S5, upheld by the round-2 reviewer). Round 2: all round-1 findings VERIFIED with mutation-proofs; 3 fix-introduced defects, all false comments, fixed in `05f8a93f`.
- Triage record: `docs/reviews/fix-694-live-db-ddl-detector/round-1-triage.md`; round-2 detail in deviations **D7**.
- Next: step 8 normal lane — PR to `main`, merge on green CI. No staging ride (no worker/schema/billing/auth change; nothing deploys).

## Known bound, deliberately not closed here

`listTestFiles()` globs `*.test.ts`/`*.test.tsx`, so the ten `__tests__/helpers/*.ts`
modules are never scanned: a helper exporting `` sql`ALTER TABLE …` `` that a suite
interpolates as `` sql`${frag}` `` audits clean. Found in round 2 (R1). Widening the
glob is a behaviour change — helper files do not match `*.integration.test.ts` and
would trip R1's naming rule — so it is a follow-up ticket, not a round-2 patch.
The detector's own header names this bound.

## The three things a resumed session must not re-derive

1. **No tag-name allowlist.** A census of the live-DB suites — **80 marker-passing, 78 audit-visible** after `NOT_LIVE_DB` (those 2 files hold zero templates, so template counts are definition-independent): `sql()` is the plurality at ~770 of ~1470 tagged templates, and its tag is a `CallExpression`, so `SQL_TAG_NAMES` (`sql`/`tx`/`db`/`exec`) sees ~530 and misses more than it catches. All 21 distinct tag forms are DB handles; no `it.each` table in any of them. Hence presume-all. `scripts/ci/lib/sql-tag-scan.ts` is imported for `lineHasPragma` and **not modified** — the four SQL vocabulary audits keep byte-identical scope. **Treat every figure as a point-in-time census, not a constant**: an exact count went stale twice inside this feature's own review (S8, then R2), because it drifts by one whenever a template is added or moves.

2. **Seven real DDL sites, four classes.** Fix: `import-offer/route` (temp CHECK constraint → shared abort injection), `NotificationFailoverPoller` + `health-alert/checks` (bootstrap ALTER → assert migration 083). Exempt by file allowlist: `outreach-render` + `migration-091` (`auth.uid()` probe, rolled back, both already hold `acquireLiveDbLock`; 091 was on NO allowlist, so its lock was never checked). Exempt by pragma: `migration-080` ×3 (pg_temp, `ON COMMIT DROP`). Already correct: 076/077/078/088.

3. **Fail-closed costs nothing today.** All 13 opaque `.unsafe(readMigration0NNSql())` calls are inside already-allowlisted suites (074/076/077/078/088). DCL is deliberately out of the verb set: every executed `GRANT` is in the two probe suites, and 076's `REVOKE` is a non-executed string constant.

## Verification

Gate: `bash scripts/verify-gate.sh` (`--review` for the last run before step 7). `db_touching` is true, so it provisions the test DB serially before the parallel rows. `TEST_DATABASE_POOL_URL` must be set or the integration rows SKIP loudly and the gate is not review-ready.

Sharpest single check that the detector works: `pnpm ci:live-db-suites` must name exactly the four expected files after T1 and nothing else — any additional file is a precision defect, not a site to pragma.
