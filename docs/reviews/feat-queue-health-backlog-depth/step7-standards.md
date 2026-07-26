# Step 7 — Standards & Maintainability Review

Branch: `feat-queue-health-backlog-depth` (ticket #480)
Scope: `git diff main...HEAD`, product code only.
Discipline: `thermo-nuclear-code-quality-review` skill applied against `.claude/rules/{repworth,design,engineering,production}.md` + `CONTEXT.md`.
Mode: read-only. No code edited.

## Verdict

The feature is small, well-decomposed, and largely exemplary for this codebase. The single-owner requirement is genuinely met (both consumers call `queryBacklogDepth`; the count SQL exists in exactly one place), the module is side-effect-free and takes `sql` as a parameter (invariant #15), the glossary term "Backlog depth" is used verbatim in code (`queryBacklogDepth`, `BacklogDepth`, `backlog_depth:<table>`), and the DB op is correctly bounded with `SET LOCAL statement_timeout` inside a transaction (the right fix under PgBouncer transaction pooling).

One genuine, high-confidence maintainability defect: a stale, now-contradictory comment introduced by the branch's own later commit. Everything else is low-severity / appendix.

---

## HIGH-confidence findings (>=80%)

### H1 — Stale, self-contradicting comment about the server-side count bound
`worker/internal/queue-health.ts:99-100`

```
// The timeout bounds the WAIT, not the query — a timed-out count detaches
// and stays bounded by the 30s server-side statement_timeout.
```

This comment was written in commit `baf3f5fa` (T3) and never updated when the adversarial-review commit `e5221006` added `SET LOCAL statement_timeout = 4000` to `queryBacklogDepth`. After that fix, a detached/timed-out count is bounded server-side at **4s** (`BACKLOG_QUERY_STATEMENT_TIMEOUT_MS`, inside its own transaction), **not 30s**. The comment now directly contradicts the module it describes — `src/lib/shared/backlog-depth.ts:8-14` exists precisely to *replace* reliance on the 30s ceiling ("would leave the count running server-side (up to the 30s statement_timeout) ... Bounding the DB op prevents ..."). A reader trusting the endpoint comment would believe a slow count can hold a pooled connection for 30s — the exact failure mode the branch fixed.

Standard: design.md ("comments current and non-duplicative"), engineering.md ("communicate intent through comments... contracts or non-obvious behavior"). A comment that misstates the invariant it guards is worse than none.

Severity: **low** (misleading comment, no runtime behavior change). Fix: reword to reference the module's 4s `SET LOCAL` bound (e.g. "a timed-out count is cancelled server-side by the module's own `SET LOCAL statement_timeout` (~4s), freeing the pooled connection").

---

## Low-confidence / structural appendix (<80% — not blockers)

### A1 — Asymmetric failure isolation in `runHealthChecks`
`worker/background/pollers/health-alert/checks.ts:183-193`

Only `checkBacklogDepth` is wrapped in `.catch(... -> [warning finding])`; the other five checks retain shared-fate inside `Promise.all`. The inline comment justifies this (the backlog check reads the DB exactly when the DB is stressed, and its rejection must not suppress the critical failed-publish / zero-delivery findings) and explicitly scopes the other five out. Defensible and documented.

The cleaner "code-judo" reframe: give *every* check uniform per-check isolation (map each check through a shared `isolate(check)` wrapper that degrades to a `health_check_error:<key>` warning). That deletes the asymmetry a future reader must explain, and removes the shared-fate footgun for the other five checks too — but it widens scope beyond this ticket, so leaving it is reasonable. Flagging as a follow-up, not a change request.

### A2 — Two independent 4000ms constants
`BACKLOG_QUERY_STATEMENT_TIMEOUT_MS` (backlog-depth.ts) and `BACKLOG_ENDPOINT_TIMEOUT_MS` (queue-health.ts) are both 4000 but separately owned. They are genuinely different layers (DB statement cancellation vs. endpoint wait bound, the latter also guarding pool-acquisition/`BEGIN` latency), so this is *not* a single-owner violation — but the numeric coincidence invites a future edit to one and not the other. A one-line note that the endpoint wait is intentionally >= the module's statement bound would remove the ambiguity. Low value.

### A3 — Endpoint response key `backlog` vs. glossary term "Backlog depth"
`worker/internal/queue-health.ts` returns `{ queues, backlog }`, while the alert key is `backlog_depth:<table>` and the glossary/domain term is "Backlog depth". The abbreviation is explicitly documented in `env-vars.md` ("surfaced ... as the `backlog` key"), so it is intentional, not a silent rename — but the same concept now has two surface names across its two consumers. Minor consistency nit; documented, so not a glossary violation.

### A4 — `as Promise<BacklogDepth>` cast on `sql.begin(...)`
`src/lib/shared/backlog-depth.ts:44`. postgres.js types `begin`'s return loosely (`UnwrapPromiseArray`), so a cast is the pragmatic norm here; the callback already returns a concrete `{job_outbox, analytics_events}` and `BacklogDepth = Record<BacklogTable, number>` forces both keys, so adding a table to `BACKLOG_DEPTH_TABLES` breaks compilation until the SQL/return literal is updated (decent coupling protection). Acceptable.

### A5 — Threshold interpolated twice in the alert title
`worker/background/pollers/health-alert/checks.ts:171` — the title contains `(> ${threshold})` and `${threshold}-row capacity target`. Slightly redundant prose; the structured `detail` already carries `threshold`. Cosmetic.

## Checks that PASSED (verified, no finding)
- **Single-owner count SQL**: confirmed — only `backlog-depth.ts` contains the `COUNT(*) ... status='pending'` SQL; both `worker/index.ts` and `checks.ts` route through `queryBacklogDepth`.
- **Referenced partial indexes exist**: `idx_jo_pending` (001_initial_schema.sql:320, `WHERE status = 'pending'`) and `idx_analytics_events_pending` (046_analytics_events.sql, `WHERE status = 'pending'`). Comment is accurate.
- **`'pending'` SQL literal**: matches the sibling convention throughout `checks.ts` (`'failed'`, `'dispatching'`, `'open'`); this is raw SQL, not a TS status enum, so repworth.md's "no string literals for status" (a TS-layer rule) does not apply.
- **Config validation**: `num()` rejects negatives and non-finite (`parsed >= 0`), so invalid/negative -> 1500, matching env-vars.md. `0` is intentionally allowed (alert-always), consistent with `failedThreshold`.
- **Invariant #15**: module imports no DB singleton; composition root (`worker/index.ts`) and the poller pass `sql` down.
- **Error handling / logging**: `.catch` paths degrade to `null` (endpoint) or a warning finding (poller) and log via `createWorkerLogger` + `toError`; only DB/timeout error messages are logged — no raw review/response text, tokens, or secrets.
- **repworth "Never do"**: no `any` (uses `unknown` + a justified single cast), no `${JSON.stringify}::jsonb`, no new top-level dir (lands in existing `src/lib/shared/`), no bare LLM alias, no npm/yarn lockfile.
- **Module depth**: `queryBacklogDepth(sql)` hides the transaction + `SET LOCAL` + coalesce behind a one-line contract — a deep-enough module, not a pass-through wrapper.
- **File sizes**: no file crosses (or approaches) the 1k-line boundary; the new module is 45 lines.
