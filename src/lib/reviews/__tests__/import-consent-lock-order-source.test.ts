// src/lib/reviews/__tests__/import-consent-lock-order-source.test.ts
//
// T0 EVAL — title 70 of the intake's 70, authored VERBATIM before implementation.
//
// A *source* tripwire, in the style of location-lifecycle-lock-order-source.test.ts
// and status-lock-order-source.test.ts. It reads the production files and asserts
// each zernio_initial_backfill producer takes the `businesses` row lock BEFORE its
// topic INSERT.
//
// WHY A SOURCE TEST AND NOT A BEHAVIOURAL ONE (plan §3 T0, §5): single-enqueue is
// enforced here by CONVENTION — the row lock — not by a constraint. Migration 004
// chose a partial unique index for this class on `sync_reviews`; the owner chose
// the lock for #677 to keep the ticket migration-free, accepting that a future
// producer which skips the lock reopens the check-then-insert race. A behavioural
// race test can only prove the producers that exist today; this is the only check
// that survives a FIFTH producer being added, because it fails the moment a new
// enqueue site appears without the lock above it.
//
// If this test ever becomes a maintenance burden, the durable answer is the
// partial unique index, not deleting the tripwire (plan §5).
//
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relativeUrl: string): string {
  const url = new URL(relativeUrl, import.meta.url);
  // A named failure beats an ENOENT stack: before T1/T3 land, the point of this
  // test is to be legibly red, not to explode.
  expect(existsSync(url), `producer source not found: ${relativeUrl}`).toBe(true);
  return readFileSync(url, 'utf8');
}

function segment(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing production marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  expect(end, `missing production marker: ${endMarker ?? 'EOF'}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectOrder(source: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker, previous + 1);
    expect(index, `missing/out-of-order production marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('import consent production lock-order binding', () => {
  // T0 leaves this deferred and **T3 restores the assertion** (plan T3). Until
  // T3 writes the four producers, this test's only possible failure is "the file
  // does not exist yet" — which says nothing about the feature and is exactly the
  // "not yet buildable" case T0 defines as deferred. The body below is already
  // complete; T3 drops the `.todo` suffix from the declaration and it starts
  // guarding.
  it.todo('every zernio_initial_backfill producer acquires the businesses row lock before its outbox INSERT', () => {
    // Producer 1 — the acceptance transaction. Opens its own sql.begin and takes
    // the row lock as its FIRST statement.
    const consentSource = read('../import-consent.ts');
    const acceptance = segment(
      consentSource,
      'export async function recordImportDecisionAndEnqueue',
    );
    expectOrder(acceptance, [
      'sql.begin',
      'FROM businesses',
      'FOR UPDATE',
      'INSERT INTO job_outbox',
    ]);

    // Producer 2 — connect finalize. Already inside the connect transaction; the
    // lock must still precede the enqueue.
    const finalizeSource = read('../../../app/api/zernio/connect/_shared/finalize/finalize-tx.ts');
    expectOrder(segment(finalizeSource, 'export async function finalizeConnectionTx'), [
      'FROM businesses',
      'FOR UPDATE',
      'INSERT INTO job_outbox',
    ]);

    // Producer 3 — the Stripe §5.2 resume. Round-2 F107: this path used to run on
    // root `sql` with no transaction at all, so `createImportOffer` had no
    // TransactionSql to run in and its dedup check was unserialized. The
    // sql.begin marker is the fix, and it must come first.
    const stripeSource = read('../../../../worker/ingress/stripe/shared.ts');
    expectOrder(segment(stripeSource, 'async function maybeEnqueueBackfillResume'), [
      'sql.begin',
      'FROM businesses',
      'FOR UPDATE',
      'INSERT INTO job_outbox',
    ]);

    // Producer 4 — reactivation. Already holds the account and business rows via
    // lockArchiveContext, so it needs no new lock code — but it is still a
    // producer and is asserted here so a future refactor cannot quietly drop the
    // ordering. Note this producer is deliberately EXCLUDED from the
    // exactly-one-job assertion (title 61): it enqueues with
    // backfill_reason 'reactivation' and the worker's
    // ON CONFLICT … WHERE run_reason = 'initial' does not dedup it, because the
    // archived-period catch-up is SUPPOSED to run again after a completed
    // initial run.
    const archiveSource = read('../../locations/archive-location-tx.ts');
    expectOrder(segment(archiveSource, 'export async function reactivateLocationTransaction'), [
      'acquireLocationLifecycleLock(tx, accountId)',
      'FROM businesses',
      'FOR UPDATE',
      'INSERT INTO job_outbox',
    ]);

    // The two producers that own their own transaction must OPEN it before the
    // lock — asserted inside this title rather than as a 71st test, because
    // `SELECT … FOR UPDATE` is a NO-OP outside sql.begin() under Supabase's
    // transaction pooling (CLAUDE.md gotcha): PgBouncer drops the row lock the
    // instant the SELECT returns. A producer without its own transaction is not
    // "mostly safe", it is unprotected — and the ordering markers above would
    // still pass for it, which is why the enclosure is checked separately.
    for (const [name, source, marker] of [
      ['import-consent.ts', consentSource, 'export async function recordImportDecisionAndEnqueue'],
      ['stripe/shared.ts', stripeSource, 'async function maybeEnqueueBackfillResume'],
    ] as const) {
      const scope = segment(source, marker);
      const beginAt = scope.indexOf('sql.begin');
      const forUpdateAt = scope.indexOf('FOR UPDATE');
      expect(beginAt, `${name}: FOR UPDATE with no enclosing sql.begin`).toBeGreaterThanOrEqual(0);
      expect(beginAt, `${name}: sql.begin must open before the row lock`).toBeLessThan(forUpdateAt);
    }
  });
});
