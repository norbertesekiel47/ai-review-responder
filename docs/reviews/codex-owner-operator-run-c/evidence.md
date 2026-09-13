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

## T4 — pure consequence simulator

The root reviewed and integrated the Opus-authored simulator and hand-counted fixtures. `simulateRule` calls the publisher's `starMeetsThreshold` and `resolveDailyCap`, excludes imports before looking up dials, and counts cap slots independently for each business/day. The caller supplies SQL day buckets and canonical UTC timestamp text; the simulator has no database, clock, or local-time dependency. Server reads and persisted proposal/receipt counts remain T5 work.

- Red-first: the new suite failed to import the missing simulator before production code was added.
- Green: all 12 unit tests passed, including the nine non-imported reviews in the hand-counted table (3 eligible; 3 below threshold, 1 cap-held, 2 manual), cap reset across days/businesses, shared-predicate spies, default cap, immutable input, and imported-only businesses.
- TypeScript, scoped ESLint, and the directory-map audit passed. The build passed with both database variables pointing at the disposable localhost database.
- Local build process only: `SENTRY_AUTH_TOKEN`, `SENTRY_DSN`, and `NEXT_PUBLIC_SENTRY_DSN` were explicitly empty, following the documented local configuration. Automatic approval review rejected the initial build command's potential source-map upload; the revised command removed that egress and was approved. No source configuration or remote setting changed.

This is an internal calculation checkpoint. Browser and staging evidence will exercise the integrated cards in T7.
