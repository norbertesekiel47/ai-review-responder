/**
 * Canonical `job_outbox.status` vocabulary.
 *
 * Standalone on purpose, mirroring `queue-names.ts`: `ci:outbox-status` imports
 * this module to derive its expected set, and must be able to do so without
 * pulling in `job-outbox-helpers.ts`'s postgres dependencies.
 *
 * ## The in-flight set is a byte-for-byte contract, not just a value list
 *
 * `('pending', 'dispatching', 'dispatched')` is the set of statuses a row can
 * hold between enqueue and completion. It appears in ~26 SQL call sites and ~19
 * migrations, and it CANNOT be parameterized away: several sites use it inside
 * an `ON CONFLICT … WHERE` predicate, where Postgres infers the partial index by
 * comparing the predicate to the index definition. A bind parameter defeats that
 * inference (CLAUDE.md: "`ON CONFLICT` must match partial-index predicate
 * BYTE-FOR-BYTE"), so the literal must stay spelled out at every site.
 *
 * That is why this module exports a constant for the AUDIT to check against
 * rather than a SQL fragment for call sites to interpolate. The call sites are
 * deliberately left byte-identical; `ci:outbox-status` is what keeps them honest.
 *
 * ## Why this exists
 *
 * Migration 018 exists solely to rebuild `idx_jo_sync_reviews_inflight` because
 * migration 004 shipped it missing `'dispatching'` — an in-flight row was
 * therefore invisible to the dedup index, and duplicate jobs could be enqueued.
 * The drift this constant guards has already bitten this repo once.
 *
 * Member ORDER is significant to the audit. Postgres compares parsed
 * expressions, so a reordered list is semantically equivalent — but keeping one
 * spelling is what makes the byte-for-byte `ON CONFLICT` requirement mechanical
 * to check instead of a judgement call at review time.
 */
export const OUTBOX_IN_FLIGHT_STATUSES = ['pending', 'dispatching', 'dispatched'] as const;

/**
 * Statuses that only ever occur on `job_outbox`, so their presence in a status
 * group identifies that group as an outbox predicate rather than one belonging
 * to a joined table. `'pending'` is deliberately EXCLUDED — it is also a
 * `responses`, `zernio_connections`, `account_offboardings`, and
 * `solicitation_contacts` status, so it cannot discriminate.
 */
export const OUTBOX_DISTINCTIVE_STATUSES = ['dispatching', 'dispatched'] as const;
