# Post-sweep handoff — 2026-07-27

Supersedes `2026-07-26-debt-sweep-handoff.md`, whose §5 (#568) is now built and
merged. Written at `main` = `34715981` (before PR #594 lands).

---

## 1. What closed

The five-issue debt sweep is **complete**, and the architecture review's owner decision (#587) is decided and shipped. All merged to `main`, `staging`
fast-forwarded in lockstep.

| Issue | PR | What landed |
|---|---|---|
| #565 | #583 | Single-owner extractions + executor decomposition (closed #569) |
| #573 | #585 | Run-time migration DDL removed from live-DB suites; `ci:live-db-suites` added |
| #567 | #586 | Single-replica guard — `railway-replicas` CI rule + boot replica identity |
| #568 | #588 | `job_outbox` in-flight status vocabulary + `ci:outbox-status` |
| #572 | #589 | One owner for the primary tracked keyword; unread digest rating dropped |

| #587 | #596 | Replica-cardinality alerting — pages when >1 worker replica is live |

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
5. **A `try/catch` that could not catch the failure it guarded** (#587, caught in
   review before merge) — the replica check was wrapped in a log-and-swallow
   `try/catch` and described as fail-safe, but sat OUTSIDE `withTimeout`. The
   poller is single-flight, so a Redis command that *hangs* rather than throws
   would have left `isPolling` true forever, killing the probe and its dead-man
   switch. A `catch` only catches throws.

**Operational rule for the next agent:** "the audit passed locally" is not
evidence that a gate enforces it. Verify the wiring (`ci.yml`, `lefthook.yml`)
separately from the behaviour, and verify a guard is load-bearing by BREAKING it
and watching the failure appear — remove the suppression, restore the buggy
constants, unwire the list. Every instance above was invisible to a green run and
visible within seconds of a deliberate break.

Instance 5 generalises the rule beyond CI: ask what failure mode the guard
actually intercepts. A `catch` does not cover a hang; a timeout does not cover a
wrong value; a test that never runs covers nothing.

---

## 3. Open issues, in the order I'd take them

*(#587 is closed — the decision was alert-on-cardinality, shipped in #596. The
reasoning is in that PR and in `replica-cardinality.ts`'s header: a boot-gating
lease would have put Upstash, a documented SPOF, on the worker's startup path,
and it is architecture you must remove once the P2 list clears.)*

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
- **`worker/background/pollers/health-alert/replica-cardinality.ts`** (#587) —
  each replica registers in Redis under a TTL every `HealthAlertPoller` cycle;
  the poller pages when >1 is live. `scale_out` (shared `deployment_id`) pages
  immediately; `deploy_overlap_stuck` (different ids) waits out a grace window so
  normal deploys do not page. **The TTL and the grace window are load-bearing on
  each other** — `DEPLOY_OVERLAP_GRACE_CYCLES > TTL_INTERVAL_MULTIPLE + 1`,
  asserted in tests, because the first cut got the ratio wrong and would have
  paged on every clean deploy.
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
- **A poller's first cycle runs immediately.** `startHealthAlertPoller` polls once
  before setting the interval, so a counter reaches cycle N at `(N-1) × interval`,
  not `N × interval`. Getting this wrong is what made #587's first cut false-page.
- **Best-effort work in a single-flight poller needs a timeout, not just a catch.**
  `isPolling` never resets if the work hangs.

---

## 6. State

`main` = `92f000e9`, `staging` fast-forwarded to match. Migrations head **089** —
this sweep added none. All autonomy flags remain OFF in prod. Arch review counter is at 0 (reset by #594).
