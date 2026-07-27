# Post-sweep handoff — 2026-07-27

Supersedes `2026-07-26-debt-sweep-handoff.md`, whose §5 (#568) is now built and
merged. Written at `main` = `34715981` (before PR #594 lands).

---

## 1. What closed

The five-issue debt sweep is **complete**. All merged to `main`, `staging`
fast-forwarded in lockstep.

| Issue | PR | What landed |
|---|---|---|
| #565 | #583 | Single-owner extractions + executor decomposition (closed #569) |
| #573 | #585 | Run-time migration DDL removed from live-DB suites; `ci:live-db-suites` added |
| #567 | #586 | Single-replica guard — `railway-replicas` CI rule + boot replica identity |
| #568 | #588 | `job_outbox` in-flight status vocabulary + `ci:outbox-status` |
| #572 | #589 | One owner for the primary tracked keyword; unread digest rating dropped |

Also merged: #584 (lab-notes promotions, arch counter → 5).

An architecture review followed (PR #594: log row + counter reset 5 → 0).

---

## 2. Read this before trusting any "the audit runs" claim

The review's central finding is that **this repo has repeatedly shipped checks
that look like they run but exercise nothing.** Four instances now:

1. **`ci:live-db-suites` is in no gate** (#590) — present in `package.json`,
   absent from `ci.yml` *and* `lefthook.yml`. It executes only via
   `scripts/verify-gate.sh:60`. CLAUDE.md nevertheless says "the `lint` CI job
   runs them all" and "CI-enforced: `ci:live-db-suites`". Both false.
2. **`ci:fallow` vs `ci:fallow:coverage`** — different scripts. Only the
   coverage variant gates PRs; the local audit sweep runs the other one.
3. **Three `fallow-ignore-next-line` pragmas were inert** — written with the
   rationale *between* the pragma and the function. Local runs reported clean.
4. **`pnpm test:integration` hard-gates one suite only** — already in lab notes;
   an existing-but-unrun suite is how #520 shipped.

**Operational rule for the next agent:** "the audit passed locally" is not
evidence that a gate enforces it. Verify the wiring (`ci.yml`, `lefthook.yml`)
separately from the behaviour, and verify a suppression is load-bearing by
removing it and watching the finding reappear.

---

## 3. Open issues, in the order I'd take them

### #591 — HIGH, and it is a defect in freshly merged code
`worker/jobs/__tests__/{RankingTrackingWorker,WeeklySummaryWorker}.test.ts` each
hand-roll an eager `sql` mock with
`isFragmentBuild = s[0].includes('jsonb_array_elements')` — keyed on one
builder's SQL body, so `publisherSubscriptionEligibleSql` would be
mis-handled silently.

The justification written into those comments — "`vi.hoisted` runs before
imports, so a shared helper is not reachable" — **is false.**
`worker/__tests__/helpers/mock-sql.ts` exists, is imported by **100 files**,
documents the `await vi.hoisted(async () => { await import(...) })` form in its
own header, and already models fragments correctly (`__mockSqlFragment`, nested
fragments flattened into parent text). Replace both hand-rolls with it.

Failure mode if left: rewrite a builder's SQL, the sniff misses, the queue
mis-shifts, both suites stay green.

### #590 — HIGH, ~30 lines, technique already exists
Nothing forces `package.json`, `ci.yml`, and `lefthook.yml` to agree on the
`ci:*` set. `verify-gate.sh:57-60` already derives it from `package.json` with
`jq` — do the same as an audit (or generate the two lists). Fixing this also
makes the CLAUDE.md sentence true rather than aspirational.

### #587 — needs an OWNER DECISION before anyone builds
Alert-on-cardinality (cheap; uses the existing `HealthAlertPoller`/Sentry path)
vs. a boot-gating distributed lease (puts Upstash — already a documented SPOF —
on the worker's boot critical path). Review confirmed the detect-not-enforce
posture is correct: Railway exposes no replica count, so no process can assert
it is alone. The residue #587 names is that **nothing acts on the signal**.

### #592 — LOW
`scripts/ci/lib/sql-tag-scan.ts:17` scans `{sql, tx, db}` but not `exec`, which
the fragment builders use. No violation today — an expired precondition.
Cheapest fix is renaming `exec` → `db` in the two builders.

### #593 — LOW
`solicitation_asks.evidence` discriminant is enforced by a throw at
`src/lib/solicitation/batch-view.ts:94`; migration 088:155 has no CHECK. One
malformed row fails the whole Requests view.

### Older, unchanged
#582 (csv_ingest lock — `purge-stages.ts:256` still deletes unlocked), #581
(fallow CRAP inflated repo-wide), #563, #555, #504, #503, #494.

---

## 4. New machinery this sweep added

- **`src/lib/shared/job-outbox-status.ts`** — `OUTBOX_IN_FLIGHT_STATUSES`.
  The set is a **byte-for-byte contract**: a bind parameter inside
  `ON CONFLICT … WHERE` defeats partial-index inference, so all ~26 SQL sites
  stay hand-spelled and `ci:outbox-status` checks members **and order**.
  Escapes: per-line `outbox-status-audit-ignore`; migrations 004 and 065
  allowlisted in the audit with a reason each.
- **`src/lib/shared/primary-tracked-keyword-sql.ts`** — sole owner of "which
  tracked keyword is primary", shared by the digest lane, rival picker, the pick
  UPDATE, and `RankingTrackingWorker`. SQL rather than TS because every reader
  needs it resolved *inside* its statement. `RankingTrackingWorker`'s JSONB parse
  was deleted, dropping CLAUDE.md's JSONB allowlist from 17 → 16 sites.
- **`worker/config/replica-identity.ts`** + `railway-replicas` static-policy rule.
  The rule parses `railway.json` structurally and token-scans TOML; an earlier
  line-anchored regex let compact JSON, dotted TOML keys, and inline tables through.

---

## 5. Gotchas earned this session

- **Interpolating a SQL fragment builder calls `sql`.** Queue-style mocks that
  treat every `sql` call as a query will mis-shift. Use
  `worker/__tests__/helpers/mock-sql.ts` (see #591).
- **`fallow-ignore-next-line` means the NEXT line.** Rationale goes *above* the
  pragma, function immediately below. Precedent: `burst-drill-load.ts:126`,
  `useSettingsForm.ts:42`.
- **`ci:tenant-scope` keys on exact SQL snippets.** Any query edit needs the
  allowlist regenerated; `NAMED_RIVAL_LANE_SQL` is shared by two entries.
- **`git checkout staging` fails** — `staging` lives in the worktree at
  `../RepWorth-worktrees/staging-ride`. Fast-forward with `git -C <worktree>`.
- **Pushing `staging` auto-deploys** the full staging stack (Railway + Vercel).

---

## 6. State

`main` = `34715981`, `staging` fast-forwarded to match. Migrations head **089** —
this sweep added none. All autonomy flags remain OFF in prod. Arch review counter
resets to 0 when #594 lands.
