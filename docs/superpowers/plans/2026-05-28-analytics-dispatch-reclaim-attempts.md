# AnalyticsDispatchPoller Stale-Reclaim Attempts Decrement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stale-row reclaim in `AnalyticsDispatchPoller` hand back the attempt it strands when a worker crashes mid-dispatch, so infra faults can't burn an event's retry budget.

**Architecture:** A single SQL change in the existing inline reclaim `UPDATE` at the top of `dispatchOnce`: add `attempts = GREATEST(attempts - 1, 0)` (decrement, floored — this bulk UPDATE has no per-row attempts guard) and a `last_error` diagnostic marker, mirroring the proven `markDispatchDeferred` philosophy. Backed by one regression test that asserts the reclaim SQL carries both.

**Tech Stack:** TypeScript, Postgres.js (`sql` tagged template), Vitest. Worktree: `fix/89-analytics-reclaim-attempts` at `/Users/norbertesekiel/Developer/startups/RepWorth-issue89` (sibling dir — local lint/test are not poisoned).

**Spec:** `docs/superpowers/specs/2026-05-28-analytics-dispatch-reclaim-attempts-design.md`

---

## File Structure

- **Modify** `worker/background/pollers/AnalyticsDispatchPoller.ts`
  - Add module constant `RECLAIMED_STALE_DISPATCH_ERROR`.
  - Edit the stale-reclaim `UPDATE` (currently lines 94–102) to decrement attempts + set the marker, with a "why" comment.
- **Modify** `worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts`
  - Add one regression test next to the existing `'runs stale dispatching recovery before claiming rows'` test.

No schema migration (all columns already exist). No new files.

---

### Task 1: Regression test + reclaim fix (TDD)

**Files:**
- Test: `worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts` (add a test after line 138)
- Modify: `worker/background/pollers/AnalyticsDispatchPoller.ts` (constant near top; reclaim `UPDATE` at lines 94–102)

All commands run from the worktree root `/Users/norbertesekiel/Developer/startups/RepWorth-issue89`.

- [ ] **Step 1: Write the failing regression test**

In `worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts`, immediately after the closing `});` of the `'runs stale dispatching recovery before claiming rows'` test (line 138), add:

```ts
  it('hands the attempt back and stamps a marker when reclaiming a stale dispatch', async () => {
    mockSql
      .mockResolvedValueOnce([]) // stale-reclaim UPDATE (sql call 0)
      .mockResolvedValueOnce([]); // claim returns no rows (sql call 1)

    await runAnalyticsDispatchOnce();

    // Reclaim is sql call 0. A crash mid-dispatch already incremented attempts at
    // claim time; reclaiming is an infra fault, not the event's fault, so the
    // attempt must be returned (floored — bulk UPDATE has no per-row guard) and a
    // diagnostic marker recorded, mirroring markDispatchDeferred.
    expect(sqlText(0)).toContain('attempts = GREATEST(attempts - 1, 0)');
    expect(sqlValues(0)).toContain('reclaimed_stale_dispatch');
  });
```

Note: `sqlText(0)` joins only the static template chunks, so the literal `GREATEST(...)` appears there; the marker is a bound `${...}` param, so it appears in `sqlValues(0)`.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --dir /Users/norbertesekiel/Developer/startups/RepWorth-issue89 exec vitest run worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts -t 'hands the attempt back'
```
Expected: FAIL — `sqlText(0)` does not contain `attempts = GREATEST(attempts - 1, 0)` and `sqlValues(0)` does not contain `reclaimed_stale_dispatch` (the reclaim UPDATE has no such columns yet).

- [ ] **Step 3: Add the marker constant**

In `worker/background/pollers/AnalyticsDispatchPoller.ts`, immediately after the `AnalyticsEventRow` interface (after line 16, the closing `}` of the interface), add:

```ts

// Written to last_error when the stale-row reclaim hands a crashed-mid-dispatch row
// back to 'pending'. Lets a recovered crash be distinguished from a real PostHog error.
const RECLAIMED_STALE_DISPATCH_ERROR = 'reclaimed_stale_dispatch';
```

- [ ] **Step 4: Edit the stale-reclaim UPDATE**

In the same file, replace the existing reclaim block (currently lines 94–102):

```ts
  await sql`
    UPDATE analytics_events
    SET status = 'pending',
        locked_at = NULL,
        available_at = NOW()
    WHERE status = 'dispatching'
      AND locked_at IS NOT NULL
      AND locked_at < NOW() - INTERVAL '10 minutes'
  `;
```

with:

```ts
  // A worker that crashed between claim and mark leaves a row stranded in
  // 'dispatching' with the claim's attempt increment already applied. Reclaiming it
  // is an infra fault, not the event's fault, so hand the attempt back the same way
  // markDispatchDeferred does. GREATEST floors at 0 because this bulk UPDATE acts on
  // rows it did not claim and has no per-row `AND attempts = $n` guard.
  await sql`
    UPDATE analytics_events
    SET status = 'pending',
        locked_at = NULL,
        attempts = GREATEST(attempts - 1, 0),
        last_error = ${RECLAIMED_STALE_DISPATCH_ERROR},
        available_at = NOW()
    WHERE status = 'dispatching'
      AND locked_at IS NOT NULL
      AND locked_at < NOW() - INTERVAL '10 minutes'
  `;
```

- [ ] **Step 5: Run the new test to verify it passes**

Run:
```bash
pnpm --dir /Users/norbertesekiel/Developer/startups/RepWorth-issue89 exec vitest run worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts -t 'hands the attempt back'
```
Expected: PASS (1 test).

- [ ] **Step 6: Run the full suite to confirm no existing assertion broke**

Run:
```bash
pnpm --dir /Users/norbertesekiel/Developer/startups/RepWorth-issue89 exec vitest run worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts
```
Expected: PASS — 16 tests (15 prior + 1 new). In particular `'runs stale dispatching recovery before claiming rows'` still passes (its assertions on `status = 'pending'`, `WHERE status = 'dispatching'`, `locked_at IS NOT NULL`, and `INTERVAL '10 minutes'` are unaffected), and adding a bound param to sql call 0 does not shift the `sqlText(1)/sqlText(2)` call indices the other tests rely on.

- [ ] **Step 7: Lint + typecheck the change**

Run:
```bash
pnpm --dir /Users/norbertesekiel/Developer/startups/RepWorth-issue89 lint
pnpm --dir /Users/norbertesekiel/Developer/startups/RepWorth-issue89 typecheck
```
Expected: both pass with no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-issue89 && git add worker/background/pollers/AnalyticsDispatchPoller.ts worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts && git commit -m "fix(analytics): give back the attempt on stale-dispatch reclaim (#89)

Stale-row reclaim returned crashed-mid-dispatch rows to 'pending' without
decrementing the attempt incremented at claim time, so repeated infra crashes
could push a healthy event toward max_attempts/failed. Add
attempts = GREATEST(attempts - 1, 0) plus a reclaimed_stale_dispatch marker,
mirroring markDispatchDeferred's rule that infra faults don't burn the budget.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Full verification + audits + PR

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit/integration suite**

Run:
```bash
pnpm --dir /Users/norbertesekiel/Developer/startups/RepWorth-issue89 test
```
Expected: PASS (no regressions across the repo).

- [ ] **Step 2: Run DB-touching audits**

The change touches a SQL query, so run the tenant-scope and RLS audits per project rules:
```bash
pnpm --dir /Users/norbertesekiel/Developer/startups/RepWorth-issue89 ci:tenant-scope
pnpm --dir /Users/norbertesekiel/Developer/startups/RepWorth-issue89 ci:rls-audit
```
Expected: PASS with no **new** findings. The reclaim is a system-level (non-tenant-scoped) queue UPDATE that was already unscoped before this change; the edit only adds the `attempts` and `last_error` columns and does not move the query to a new file or add backtick-wrapped tags (both known audit-coverage traps). If either audit reports a new finding, stop and investigate before pushing.

- [ ] **Step 3: Push the branch**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-issue89 && git push -u origin fix/89-analytics-reclaim-attempts
```

- [ ] **Step 4: Open the PR against protected `main`**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-issue89 && gh pr create --repo RepWorth/ai-review-responder --base main --head fix/89-analytics-reclaim-attempts --title "fix(analytics): give back the attempt on stale-dispatch reclaim (#89)" --body "$(cat <<'EOF'
## Summary
Fixes #89. The `AnalyticsDispatchPoller` stale-row reclaim returned crashed-mid-dispatch rows to `pending` without decrementing the `attempts` value incremented at claim time. Over repeated crashes inside the 10-minute dispatch window, a healthy event could be pushed toward `max_attempts`/`failed` without PostHog ever being the cause.

## Change
- Reclaim UPDATE now sets `attempts = GREATEST(attempts - 1, 0)` and `last_error = 'reclaimed_stale_dispatch'`, mirroring `markDispatchDeferred`'s rule that infra faults must not consume the retry budget.
- `GREATEST(.., 0)` floors the decrement because the bulk reclaim has no per-row `AND attempts = $n` optimistic guard.
- `$insert_id` dedup at PostHog means a false-positive reclaim of a slow-but-alive worker still cannot double-deliver.

## Tests
- New regression test asserts the reclaim SQL carries the decrement and the marker.
- Full `AnalyticsDispatchPoller` suite green; tenant-scope and RLS audits show no new findings.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR created; the four CI checks (lint, typecheck, test, build) run. Wait for them green before merging (do not push directly to `main`).

---

## Notes for the implementer

- **Why not extract a helper?** The reclaim is a single inline bulk UPDATE; the repworth rules and `design.md` advise against single-caller extraction. The existing tests already exercise it through `runAnalyticsDispatchOnce`.
- **Why a constant for the marker?** One authoritative owner for the sentinel string; bound as a param to match the file's existing `last_error = ${message}` style.
- **Do not run lint/test from a worktree nested inside the main repo** (`.claude/worktrees/...`) — module resolution leaks into the parent and poisons results. This worktree is a sibling dir, so it is safe.
