// Unit eval for `scripts/revoke-admin.ts` (#1182).
//
// Titles are VERBATIM from `.feature/intake.json` `tests_to_add`; the three
// live-DB titles are in the `.integration.test.ts` sibling, because only a real
// database proves the `admin_audit_log.actor_user_id` foreign key resolves and
// that the `users` row is genuinely untouched.
//
// WHY THIS FILE LIVES UNDER `scripts/ci/__tests__/`. `vitest.config.ts`'s
// include list has `scripts/ci/**/__tests__/**/*.test.ts` and no
// `scripts/__tests__/` entry, so this is where every `scripts/*.ts` module is
// tested today.
//
// Both `scripts/revoke-admin.ts` and the `scripts/mint-admin.ts` it imports are
// import-safe (`runDirectCli` only calls `main()` when Node invoked that module
// directly), so importing them here runs nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../worker/__tests__/helpers/mock-sql';
import { MintAdminUsageError } from '../../mint-admin';
import { assertMintTarget } from '../../staging-guard';
import {
  auditEventFor,
  banDurationFor,
  buildRevokeGuardInput,
  classifyBanState,
  resolveRevokeTarget,
  REVOKE_HORIZON_MS,
  formatRevokeReport,
  formatRevokeTarget,
  parseRevokeAdminArgs,
  RESTORE_BAN_DURATION,
  REVOKE_BAN_DURATION,
  revokeAdmin,
  type RevokeAdminResult,
} from '../../revoke-admin';

// The real refs, from scripts/staging-guard.ts. Project refs are non-secret
// discriminators (they appear in public connection hosts), which is why that
// module hardcodes them too.
const STAGING_REF = 'kubdiqdhqbhwmqfditeg';
const PROD_REF = 'udeyaqnvpojbwgoaxwdg';

const stagingSupabaseUrl = `https://${STAGING_REF}.supabase.co`;
const stagingDbUrl = `postgresql://postgres.${STAGING_REF}:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres`;
const stagingDbTarget = `postgres.${STAGING_REF}@aws-1-us-west-2.pooler.supabase.com:6543`;

const prodSupabaseUrl = `https://${PROD_REF}.supabase.co`;
const prodDbUrl = `postgresql://postgres.${PROD_REF}:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres`;
const prodDbTarget = `postgres.${PROD_REF}@aws-1-us-west-2.pooler.supabase.com:6543`;

// ── the CLI contract ───────────────────────────────────────────────────────

describe('parseRevokeAdminArgs', () => {
  it('parses the email, the confirmed ref and the action', () => {
    expect(
      parseRevokeAdminArgs([
        '--email', 'Admin@RepWorth.NET',
        '--confirm-ref', STAGING_REF,
        '--env', 'staging',
      ]),
    ).toEqual({
      email: 'admin@repworth.net',
      confirmRef: STAGING_REF,
      envMode: 'staging',
      action: 'revoke',
      dryRun: false,
    });
  });

  it('takes --restore as the reversal action and --dry-run independently', () => {
    const args = parseRevokeAdminArgs([
      '--email', 'a@b.net', '--confirm-ref', STAGING_REF, '--restore', '--dry-run',
    ]);
    expect(args.action).toBe('restore');
    expect(args.dryRun).toBe(true);
  });

  it('defaults to the ambient environment, which cannot reach production', () => {
    const args = parseRevokeAdminArgs(['--email', 'a@b.net', '--confirm-ref', STAGING_REF]);
    expect(args.envMode).toBe('ambient');
  });

  it('refuses a missing email or confirmed ref, and a flag-shaped value', () => {
    expect(() => parseRevokeAdminArgs(['--confirm-ref', STAGING_REF]))
      .toThrow(MintAdminUsageError);
    expect(() => parseRevokeAdminArgs(['--email', 'a@b.net']))
      .toThrow(/--confirm-ref is required/);
    // The shared `flagValue` treats a `--`-prefixed token as an ABSENT value.
    // Re-asserted here because this script is a second consumer of that fixed
    // trap (#1178 review finding S3 / red team RT2-01).
    expect(() => parseRevokeAdminArgs(['--email', '--dry-run', '--confirm-ref', STAGING_REF]))
      .toThrow(/--email is required/);
  });

  it('refuses an unknown --env word', () => {
    expect(() =>
      parseRevokeAdminArgs(['--email', 'a@b.net', '--confirm-ref', STAGING_REF, '--env', 'prod']),
    ).toThrow(/--env must be local, staging or production/);
  });
});

describe('buildRevokeGuardInput + assertMintTarget', () => {
  it('refuses a production-looking target when --env production was not passed', () => {
    for (const envMode of ['ambient', 'local', 'staging'] as const) {
      expect(() =>
        assertMintTarget(
          buildRevokeGuardInput(
            { confirmRef: PROD_REF, envMode },
            { supabaseUrl: prodSupabaseUrl, databasePoolUrl: prodDbUrl },
            prodDbTarget,
          ),
        ),
      ).toThrow(/PRODUCTION project ref/);
    }
  });

  it('permits a production target only when --env production AND a matching --confirm-ref are both present', () => {
    // The selector alone cannot reach production with the wrong ref…
    expect(() =>
      assertMintTarget(
        buildRevokeGuardInput(
          { confirmRef: STAGING_REF, envMode: 'production' },
          { supabaseUrl: prodSupabaseUrl, databasePoolUrl: prodDbUrl },
          prodDbTarget,
        ),
      ),
    ).toThrow(/not the confirmed/);

    // …and the two together are the only path that passes.
    expect(() =>
      assertMintTarget(
        buildRevokeGuardInput(
          { confirmRef: PROD_REF, envMode: 'production' },
          { supabaseUrl: prodSupabaseUrl, databasePoolUrl: prodDbUrl },
          prodDbTarget,
        ),
      ),
    ).not.toThrow();
  });

  it('carries allowProduction straight off the parsed selector', () => {
    // Pins the WIRING, not the ends: a mutant hard-coding `allowProduction: true`
    // is invisible to a test that only exercises the guard and the parser.
    expect(
      buildRevokeGuardInput(
        { confirmRef: STAGING_REF, envMode: 'staging' },
        { supabaseUrl: stagingSupabaseUrl, databasePoolUrl: stagingDbUrl },
        stagingDbTarget,
      ),
    ).toEqual({
      supabaseUrl: stagingSupabaseUrl,
      dbTarget: stagingDbTarget,
      dbProjectRef: STAGING_REF,
      confirmRef: STAGING_REF,
      allowProduction: false,
    });
    expect(
      buildRevokeGuardInput(
        { confirmRef: PROD_REF, envMode: 'production' },
        { supabaseUrl: prodSupabaseUrl, databasePoolUrl: prodDbUrl },
        prodDbTarget,
      ).allowProduction,
    ).toBe(true);
  });
});

describe('banDurationFor / auditEventFor', () => {
  it('maps the action onto Supabase\'s documented ban vocabulary and one event name each', () => {
    // The VALUES, not the constants against themselves. `banDurationFor('revoke')
    // === REVOKE_BAN_DURATION` is a tautology — both sides are the same import —
    // and under it, setting REVOKE_BAN_DURATION to 'none' made `--revoke` send
    // GoTrue the documented UNBAN verb while the report still printed
    // "the Supabase Auth identity is banned". That mutant passed all 30 tests
    // (red team RT-01, P0). The restore side was pinned; the revoke side was not.
    expect(REVOKE_BAN_DURATION).toBe('876000h');
    expect(RESTORE_BAN_DURATION).toBe('none');
    expect(banDurationFor('revoke')).toBe('876000h');
    expect(banDurationFor('restore')).toBe('none');
    expect(auditEventFor('revoke')).toBe('admin_revoked');
    expect(auditEventFor('restore')).toBe('admin_restored');
  });
});

// ── the ban-state classifier (RT-02, RT-03) ────────────────────────────────

describe('classifyBanState', () => {
  const NOW = Date.parse('2026-09-08T12:00:00Z');
  const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

  it('reports an absent auth.users row as ABSENT, never as "not banned"', () => {
    // The collapse this replaces made `--restore` answer ALREADY ACTIVE with
    // exit 0 for an identity that cannot sign in at all.
    expect(classifyBanState({ present: false, bannedUntil: null, deletedAt: null }, NOW))
      .toEqual({ present: false, deleted: false, bannedNow: false, bannedForFullTerm: false });
  });

  it('reads a null banned_until as not banned', () => {
    expect(classifyBanState({ present: true, bannedUntil: null, deletedAt: null }, NOW))
      .toMatchObject({ present: true, bannedNow: false, bannedForFullTerm: false });
  });

  it('reads an elapsed ban as not banned', () => {
    expect(classifyBanState({ present: true, bannedUntil: iso(-1000), deletedAt: null }, NOW))
      .toMatchObject({ bannedNow: false, bannedForFullTerm: false });
  });

  it('reads a live ban as banned now', () => {
    expect(classifyBanState({ present: true, bannedUntil: iso(60_000), deletedAt: null }, NOW))
      .toMatchObject({ bannedNow: true });
  });

  it('separates a short ban from this script\'s full-term revoke', () => {
    // A ban set by something else, about to lapse, must NOT read as "this
    // script already revoked them" — it would write no audit row and then
    // expire, leaving a signed-in admin and a ledger claiming a revoke.
    const short = classifyBanState(
      { present: true, bannedUntil: iso(REVOKE_HORIZON_MS - 1000), deletedAt: null }, NOW,
    );
    expect(short).toMatchObject({ bannedNow: true, bannedForFullTerm: false });

    const full = classifyBanState(
      { present: true, bannedUntil: iso(REVOKE_HORIZON_MS + 1000), deletedAt: null }, NOW,
    );
    expect(full).toMatchObject({ bannedNow: true, bannedForFullTerm: true });
  });

  it('surfaces a soft-deleted identity', () => {
    expect(classifyBanState(
      { present: true, bannedUntil: null, deletedAt: iso(-5000) }, NOW,
    )).toMatchObject({ present: true, deleted: true });
  });

  it('treats an unparseable banned_until as not banned rather than as banned', () => {
    expect(classifyBanState({ present: true, bannedUntil: 'not-a-date', deletedAt: null }, NOW))
      .toMatchObject({ bannedNow: false, bannedForFullTerm: false });
  });
});

// ── the guarded target seam (RT-04) ────────────────────────────────────────

describe('resolveRevokeTarget', () => {
  const stagingConfig = {
    supabaseUrl: stagingSupabaseUrl,
    databasePoolUrl: stagingDbUrl,
    supabaseServiceKey: 'unused',
    appUrl: 'https://staging.repworth.net',
  };

  it('describes a confirmed target', () => {
    expect(resolveRevokeTarget({ confirmRef: STAGING_REF, envMode: 'staging' }, stagingConfig))
      .toEqual({
        projectRef: STAGING_REF,
        supabaseHost: `${STAGING_REF}.supabase.co`,
        databaseTarget: stagingDbTarget,
      });
  });

  it('THROWS rather than describing an unconfirmed target', () => {
    // Deleting the assertMintTarget call inside main() was invisible to the
    // whole suite (red team RT-04): buildRevokeGuardInput's extraction pinned
    // the guard's INPUT while leaving the call site uncovered. This is the
    // test that fails when the guard call is removed.
    expect(() =>
      resolveRevokeTarget({ confirmRef: 'aaaabbbbccccddddeeee', envMode: 'staging' }, stagingConfig),
    ).toThrow(/resolves to project ref .*, not the confirmed/);
  });

  it('refuses a production target from a non-production selector', () => {
    expect(() =>
      resolveRevokeTarget({ confirmRef: PROD_REF, envMode: 'staging' }, {
        ...stagingConfig, supabaseUrl: prodSupabaseUrl, databasePoolUrl: prodDbUrl,
      }),
    ).toThrow(/PRODUCTION project ref/);
  });
});

// ── revokeAdmin ────────────────────────────────────────────────────────────

interface SupabaseDouble {
  client: SupabaseClient;
  updateUserById: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
}

// Deliberately synthetic. An earlier revision used the OWNER'S REAL staging
// `users.id`/`auth_id`, which the roster in the same PR takes care to mask
// (red team RT-09). A fixture never needs a live identifier.
const ADMIN_USER_ID = '11111111-2222-4333-8444-555555555555';
const ADMIN_AUTH_ID = '99999999-8888-4777-8666-555555555555';

function supabaseDouble(error: { message: string } | null = null): SupabaseDouble {
  const updateUserById = vi.fn(async () => ({
    data: { user: { id: ADMIN_AUTH_ID } },
    error,
  }));
  // Present on the double precisely so "never deletes a user" is assertable.
  const deleteUser = vi.fn(async () => ({ data: null, error: null }));
  const client = {
    auth: { admin: { updateUserById, deleteUser } },
  } as unknown as SupabaseClient;
  return { client, updateUserById, deleteUser };
}

/** A rejection queued into the FIFO must be pre-handled or Node warns. */
function queuedRejection(error: unknown): Promise<never> {
  const rejected = Promise.reject(error);
  rejected.catch(() => {});
  return rejected as Promise<never>;
}

const TEST_OPERATOR = {
  os_user: 'test-operator',
  host: 'test-host',
  provenance: 'unauthenticated_shell',
} as const;

const REVOKE_INPUT = {
  email: 'admin@repworth.net',
  action: 'revoke' as const,
  dryRun: false,
  operator: TEST_OPERATOR,
};

describe('revokeAdmin', () => {
  let harness: MockSqlHarness;
  let sql: Sql;
  let supabase: SupabaseDouble;

  beforeEach(() => {
    harness = createMockSql();
    sql = harness.mockSql as unknown as Sql;
    supabase = supabaseDouble();
  });

  /** Queue for: users-by-email lookup, auth-schema guard, ban-state read. */
  function queuePreflight(
    options: {
      role?: string;
      authId?: string | null;
      authSchema?: boolean;
      banned?: boolean;
      authRow?: boolean;
      deletedAt?: string | null;
    } = {},
  ): void {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{
        id: ADMIN_USER_ID,
        role: options.role ?? 'admin',
        auth_id: options.authId === undefined ? ADMIN_AUTH_ID : options.authId,
      }]),
    );
    const authSchema = options.authSchema ?? true;
    harness.sqlReturnQueue.push(mkTaggedResult([{ present: authSchema }]));
    if (!authSchema) return;
    if (options.authRow === false) {
      harness.sqlReturnQueue.push(mkTaggedResult([]));
      return;
    }
    harness.sqlReturnQueue.push(mkTaggedResult([{
      // Far past REVOKE_HORIZON_MS, matching the real 100-year ban.
      banned_until: options.banned
        ? new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toISOString()
        : null,
      deleted_at: options.deletedAt ?? null,
    }]));
  }

  it('refuses when there is no users row for the email, and calls no Auth API', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'users_row_missing' });
    expect(supabase.updateUserById).not.toHaveBeenCalled();
  });

  it('refuses when the users row exists but its role is not admin', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: 'owner-user-id', role: 'owner', auth_id: ADMIN_AUTH_ID }]),
    );

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'not_an_admin' });
    expect(supabase.updateUserById).not.toHaveBeenCalled();
  });

  it('refuses when the users row has no auth_id', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: ADMIN_USER_ID, role: 'admin', auth_id: null }]),
    );

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'auth_id_missing' });
    expect(supabase.updateUserById).not.toHaveBeenCalled();
  });

  it('a --dry-run runs every refusal check and writes nothing to Postgres or Supabase Auth', async () => {
    queuePreflight();

    const result = await revokeAdmin(sql, supabase.client, { ...REVOKE_INPUT, dryRun: true });

    expect(result).toMatchObject({
      status: 'would_change',
      action: 'revoke',
      banProbe: 'checked',
      identity: { userId: ADMIN_USER_ID, authId: ADMIN_AUTH_ID },
    });
    expect(supabase.updateUserById).not.toHaveBeenCalled();
    // Three reads and not one write: the lookup, the relation guard, the ban state.
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlCalls.every((call) => /^\s*SELECT/i.test(call.text))).toBe(true);
  });

  it('revoke bans the Auth identity with a ban_duration and never deletes a user', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([])); // the audit INSERT

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({
      status: 'changed',
      action: 'revoke',
      identity: { userId: ADMIN_USER_ID, authId: ADMIN_AUTH_ID },
    });
    expect(supabase.updateUserById).toHaveBeenCalledWith(ADMIN_AUTH_ID, {
      ban_duration: REVOKE_BAN_DURATION,
    });
    // The whole point of the owner's decision: `users` rows are FK targets.
    expect(supabase.deleteUser).not.toHaveBeenCalled();

    const audit = harness.sqlCalls.at(-1);
    expect(audit?.text).toMatch(/INSERT INTO admin_audit_log/i);
    expect(audit?.values).toContain('admin_revoked');
    expect(audit?.values).toContain(ADMIN_USER_ID);
    // No UPDATE or DELETE against `users` anywhere in the run.
    expect(harness.sqlCalls.some((call) => /\b(UPDATE|DELETE)\b/i.test(call.text))).toBe(false);
  });

  it('revoke is idempotent: an already-banned identity reports already_revoked and writes no audit row', async () => {
    queuePreflight({ banned: true });

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'unchanged', action: 'revoke' });
    expect(supabase.updateUserById).not.toHaveBeenCalled();
    expect(harness.sqlCalls.some((call) => /INSERT INTO admin_audit_log/i.test(call.text)))
      .toBe(false);
  });

  it('restore lifts the ban by sending ban_duration none', async () => {
    queuePreflight({ banned: true });
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    const result = await revokeAdmin(sql, supabase.client, {
      ...REVOKE_INPUT,
      action: 'restore',
    });

    expect(result).toMatchObject({ status: 'changed', action: 'restore' });
    expect(supabase.updateUserById).toHaveBeenCalledWith(ADMIN_AUTH_ID, {
      ban_duration: RESTORE_BAN_DURATION,
    });
    expect(harness.sqlCalls.at(-1)?.values).toContain('admin_restored');
  });

  it('restore is idempotent: an identity that is not banned reports already_active and writes no audit row', async () => {
    queuePreflight({ banned: false });

    const result = await revokeAdmin(sql, supabase.client, {
      ...REVOKE_INPUT,
      action: 'restore',
    });

    expect(result).toMatchObject({ status: 'unchanged', action: 'restore' });
    expect(supabase.updateUserById).not.toHaveBeenCalled();
  });

  it('attempts the transition when the ban-state probe is unavailable', async () => {
    // The local and CI test databases provision schema `auth` with no
    // `auth.users` relation, so `unavailable` must never read as "not banned"
    // for a restore, nor block a revoke.
    queuePreflight({ authSchema: false });
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'changed', action: 'revoke' });
    expect(supabase.updateUserById).toHaveBeenCalledTimes(1);
  });

  it('a failed Auth ban writes no audit row and reports failure', async () => {
    queuePreflight();
    const failing = supabaseDouble({ message: 'network unreachable' });

    const result = await revokeAdmin(sql, failing.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'failed', authOutcome: 'unknown' });
    expect(harness.sqlCalls.some((call) => /INSERT INTO admin_audit_log/i.test(call.text)))
      .toBe(false);
  });

  it('an audit write that fails after a committed ban reports the ban as standing and exits non-zero', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(queuedRejection(
      Object.assign(new Error('permission denied for table admin_audit_log'), { code: '42501' }),
    ));

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'audit_failed', action: 'revoke' });
    // The ban is the security-relevant half. It is NOT rolled back to keep the
    // ledger tidy — that would restore a login the operator asked to remove.
    expect(supabase.updateUserById).toHaveBeenCalledTimes(1);
    expect(supabase.deleteUser).not.toHaveBeenCalled();

    const target = {
      projectRef: STAGING_REF,
      supabaseHost: `${STAGING_REF}.supabase.co`,
      databaseTarget: stagingDbTarget,
    };
    const report = formatRevokeReport(result, target).join('\n');
    expect(report).toMatch(/COMMITTED/);
    expect(report).toMatch(/do NOT\s+re-run/);
    expect(report).toMatch(/admin_revoked/);
  });

  it('refuses when auth.users carries no row for the linked auth_id', async () => {
    queuePreflight({ authRow: false });

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'auth_identity_missing' });
    expect(supabase.updateUserById).not.toHaveBeenCalled();
  });

  it('refuses a restore when auth.users carries no row, instead of reporting already_active', async () => {
    // The regression this pins: absence collapsed into "not banned", so a
    // restore of the ONLY production admin would print ALREADY ACTIVE and
    // exit 0 while that admin could not sign in.
    queuePreflight({ authRow: false });

    const result = await revokeAdmin(sql, supabase.client, { ...REVOKE_INPUT, action: 'restore' });

    expect(result).toMatchObject({ status: 'refused', reason: 'auth_identity_missing' });
    expect(supabase.updateUserById).not.toHaveBeenCalled();
  });

  it('refuses a soft-deleted Auth identity', async () => {
    queuePreflight({ deletedAt: new Date().toISOString() });

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'auth_identity_deleted' });
    expect(supabase.updateUserById).not.toHaveBeenCalled();
  });

  it('re-applies the revoke over a short pre-existing ban', async () => {
    // Inside the horizon: banned now, but not by THIS script. Re-applying is
    // what stops a lapsing ban from being recorded as a completed revoke.
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: ADMIN_USER_ID, role: 'admin', auth_id: ADMIN_AUTH_ID }]),
    );
    harness.sqlReturnQueue.push(mkTaggedResult([{ present: true }]));
    harness.sqlReturnQueue.push(mkTaggedResult([{
      banned_until: new Date(Date.now() + 60_000).toISOString(),
      deleted_at: null,
    }]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    const result = await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    expect(result).toMatchObject({ status: 'changed', action: 'revoke' });
    expect(supabase.updateUserById).toHaveBeenCalledWith(ADMIN_AUTH_ID, {
      ban_duration: '876000h',
    });
  });

  it('records the operator provenance on the audit row', async () => {
    // Dropping `operator` from the payload survived the whole suite (red team
    // RT-06): a CLI has no authenticated actor, so the shell's own claim about
    // itself, recorded WITH its provenance, is the only attribution there is.
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    await revokeAdmin(sql, supabase.client, REVOKE_INPUT);

    const payload = harness.sqlCalls.at(-1)?.values.find(
      (v): v is Record<string, unknown> =>
        typeof v === 'object' && v !== null && 'attribution' in v,
    );
    expect(payload).toMatchObject({
      operator: TEST_OPERATOR,
      attribution: 'bootstrap_self_actor',
      actor_is_subject: true,
      users_row_preserved: true,
      ban_duration: '876000h',
    });
  });

  it('lowercases and trims the email before the lookup', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    await revokeAdmin(sql, supabase.client, { ...REVOKE_INPUT, email: '  Admin@RepWorth.NET ' });

    expect(harness.sqlCalls[0]?.values).toContain('admin@repworth.net');
    // Normalizing the INPUT is only half of it: `users.email` is stored as
    // typed, so dropping `lower()` from the column side matches nothing and the
    // script refuses a real admin. Dropping it survived the suite (RT-07).
    expect(harness.sqlCalls[0]?.text).toMatch(/lower\(email\)/i);
  });
});

// ── the report ─────────────────────────────────────────────────────────────

describe('formatRevokeReport', () => {
  const target = {
    projectRef: STAGING_REF,
    supabaseHost: `${STAGING_REF}.supabase.co`,
    databaseTarget: stagingDbTarget,
  };
  const identity = { userId: ADMIN_USER_ID, authId: ADMIN_AUTH_ID };

  it('leads with the TARGET line on every outcome', () => {
    const results: RevokeAdminResult[] = [
      { status: 'changed', action: 'revoke', identity },
      { status: 'unchanged', action: 'restore', identity },
      { status: 'would_change', action: 'revoke', identity, banProbe: 'unavailable' },
      { status: 'refused', reason: 'not_an_admin', detail: 'x' },
      { status: 'failed', detail: 'x', authOutcome: 'unknown' },
      { status: 'audit_failed', action: 'restore', identity, detail: 'x' },
    ];
    for (const result of results) {
      expect(formatRevokeReport(result, target)[0]).toBe(formatRevokeTarget(target));
    }
  });

  it('the report never prints the service key, a password, or a recovery link', () => {
    const results: RevokeAdminResult[] = [
      { status: 'changed', action: 'revoke', identity },
      { status: 'changed', action: 'restore', identity },
      { status: 'unchanged', action: 'revoke', identity },
      { status: 'would_change', action: 'revoke', identity, banProbe: 'checked' },
      { status: 'audit_failed', action: 'revoke', identity, detail: 'boom' },
    ];
    for (const result of results) {
      const report = formatRevokeReport(result, target).join('\n');
      expect(report).not.toMatch(/token_hash|password|service_role|eyJ/i);
      expect(report).not.toMatch(/\/api\/auth\/callback/);
    }
  });

  it('says the users row was left in place on a revoke, and names the JWT residual', () => {
    const report = formatRevokeReport({ status: 'changed', action: 'revoke', identity }, target)
      .join('\n');
    expect(report).toMatch(/REVOKED/);
    expect(report).toMatch(/users row was left in place/);
    // The bounded residual is stated, not hidden: a ban blocks sign-in and
    // refresh, not an already-issued access token.
    expect(report).toMatch(/until it expires/);
  });

  it('names the right unchanged state for each direction', () => {
    // Swapping the two lines survived the suite (red team RT-08), and they say
    // opposite things about whether an admin can sign in.
    const revoked = formatRevokeReport(
      { status: 'unchanged', action: 'revoke', identity }, target,
    ).join('\n');
    expect(revoked).toMatch(/ALREADY REVOKED/);
    expect(revoked).not.toMatch(/ALREADY ACTIVE/);

    const active = formatRevokeReport(
      { status: 'unchanged', action: 'restore', identity }, target,
    ).join('\n');
    expect(active).toMatch(/ALREADY ACTIVE/);
    expect(active).not.toMatch(/ALREADY REVOKED/);
  });

  it('does not claim the proxy enrols an unenrolled admin on restore', () => {
    // ADR 0025 § Consequences: the form is lenient, so an unenrolled identity
    // signs in at aal1 and is never prompted. The report used to say otherwise.
    const report = formatRevokeReport(
      { status: 'changed', action: 'restore', identity }, target,
    ).join('\n');
    expect(report).toMatch(/must\s+enrol manually at \/admin\/security/);
    expect(report).not.toMatch(/enrols one if it has none/);
  });

  it('warns when a dry run could not read the ban state', () => {
    const report = formatRevokeReport(
      { status: 'would_change', action: 'revoke', identity, banProbe: 'unavailable' },
      target,
    ).join('\n');
    expect(report).toMatch(/auth\.users is not readable/);
  });
});
