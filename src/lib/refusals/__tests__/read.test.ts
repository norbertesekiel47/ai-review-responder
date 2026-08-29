// The Refusal Log eval — read-layer unit half (T0, red-first).
//
// Titles are VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches them as fixed strings.
//
// T2 landed `src/lib/refusals/read.ts` with the S5 arm; T3/T4 add the other
// five to the same `UNION ALL`. Two cases here are SOURCE-SHAPE invariants that
// need the file to exist rather than to be loaded:
//
//   - the flagged-reason redaction invariant (risk 1 in plan §7: S1 is deny-all
//     RLS read through the RLS-bypassing `postgres` role, so redaction is the
//     whole security story and the assertion is the ABSENCE of the column from
//     the SQL, not that a label looks right);
//   - invariant #15, which is a file-level import rule by construction.
//
// The query-shape cases below run the real `getRefusalLog` against the shared
// Postgres.js mock (`createMockSql`), which flattens nested fragments into the
// recorded query text — so a scoping assertion reads the SQL the module would
// actually send. The ones still `it.todo` need arms T3/T4 own.
//
// Behavioural coverage — tenant isolation, presence per source, windows,
// exclusions — lives in `./read.integration.test.ts`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { DashboardReadScope } from '@/lib/agents/read';
import {
  AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT,
} from '@/lib/approval/audit';
import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';
import {
  AUTO_POST_REVOKED_ACTION_CATEGORIES,
  AUTO_POST_REVOKED_ACTION_FOR_REASON,
  ConflictingRefusalActionError,
  deriveActionCategories,
  getRefusalLog,
  resolveRefusalCategory,
} from '../read';
import {
  AUTO_POST_REVOKED_REFUSAL_CATEGORIES,
  UnknownRefusalCodeError,
  refusalCategoryFor,
  type RefusalCategory,
} from '../vocabulary';

const REFUSALS_DIR = join(process.cwd(), 'src/lib/refusals');
const READ_MODULE = 'src/lib/refusals/read.ts';

/** Production modules under `src/lib/refusals/` — `__tests__/` is a directory, so the `.ts` filter drops it. */
function refusalsProductionModules(): readonly string[] {
  if (!existsSync(REFUSALS_DIR)) return [];
  return readdirSync(REFUSALS_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
}

function readSourceOrFail(relativePath: string, owner: string): string {
  const absolute = join(process.cwd(), relativePath);
  expect(existsSync(absolute), `${relativePath} does not exist yet — ${owner} creates it`).toBe(true);
  return readFileSync(absolute, 'utf8');
}

/** The module that owns the reason→action collapse the read has to invert. */
const DOWNGRADE_MODULE = 'worker/jobs/publisher/auto-policy-downgrade.ts';

function readRepoFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

/** Every audit-action constant by NAME, so the parse below never re-spells a value. */
const AUDIT_ACTION_BY_NAME: Readonly<Record<string, string>> = {
  AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT,
};

/**
 * `DOWNGRADE_MARKERS`, read out of its owner. It is module-PRIVATE and lives in
 * `worker/`, whose runtime graph pulls `postgres` and the outbox helpers — so no
 * `src/lib` module can import it, and the copy in
 * `AUTO_POST_REVOKED_ACTION_FOR_REASON` is proven equal here instead. Same
 * technique as `vocabulary.test.ts`'s migration-111 and bare-union cases (D8e,
 * D12a); the copy lives in `../read.ts` rather than `../vocabulary.ts` because
 * only the read ever sees a stored audit action (D13).
 */
function downgradeMarkerTable(): Readonly<Record<string, string>> {
  const body = /const DOWNGRADE_MARKERS\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(
    readRepoFile(DOWNGRADE_MODULE),
  )?.[1];
  if (body === undefined) {
    throw new Error(`${DOWNGRADE_MODULE}: could not locate \`const DOWNGRADE_MARKERS\``);
  }
  const table: Record<string, string> = {};
  for (const entry of body.matchAll(/^\s*([a-z_]+)\s*:\s*([A-Z][A-Z0-9_]*)\s*,/gm)) {
    const reason = entry[1];
    const constantName = entry[2];
    if (reason === undefined || constantName === undefined) continue;
    const action = AUDIT_ACTION_BY_NAME[constantName];
    if (action === undefined) {
      throw new Error(`${DOWNGRADE_MODULE}: '${reason}' names unknown constant ${constantName}`);
    }
    table[reason] = action;
  }
  return table;
}

/** SQL keywords a naive `FROM <table> <word>` capture can pick up instead of an alias. */
const SQL_KEYWORDS = new Set([
  'where',
  'on',
  'join',
  'left',
  'inner',
  'union',
  'order',
  'group',
  'limit',
  'and',
  'as',
]);

describe('getRefusalLog redaction', () => {
  // REAL, red at this commit. `flagged_responses.reason` is moderation prose;
  // no value read from it may be selected by the query or placed in a returned
  // object (intake invariant 4).
  it('getRefusalLog never selects flagged_responses.reason', () => {
    const source = readSourceOrFail(READ_MODULE, 'T2');

    expect(source).not.toContain('flagged_responses.reason');

    const aliasMatch = /flagged_responses\s+(?:AS\s+)?([a-z][a-z0-9_]*)/i.exec(source);
    const alias = aliasMatch?.[1];
    if (alias !== undefined && !SQL_KEYWORDS.has(alias.toLowerCase())) {
      expect(source, `the flagged_responses arm selects ${alias}.reason`).not.toContain(
        `${alias}.reason`,
      );
    }
  });

  // `getRefusalLog returns no draft text or review text for a held draft` moved
  // to `./read.integration.test.ts` (T3). It is a BEHAVIOURAL claim about a real
  // held draft carrying real moderation prose, a real draft body and a real
  // review body; here it could only have re-read the module text the case above
  // already reads. Same reasoning and the same freedom of placement as D9e —
  // the `promised-tests` gate is a fixed-string grep over `src`, `worker` and
  // `scripts`, not a per-file ledger.
});

/**
 * The ONE statement `getRefusalLog` issues, as the mock recorded it: real
 * template text with every bound value flattened to `?`, nested fragments
 * (`inLocation`) inlined. Asserting on it is how the two scoping cases below
 * see the SQL the module would actually send.
 */
async function recordRefusalLogSql(scope: DashboardReadScope): Promise<string> {
  const harness = createMockSql();
  await getRefusalLog(harness.mockSql as unknown as Sql, scope, '30d');
  expect(harness.sqlCalls, 'getRefusalLog issued more than one statement').toHaveLength(1);
  return harness.sqlCalls[0]!.text;
}

/**
 * The `UNION ALL` arms, split. Each chunk carries one arm's `FROM` and `WHERE`;
 * the first also carries the wrapper's `SELECT … FROM (` and the last its
 * `) AS refusal_entries ORDER BY …`, neither of which affects a containment
 * assertion about that arm's own predicates.
 */
function unionArms(sqlText: string): readonly string[] {
  return sqlText.split(/\bUNION\s+ALL\b/i);
}

/** An arm's root table — every arm aliases it `r`, which is the whole convention. */
function armRootTable(arm: string): string {
  const match = /\bFROM\s+([a-z_]+)\s+r\b/i.exec(arm);
  const table = match?.[1];
  if (table === undefined) {
    throw new Error(`refusal arm has no \`FROM <table> r\` root:\n${arm}`);
  }
  return table;
}

/**
 * S4 is the ONE account-wide arm: `account_audit_log` has a nullable
 * `location_id` the suspension writer leaves NULL, and a suspended account
 * default applies to every location. Named here so the second case below can
 * exempt it BY NAME rather than by "the arm that happens to have no business
 * predicate" — which would pass just as happily if an arm lost one.
 */
const ACCOUNT_WIDE_ROOT_TABLE = 'account_audit_log';

describe('getRefusalLog query shape', () => {
  // The arms share ONE statement, so these two cases prove the SHAPE of every
  // arm's scoping and nothing about any arm's behaviour. The behavioural
  // per-arm proof — a real foreign-account or foreign-location row that does
  // not come back — is `./read.integration.test.ts`'s, one case per arm
  // (intake invariant 1). Neither substitutes for the other.
  it('every refusal source query scopes account reads by account_id', async () => {
    for (const scope of [
      { kind: 'account', accountId: 'account-1' },
      { kind: 'location', accountId: 'account-1', businessId: 'business-1' },
    ] satisfies DashboardReadScope[]) {
      const arms = unionArms(await recordRefusalLogSql(scope));
      const roots = arms.map(armRootTable);

      // Non-vacuous by construction: all six sources, named, so a dropped arm
      // fails here rather than silently reducing the loop below to five.
      expect(roots.sort(), `${scope.kind} scope: refusal source tables`).toEqual([
        'account_audit_log',
        'approval_audit_log',
        'flagged_responses',
        'solicitation_asks',
        'solicitation_batches',
        'solicitation_outreach',
      ]);

      for (const arm of arms) {
        expect(arm, `${scope.kind} scope: ${armRootTable(arm)} arm is unscoped`).toContain(
          'r.account_id = ?',
        );
      }
    }
  });

  it('every business-scoped refusal source query scopes location reads by account_id and business_id', async () => {
    const located = unionArms(
      await recordRefusalLogSql({
        kind: 'location',
        accountId: 'account-1',
        businessId: 'business-1',
      }),
    );

    for (const arm of located) {
      const root = armRootTable(arm);
      if (root === ACCOUNT_WIDE_ROOT_TABLE) {
        // The deliberate omission, pinned: filtering an account-wide suspension
        // by one location would hide it from the scope the owner is standing in.
        expect(arm, `${root} must carry NO location predicate`).not.toContain('r.business_id');
        continue;
      }
      expect(arm, `${root} arm: account half`).toContain('r.account_id = ?');
      expect(arm, `${root} arm: location half`).toContain('r.business_id = ?');
    }

    // And the child joins are scoped on BOTH sides through the `businesses`
    // bridge, never left to a composite FK happening to exist: the bridge is
    // pinned to the scoped account and every child is tied to `loc.id`.
    for (const arm of located.filter((candidate) => /\bJOIN\s+businesses\s+loc\b/i.test(candidate))) {
      expect(arm, `${armRootTable(arm)} arm: bridge`).toContain('loc.account_id = ?');
      expect(arm, `${armRootTable(arm)} arm: child tie`).toContain('= loc.id');
    }

    // Aggregate scope resolves the SAME fragment to `TRUE`, so no arm carries a
    // business predicate there — the location half is one conjunct with two
    // spellings, not two queries.
    const aggregate = await recordRefusalLogSql({ kind: 'account', accountId: 'account-1' });
    expect(aggregate).not.toContain('r.business_id = ?');
  });

  // Intake edge case: an unrecognised source code reaching the read is a fault,
  // not a category. Assert rather than fall back to a default.
  //
  // A code can only reach here from a row the SQL already filtered on, so the
  // failure this pins is a DRIFTED source vocabulary — a seventh
  // `WithholdReason` shipped without a mapping — not user input. The mock feeds
  // exactly that row; a default category would file it under a plausible-looking
  // heading the owner cannot tell from a real one.
  it('getRefusalLog throws on an unrecognised source code rather than defaulting a category', async () => {
    const harness = createMockSql();
    harness.sqlReturnQueue.push([
      {
        entry_id: 'ask-1',
        source: 'ask_withheld',
        code: 'reason_nobody_decided_about',
        occurred_at: new Date('2026-08-20T12:00:00.000Z'),
        review_id: null,
      },
    ]);

    await expect(
      getRefusalLog(
        harness.mockSql as unknown as Sql,
        { kind: 'account', accountId: 'account-1' },
        '30d',
      ),
    ).rejects.toBeInstanceOf(UnknownRefusalCodeError);
  });
});

// ── S3's second key space (moved here by T4 §A; deviations D11, D12a, D13) ──
//
// The reason-keyed map in `../vocabulary.ts` is the exhaustiveness guard, and
// the DATABASE stores something else: `approval_audit_log.action` holds one of
// FIVE audit actions, because DOWNGRADE_MARKERS collapses `judge_disabled` and
// `judge_unhealthy` onto one. Reaching those action literals means a VALUE
// import of `@/lib/approval/audit`, whose graph carries `node:crypto` — which
// is why the table, its derivation and these four cases live with the read
// rather than in the client-safe vocabulary leaf. Titles are verbatim.
describe('auto-policy audit action key space', () => {
  it('every AutoPolicyDowngradeReason maps to the audit action DOWNGRADE_MARKERS writes', () => {
    const markers = downgradeMarkerTable();
    expect(Object.keys(markers).length, `parsed no ${DOWNGRADE_MODULE} markers`).toBeGreaterThan(0);
    // Six reasons in, five distinct actions out — the collapse itself.
    expect(Object.keys(markers)).toHaveLength(6);
    expect(new Set(Object.values(markers)).size).toBe(5);
    expect({ ...AUTO_POST_REVOKED_ACTION_FOR_REASON }).toEqual({ ...markers });
  });

  it('the auto-post-revoked action map is derived from the reason map', () => {
    const markers = downgradeMarkerTable();
    const categoriesByAction: Readonly<Record<string, RefusalCategory | null>> =
      AUTO_POST_REVOKED_ACTION_CATEGORIES;
    const categoriesByReason: Readonly<Record<string, RefusalCategory | null>> =
      AUTO_POST_REVOKED_REFUSAL_CATEGORIES;

    // Keys are EXACTLY the distinct actions, not a hand-kept second list.
    expect(Object.keys(categoriesByAction).sort()).toEqual(
      [...new Set(Object.values(markers))].sort(),
    );
    // Every reason's category survives the re-key unchanged.
    for (const [reason, action] of Object.entries(markers)) {
      expect(categoriesByAction[action], `${action} ← ${reason}`).toBe(categoriesByReason[reason]);
    }
  });

  it('deriveActionCategories throws when two collapsed reasons carry different categories', () => {
    // The consistent collapse the codebase actually has: both judge reasons
    // carry watchdog_unavailable, so one action carries it too.
    expect(
      deriveActionCategories(
        { judge_disabled: 'watchdog_unavailable', judge_unhealthy: 'watchdog_unavailable' },
        { judge_disabled: 'one_action', judge_unhealthy: 'one_action' },
      ),
    ).toEqual({ one_action: 'watchdog_unavailable' });

    // The day they disagree, a silent pick would file every refusal written
    // under the losing reason beneath a heading the owner cannot tell from a
    // real one. Throw instead — the UnknownRefusalCodeError rule, one level up.
    expect(() =>
      deriveActionCategories(
        { judge_disabled: 'watchdog_unavailable', judge_unhealthy: 'autonomy_paused' },
        { judge_disabled: 'one_action', judge_unhealthy: 'one_action' },
      ),
    ).toThrow(ConflictingRefusalActionError);
  });

  // `resolveRefusalCategory` is `refusalCategoryFor` plus exactly one
  // translation — the S3 action key space — and delegates to it unchanged for
  // every other lane. Both halves are asserted: the read resolves what the
  // database stores, and the vocabulary still refuses to invent a category.
  it('refusalCategoryFor resolves a stored auto-policy audit action', () => {
    const locked: readonly [string, RefusalCategory][] = [
      [AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH, 'autonomy_paused'],
      [AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED, 'watchdog_unavailable'],
      [AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE, 'watchdog_unavailable'],
      [AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT, 'autonomy_paused'],
      [AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED, 'autonomy_paused'],
    ];
    for (const [action, category] of locked) {
      expect(resolveRefusalCategory('auto_post_revoked', action), action).toBe(category);
    }

    // An action the log does not read is still a FAULT, not a category — on
    // both the read's translation and the vocabulary's lookup beneath it.
    expect(() => resolveRefusalCategory('auto_post_revoked', 'auto_approved_by_policy')).toThrow(
      UnknownRefusalCodeError,
    );
    expect(() => refusalCategoryFor('auto_post_revoked', 'auto_approved_by_policy')).toThrow(
      UnknownRefusalCodeError,
    );

    // Every other lane is pass-through, not a second vocabulary.
    expect(resolveRefusalCategory('ask_withheld', 'no_consent')).toBe(
      refusalCategoryFor('ask_withheld', 'no_consent'),
    );
  });
});

describe('refusals module invariants', () => {
  // REAL, red at this commit — invariant #15. Domain modules under `src/lib/**`
  // take `sql` as an explicit parameter; only the route file (a composition
  // root) imports the singleton.
  it('refusals domain modules do not import @/lib/db/server', () => {
    const modules = refusalsProductionModules();
    expect(
      modules.length,
      'src/lib/refusals holds no production module yet — T1 and T2 create them',
    ).toBeGreaterThan(0);

    const offenders = modules.filter((name) =>
      readFileSync(join(REFUSALS_DIR, name), 'utf8').includes('@/lib/db/server'),
    );
    expect(offenders, 'refusals domain modules importing the db singleton').toEqual([]);
  });
});
