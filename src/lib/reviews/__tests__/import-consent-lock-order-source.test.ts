// src/lib/reviews/__tests__/import-consent-lock-order-source.test.ts
//
// T0 EVAL — title 69 of the intake's 69, authored VERBATIM before implementation.
//
// A *source* tripwire, in the style of location-lifecycle-lock-order-source.test.ts,
// status-lock-order-source.test.ts and outcome-anchor-pairing.test.ts. It reads the
// production files and asserts each zernio_initial_backfill producer takes the
// `businesses` row lock BEFORE its enqueue.
//
// WHY A SOURCE TEST AND NOT A BEHAVIOURAL ONE (plan §3 T0, §5): single-enqueue is
// enforced here by CONVENTION — the row lock — not by a constraint. Migration 004
// chose a partial unique index for this class on `sync_reviews`; the owner chose
// the lock for #677 to keep the ticket migration-free, accepting that a future
// producer which skips the lock reopens the check-then-insert race. A behavioural
// race test can only prove the producers that exist today.
//
// WHAT THIS FILE ACTUALLY ENFORCES, stated precisely (round-1 A7). The original
// version claimed it "survives a FIFTH producer being added". It did not: it read
// four hard-coded paths, nothing enumerated the enqueue sites, and `segment()`
// with no end marker sliced to EOF — so a producer appended below an asserted
// function inherited that function's `FOR UPDATE` and passed. Three fixes, and
// the claim is now true rather than aspirational:
//
//   1. THE PRODUCER SET IS DERIVED, not listed. `src/` and `worker/` are walked
//      and every file that raw-INSERTs the topic or calls `enqueueInitialImport`
//      is collected. A new producer file fails `PRODUCER_FILES` until it is
//      reviewed and listed — the same governance as outcome-anchor-pairing's
//      CALLER_ALLOWLIST.
//   2. `segment()` ENDS AT THE FUNCTION'S CLOSING BRACE, not at EOF. An appended
//      producer can no longer inherit an earlier lock.
//   3. EVERY producing SITE in a producer file must fall inside an asserted
//      segment. A fifth producer added to an existing file — a second function
//      in `stripe/shared.ts`, say — fails here even though the file is already
//      listed.
//
// It also pins the `b.` alias contract that deviations D9 credited this file
// with and which it never made: `importConsentStateSql` hard-codes the alias and
// takes no interpolation, so a composer aliasing `businesses` differently either
// throws or silently derives consent from the wrong row, with nothing in the
// compiler or the CI audits to catch it.
//
// If this test ever becomes a maintenance burden, the durable answer is the
// partial unique index, not deleting the tripwire (plan §5).
//
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCAN_ROOTS = ['src', 'worker'] as const;
const SKIP_DIRS = new Set(['__tests__', 'fixtures', 'node_modules']);

/**
 * A site that puts a `zernio_initial_backfill` row into `job_outbox`: either the
 * raw `INSERT INTO job_outbox … ZERNIO_INITIAL_BACKFILL` statement, or a
 * delegating call to the shared enqueue.
 *
 * The topic constant ALONE is not a producing site — `import-offer-view.ts`
 * reads outbox rows by it, and `worker/index.ts` / `worker/queues.ts` register
 * the queue with it. Requiring the constant to sit inside an `INSERT INTO
 * job_outbox` statement is what separates writing from reading.
 *
 * `(?<!function )` excludes `enqueueInitialImport`'s own declaration, which is
 * the implementation and not a producer — the same lookbehind trick
 * outcome-anchor-pairing.test.ts uses to keep run-spine.ts out of its own
 * caller set.
 */
const PRODUCING_SITE =
  /INSERT INTO job_outbox[\s\S]{0,400}?QUEUE_NAMES\.ZERNIO_INITIAL_BACKFILL|(?<!function )\benqueueInitialImport\s*\(/g;

/**
 * Reviewed producer files. Derived from the tree and compared against this list,
 * so adding a producer file is a deliberate edit here rather than a silent one
 * in the tree.
 */
const PRODUCER_FILES = [
  'src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts',
  'src/lib/locations/archive-location-tx.ts',
  'src/lib/reviews/import-consent.ts',
  'worker/ingress/stripe/shared.ts',
] as const;

/**
 * COMMENTS ARE STRIPPED BEFORE SCANNING, and that is load-bearing.
 *
 * These producers document the very rule this test enforces — "`SELECT … FOR
 * UPDATE` is a NO-OP outside `sql.begin()`" appears verbatim in
 * `stripe/shared.ts`'s header. Scanning raw text found that sentence's `FOR
 * UPDATE` before the real `sql.begin` below it and failed a correctly-ordered
 * producer. A source tripwire that can be fooled by prose is worse than none: it
 * would have been "fixed" by deleting the explanation. Stripping also keeps the
 * derived producer set honest — a file that merely *mentions*
 * `enqueueInitialImport` in a comment is not a producer.
 *
 * Strips `/* … *\/` blocks and whole-line `//` comments only. Trailing inline
 * comments are left alone deliberately — removing them would need real
 * tokenization to avoid mangling `'https://…'` inside a string literal.
 */
function strip(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function read(relativeUrl: string): string {
  const url = new URL(relativeUrl, import.meta.url);
  // A named failure beats an ENOENT stack.
  expect(existsSync(url), `producer source not found: ${relativeUrl}`).toBe(true);
  return strip(readFileSync(url, 'utf8'));
}

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkSourceFiles(join(dir, entry.name));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

function findFilesMatching(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const filePath of walkSourceFiles(join(process.cwd(), root))) {
      if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test(strip(readFileSync(filePath, 'utf8')))) {
        found.push(relative(process.cwd(), filePath).split('\\').join('/'));
      }
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * The slice from `startMarker` to the CLOSING BRACE of the declaration it opens.
 *
 * The EOF fallback this replaced is the round-1 A7 defect: with no end marker
 * the slice ran to the end of the file, so anything appended below an asserted
 * function silently inherited that function's `FOR UPDATE` and the ordering
 * check passed for code with no lock at all.
 *
 * Brace counting is sound here because comments are stripped first and no
 * producer embeds an unbalanced brace in a string literal (postgres.js `${…}`
 * interpolation is balanced by construction). If that ever stops being true the
 * failure is loud, not silent: the segment ends in the wrong place and the
 * ordering assertion fails by name.
 *
 * The PARAMETER LIST IS SKIPPED FIRST, by paren-balancing. `finalizeConnectionTx`
 * destructures its second argument, so "the first `{` after the marker" is the
 * destructuring pattern, not the body — brace-matching from there produced a
 * three-line segment in which no `FROM businesses` exists and the ordering
 * assertion failed on correct code. Same loudness caveat: a future signature
 * with an inline object RETURN type would break here by name rather than pass.
 */
function segment(source: string, startMarker: string): { text: string; start: number; end: number } {
  const start = source.indexOf(startMarker);
  expect(start, `missing production marker: ${startMarker}`).toBeGreaterThanOrEqual(0);

  const paramsOpen = source.indexOf('(', start + startMarker.length);
  expect(paramsOpen, `no parameter list after production marker: ${startMarker}`).toBeGreaterThan(start);
  let parens = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) {
        paramsClose = i;
        break;
      }
    }
  }
  expect(paramsClose, `unbalanced parameter list for production marker: ${startMarker}`)
    .toBeGreaterThan(paramsOpen);

  const open = source.indexOf('{', paramsClose);
  expect(open, `no block opens after production marker: ${startMarker}`).toBeGreaterThan(start);

  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  expect(end, `unbalanced block for production marker: ${startMarker}`).toBeGreaterThan(open);
  return { text: source.slice(start, end), start, end };
}

function expectOrder(source: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker, previous + 1);
    expect(index, `missing/out-of-order production marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

/** Every index in `source` at which a producing site appears. */
function producingSites(source: string): number[] {
  const indexes: number[] = [];
  for (const match of source.matchAll(PRODUCING_SITE)) {
    if (match.index !== undefined) indexes.push(match.index);
  }
  return indexes;
}

describe('import consent production lock-order binding', () => {
  // Deferred by T0 (its subject files did not exist), RESTORED by T3 now that all
  // four producers are written, and rewritten in round 1 (A7) so the enumeration
  // is derived rather than asserted.
  it('the derived zernio_initial_backfill producer set is exactly the reviewed one', () => {
    const derived = findFilesMatching(PRODUCING_SITE);
    expect(
      derived,
      'A file now produces zernio_initial_backfill (raw INSERT, or a call to '
        + 'enqueueInitialImport) that is not in PRODUCER_FILES. Every producer must '
        + 'hold the businesses row FOR UPDATE inside its own sql.begin BEFORE the '
        + 'enqueue — the single-enqueue guarantee is that lock, not a unique index '
        + '(plan §5). Take the lock, add the file here, and assert its ordering below.',
    ).toEqual([...PRODUCER_FILES]);
  });

  // Title is the intake's, verbatim and locked. It still describes what this
  // asserts after O3: the producer takes the row lock, then calls
  // `enqueueInitialImport`, which is where the outbox INSERT now lives. The
  // lock is still acquired before that INSERT — only the spelling of the call
  // site moved.
  it('every zernio_initial_backfill producer acquires the businesses row lock before its outbox INSERT', () => {
    // Producer 1 — the acceptance transaction. Opens its own sql.begin and takes
    // the row lock as its FIRST statement.
    const consentSource = read('../import-consent.ts');
    const acceptance = segment(consentSource, 'export async function recordImportDecisionAndEnqueue');
    expectOrder(acceptance.text, [
      'sql.begin',
      'FROM businesses',
      'FOR UPDATE',
      'enqueueInitialImport(',
    ]);

    // The shared implementation. It is NOT a lock taker and must not be asserted
    // as one — its row lock is the caller's, exactly the LOCK_HELD_BY_CALLER
    // carve-out outcome-anchor-pairing.test.ts uses for raise.ts. It is segmented
    // anyway so its raw INSERT counts as an accounted-for producing site below.
    const sharedEnqueue = segment(consentSource, 'export async function enqueueInitialImport');
    expect(sharedEnqueue.text).toContain('INSERT INTO job_outbox');

    // Producer 2 — connect finalize. Already inside the connect transaction; the
    // lock must still precede the enqueue.
    const finalizeSource = read('../../../app/api/zernio/connect/_shared/finalize/finalize-tx.ts');
    const finalize = segment(finalizeSource, 'export async function finalizeConnectionTx');
    expectOrder(finalize.text, [
      'FROM businesses',
      'FOR UPDATE',
      'enqueueInitialImport(',
    ]);

    // Producer 3 — the Stripe §5.2 resume. Round-2 F107: this path used to run on
    // root `sql` with no transaction at all, so `createImportOffer` had no
    // TransactionSql to run in and its dedup was unserialized. The
    // sql.begin marker is the fix, and it must come first.
    const stripeSource = read('../../../../worker/ingress/stripe/shared.ts');
    const stripeResume = segment(stripeSource, 'async function maybeEnqueueBackfillResume');
    expectOrder(stripeResume.text, [
      'sql.begin',
      'FROM businesses',
      'FOR UPDATE',
      'enqueueInitialImport(',
    ]);

    // Producer 4 — reactivation. Already holds the account and business rows via
    // lockArchiveContext, so it needs no new lock code — but it is still a
    // producer and is asserted here so a future refactor cannot quietly drop the
    // ordering. It is deliberately NOT routed through enqueueInitialImport and is
    // deliberately EXCLUDED from the exactly-one-job assertion (title 61): it
    // enqueues with backfill_reason 'reactivation' and the worker's
    // ON CONFLICT … WHERE run_reason = 'initial' does not dedup it, because the
    // archived-period catch-up is SUPPOSED to run again after a completed
    // initial run.
    const archiveSource = read('../../locations/archive-location-tx.ts');
    const reactivate = segment(archiveSource, 'export async function reactivateLocationTransaction');
    expectOrder(reactivate.text, [
      'acquireLocationLifecycleLock(tx, accountId)',
      'FROM businesses',
      'FOR UPDATE',
      'INSERT INTO job_outbox',
    ]);

    // NO PRODUCING SITE ESCAPES A SEGMENT. This is what makes the claim above
    // true for a producer APPENDED to a file that is already listed: the derived
    // set would still match, and (before A7) the EOF slice would have handed the
    // newcomer the previous function's FOR UPDATE.
    for (const [file, source, segments] of [
      ['import-consent.ts', consentSource, [acceptance, sharedEnqueue]],
      ['finalize-tx.ts', finalizeSource, [finalize]],
      ['stripe/shared.ts', stripeSource, [stripeResume]],
      ['archive-location-tx.ts', archiveSource, [reactivate]],
    ] as const) {
      const unaccounted = producingSites(source).filter(
        (at) => !segments.some((s) => at >= s.start && at < s.end),
      );
      expect(
        unaccounted,
        `${file}: zernio_initial_backfill is produced outside every asserted `
          + 'function. A producer added below an asserted one is exactly the case '
          + 'the EOF slice used to pass silently — segment the new function and '
          + 'assert its lock ordering.',
      ).toHaveLength(0);
    }

    // The two producers that own their own transaction must OPEN it before the
    // lock — asserted inside this title rather than as a 71st test, because
    // `SELECT … FOR UPDATE` is a NO-OP outside sql.begin() under Supabase's
    // transaction pooling (CLAUDE.md gotcha): PgBouncer drops the row lock the
    // instant the SELECT returns. A producer without its own transaction is not
    // "mostly safe", it is unprotected — and the ordering markers above would
    // still pass for it, which is why the enclosure is checked separately.
    for (const [name, scope] of [
      ['import-consent.ts', acceptance.text],
      ['stripe/shared.ts', stripeResume.text],
    ] as const) {
      const beginAt = scope.indexOf('sql.begin');
      const forUpdateAt = scope.indexOf('FOR UPDATE');
      expect(beginAt, `${name}: FOR UPDATE with no enclosing sql.begin`).toBeGreaterThanOrEqual(0);
      expect(beginAt, `${name}: sql.begin must open before the row lock`).toBeLessThan(forUpdateAt);
    }
  });

  // Deviations D9 named this file as the mitigation for the `b.` alias contract
  // and it never made the assertion (round-1 spec #7). It does now.
  //
  // `importConsentStateSql` hard-codes `b.` and takes NO interpolation — the
  // alias parameter was removed because injecting it with postgres.js's
  // identifier form `db(alias)` dies against the repo's hand-rolled `sql` mocks
  // in four directories. That trade left the alias an unenforced correctness
  // contract: a composer that writes `FROM businesses biz` either throws or
  // silently derives consent from the wrong row, and nothing in the compiler or
  // the CI audits notices. #679's `guardImportConsent` is the next composer.
  it('every file composing importConsentStateSql aliases businesses as b', () => {
    const composers = findFilesMatching(/importConsentStateSql/);
    expect(
      composers.length,
      'no composer of importConsentStateSql found — the scan is broken, not the tree',
    ).toBeGreaterThan(0);

    for (const file of composers) {
      const source = strip(readFileSync(join(process.cwd(), file), 'utf8'));
      expect(
        /FROM\s+businesses\s+b\b/.test(source),
        `${file} composes importConsentStateSql but does not alias businesses as `
          + '`b`. The fragment hard-codes that alias and takes no interpolation '
          + '(import-consent.ts:72-97), so a different alias derives consent from '
          + 'the wrong row or fails at runtime.',
      ).toBe(true);
    }
  });
});
