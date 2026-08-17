# #651 verify-spec Audit — Round 1 (2026-08-17)

**Fixed merge base:** `a6e38fe9b1fbc14da340947319976615eccebe5b`  
**Audited:** uncommitted worktree after branch-review round 1  
**Verdict:** PASS — plan tracers 1–3 verified (22/22 items); three
non-blocking findings, all accepted and fixed in this PR (deviation D3).

## Suite

lint PASS · typecheck PASS · test PASS (913 files / 11,986 tests; live-DB
unsubscribe integration 20/20 with the local test DB) · audits PASS
(db-imports, directory-map, tenant-scope 392/392, rls-audit static+live,
static-policy, live-db-suites) · focused five suites 71/71 · gate fingerprint
current · branch diff applies cleanly onto `origin/main` (`dc55351f`) via
`git apply --check --3way`.

## Findings

### F1 — tenant-scope audit blind to `sqlUnsubscribe` tags

**LOW / latent · ACCEPT.** `DB_SERVER_SQL_TAG_SOURCE_NAMES` in
`scripts/ci/tenant-scope-audit.ts` was `{sql, sqlRead}`; a query written as
`sqlUnsubscribe\`…\`` would not have been scanned. No live call site uses that
form (production uses `sqlUnsubscribe.begin(tx => …)`). Fixed: set gains
`sqlUnsubscribe`; two regression tests, red-first against the old set.

### F2 — three docs still said the chokepoint wraps only `sql`/`sqlRead`

**INFO · ACCEPT.** `.claude/CLAUDE.md` gotcha (word count held at 60),
`.claude/reference/lab-notes.md` #773 entry, `docs/currents.md` #773 summary.
All now name `sqlUnsubscribe` and, in lab-notes, the tenant-scope tag-set rule.

### F3 — `sqlRead` JSDoc ambiguity in `server.ts`

**NIT · ACCEPT.** "dedicated clients from `createDedicatedPostgresClient` are
NOT gated" was true only for caller-owned poller clients; `sqlUnsubscribe` is
built by the same factory and IS gated. Comment now distinguishes module-owned
singletons (gated) from caller-owned poller clients (ungated).

## Not in this branch by design

- Staging drill (plan §"Post-review staging drill") — separate authorization;
  ADR 0009 addendum lists it as the release gate before production.
- Replay cache — intake non-goal.
