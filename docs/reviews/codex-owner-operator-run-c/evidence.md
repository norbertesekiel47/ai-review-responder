# Run C evidence

## T1 — transaction-aware policy writer

Base `6b2eb580940480c6a9b304f3e69c0d7a3bb04f29`. The root integrated an Opus-authored patch restricted to `settings.ts` and the existing settings unit/integration suites. The form route remains unchanged. The new export runs the existing lock, gates, mutation, audit and settings reload on the caller's transaction; both entry points reject impersonation independently.

- Red-first: added tests before the export; 14 failed and 97 passed across three files. Failures detected the missing transaction seam, including the live caller-rollback and blocking cases.
- Green: 111 tests passed across settings unit, settings integration and the existing auto-approval route suite. The nine integration tests executed against the disposable localhost database; neither DB variable pointed at a remote target.
- `pnpm typecheck`: passed.
- ESLint on the three changed TypeScript files: passed.
- `pnpm build`: passed with both DB variables constrained to the local test database.
- Root review: no private gate, confirmation type, archived-policy rule or form contract changed. New tests prove policy+audit rollback, first-override seeding, untouched-field preservation, independent impersonation rejection and explicit account-before-policy query ordering.

The live lock test uses two connections and observes `pg_blocking_pids` while the holder changes the account default. The waiting writer must seed the newly committed value. The holder also probes activity, so it calls `pg_stat_clear_snapshot()` before each observation: transaction-cached activity otherwise hid the writer's new lock wait. This was a test-observation correction, not a production locking change. [PostgreSQL statistics snapshot documentation](https://www.postgresql.org/docs/16/monitoring-stats.html).

Browser verification belongs to the complete Run C journey in T7. This internal export introduces no separate visible form behavior; the existing route suite passed. No Run C end-to-end or staging completion is claimed yet.
