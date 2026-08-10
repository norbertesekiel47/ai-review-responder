// Direct unit coverage for the held-draft gate (launch-audit part1, P1 test
// gap): a typo in hasOpenFlag's status='open' predicate would silently
// release admin-held drafts to owners. Previously covered only indirectly
// via integration tests.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { hasOpenFlag, openFlagExistsSql, HeldForReviewError } from '../held-draft';

type TxCall = { text: string; values: unknown[] };

/**
 * Minimal tagged-template tx double — captures every tagged-template call
 * (outer query + spliced fragments) in order.
 */
function mkTx(rows: unknown[]) {
  const calls: TxCall[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.raw.join('$'), values });
    return Promise.resolve(rows);
  }) as unknown as postgres.TransactionSql;
  return { tx, calls };
}

/**
 * Recursive walk over production .ts/.tsx files — any path containing
 * `__tests__` or `.test.` (which also covers `.integration.test.`) is
 * excluded. Walker style mirrors src/__tests__/console-admin-palette.test.ts.
 */
function walkProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !full.includes('__tests__') && !full.includes('.test.')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Strip `//` line comments, block comments (incl. JSDoc), and SQL `--` line
 * comments so prose mentions of flagged_responses (pending-count's JSDoc,
 * load-replies' in-SQL `--` comment) cannot trip the sweep. Template-literal
 * CONTENT is deliberately NOT stripped — a real `FROM flagged_responses`
 * predicate inside a SQL template literal is exactly what the sweep must
 * catch; the `--` stripper removes only to end-of-line, leaving the rest of
 * the literal intact.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/--[^\n]*/g, '');
}

const RESPONSE_ID = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('hasOpenFlag', () => {
  it('returns true when an open flag row exists', async () => {
    const { tx } = mkTx([{ one: 1 }]);
    await expect(hasOpenFlag(tx, RESPONSE_ID)).resolves.toBe(true);
  });

  it('returns false when no open flag exists', async () => {
    const { tx } = mkTx([]);
    await expect(hasOpenFlag(tx, RESPONSE_ID)).resolves.toBe(false);
  });

  it("filters on status = 'open' and the response id — the predicate that makes the hold binding", async () => {
    const { tx, calls } = mkTx([]);
    await hasOpenFlag(tx, RESPONSE_ID);
    const allText = calls.map((c) => c.text).join('\n');
    expect(allText).toContain("status = 'open'");
    expect(allText).toContain('FROM flagged_responses');
    expect(calls.flatMap((c) => c.values)).toContain(RESPONSE_ID);
  });

  // #730 behavior pin: the true/false contract that must survive the
  // openFlagExistsSql fragment migration unchanged.
  it('hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes', async () => {
    const open = mkTx([{ one: 1 }]);
    await expect(hasOpenFlag(open.tx, RESPONSE_ID)).resolves.toBe(true);
    const closed = mkTx([]);
    await expect(hasOpenFlag(closed.tx, RESPONSE_ID)).resolves.toBe(false);
  });
});

describe('openFlagExistsSql', () => {
  it('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref', () => {
    const { tx, calls } = mkTx([]);
    const ref = tx`resp.id`;
    openFlagExistsSql(tx, ref);
    const exists = calls.at(-1)!;
    expect(exists.text).toContain('EXISTS (');
    expect(exists.text).toContain('FROM flagged_responses fr');
    expect(exists.text).toContain("fr.status = 'open'");
    expect(exists.text).toContain('fr.response_id = ');
    expect(exists.values).toContain(ref);
  });
  it('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains', () => {
    // file → minimum openFlagExistsSql(...) INVOCATIONS (import lines never
    // match `openFlagExistsSql(`): pending-count has TWO spellings.
    const OWNER_FACING: Array<[string, number]> = [
      ['src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts', 1],
      ['src/app/api/dashboard/past-replies/draft-status/route.ts', 1],
      ['src/lib/past-replies/load-replies.ts', 1],
      ['src/lib/dashboard/service.ts', 1],
      ['src/lib/dashboard/aggregate-service.ts', 1],
      ['src/lib/dashboard/pending-count.ts', 2],
      ['src/lib/agents/read.ts', 1],
    ];
    for (const [file, minCalls] of OWNER_FACING) {
      const raw = readFileSync(resolve(process.cwd(), file), 'utf-8');
      // strip line comments so a mention in prose can neither satisfy the
      // invocation count nor trip the inline-spelling scan (round-3 hardening)
      const src = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      const calls = src.match(/openFlagExistsSql\(/g)?.length ?? 0;
      expect(calls, `${file} must invoke openFlagExistsSql at least ${minCalls}×`).toBeGreaterThanOrEqual(minCalls);
      expect(src, `${file} re-spells the open-flag predicate inline`).not.toMatch(/FROM\s+flagged_responses/i);
    }
  });

  it('no promised #730 test title survives as .todo', () => {
    // The verify gate's promised-tests row accepts `.todo`; this closes that
    // escape mechanically. Scans the three suites that carried the four
    // promised stubs.
    const SUITES = [
      'src/lib/moderation/__tests__/held-draft.test.ts',
      'src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts',
      'src/lib/dashboard/__tests__/service.feed-projection.test.ts',
    ];
    for (const suite of SUITES) {
      const src = readFileSync(resolve(process.cwd(), suite), 'utf-8');
      // `.todo` on it/test, dot or bracket access, whitespace-tolerant
      // (round-3 hardening: bracket access `['todo'](...)` and a spaced
      // `. todo (...)` count too). NOTE: spelled indirectly here — a literal
      // runner-dot-todo sequence in this comment would trip the scan below
      // when this suite reads its own source (it is in SUITES).
      expect(src, `${suite} still carries a .todo stub`).not.toMatch(
        /\b(?:it|test)\s*(?:\.\s*todo\b|\[\s*['"]todo['"]\s*\])/,
      );
    }
  });

  it('no production file in the owner-facing trees spells flagged_responses SQL outside the owner module', () => {
    // Repo-wide ratchet for the owner-facing surface (review round 1): any
    // NEW owner-facing read added under these trees must compose
    // openFlagExistsSql — an inline FROM/JOIN on flagged_responses fails
    // here even though the file is not in OWNER_FACING above. The
    // deliberately distinct consumers (admin, health-alert, offboarding
    // purge, producer) live outside these trees on purpose (#725).
    const OWNER_TREES = ['src/app/api/dashboard', 'src/lib/dashboard', 'src/lib/past-replies', 'src/lib/agents'];
    const offenders: string[] = [];
    for (const tree of OWNER_TREES) {
      for (const file of walkProductionTsFiles(resolve(process.cwd(), tree))) {
        const src = stripComments(readFileSync(file, 'utf-8'));
        if (/(?:FROM|JOIN)\s+flagged_responses/i.test(src)) offenders.push(file);
      }
    }
    expect(offenders, 'inline flagged_responses SQL outside the owner module').toEqual([]);
  });

  it('no owner-facing call passes a ref qualified by the reserved fr alias', () => {
    // The fragment's internal alias `fr` shadows an outer alias of the same
    // name: a ref like sql`fr.id` would silently self-correlate
    // (fr.response_id = fr.id) and report held=false. The doc comment
    // reserves the alias; this makes the reservation mechanical.
    const OWNER_TREES = ['src/app/api/dashboard', 'src/lib/dashboard', 'src/lib/past-replies', 'src/lib/agents'];
    for (const tree of OWNER_TREES) {
      for (const file of walkProductionTsFiles(resolve(process.cwd(), tree))) {
        const src = readFileSync(file, 'utf-8');
        for (const call of src.match(/openFlagExistsSql\([^)]*\)/g) ?? []) {
          expect(call, `${file}: ref must not be qualified by the reserved fr alias`).not.toMatch(/\bfr\./);
        }
      }
    }
  });
});

describe('HeldForReviewError', () => {
  it('carries the held_for_review message and name', () => {
    const err = new HeldForReviewError();
    expect(err.message).toBe('held_for_review');
    expect(err.name).toBe('HeldForReviewError');
    expect(err).toBeInstanceOf(Error);
  });
});
