// Unit eval for `scripts/mint-admin.ts` (#1178, tracer T1 — RED before T2/T3).
//
// Titles 1-27 are VERBATIM from `.feature/intake.json` `tests_to_add`. The
// three live-DB titles (28-30) are in the `.integration.test.ts` sibling,
// because only a real database proves the transaction boundary and the
// `admin_audit_log.actor_user_id` foreign key.
//
// WHY THIS FILE LIVES UNDER `scripts/ci/__tests__/`. `vitest.config.ts`'s
// include list has `scripts/ci/**/__tests__/**/*.test.ts` and no
// `scripts/__tests__/` entry, so this is where every `scripts/*.ts` module is
// tested today — `staging-guard`, `wedge-repro`, `burst-drill-load` and
// `health-bundle-differential` all sit at the `scripts/` root with their
// suites here.
//
// `scripts/mint-admin.ts` is import-safe (`runDirectCli` only calls `main()`
// when Node invoked that module directly), so importing it here runs nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../worker/__tests__/helpers/mock-sql';
import {
  assertMintTarget,
  buildAdminRecoveryUrl,
  formatMintReport,
  mintAdmin,
  MintAdminUsageError,
  parseMintAdminArgs,
  resolveMintEnv,
  type MintAdminResult,
} from '../../mint-admin';

/**
 * `users.id` has no default (002_prompt2_fixes.sql:31), so the script supplies
 * it with `randomUUID()`. Pinning that value is what lets the reconciliation
 * cases assert the row-IDENTITY rule — "a row exists for this auth_id" was the
 * wrong success test (plan §6 G2). Only `randomUUID` is replaced; the rest of
 * node:crypto is the real module.
 */
const FIXED_USER_ID = '99999999-8888-4777-8666-555555555555';
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => FIXED_USER_ID };
});

// The real refs, from scripts/staging-guard.ts. Project refs are non-secret
// discriminators (they appear in public connection hosts), which is why that
// module hardcodes them too.
const PROD_REF = 'udeyaqnvpojbwgoaxwdg';
const STAGING_REF = 'kubdiqdhqbhwmqfditeg';
const OTHER_REF = 'aaaabbbbccccddddeeee';

const stagingSupabaseUrl = `https://${STAGING_REF}.supabase.co`;
const stagingDbTarget = `postgres.${STAGING_REF}@aws-0-eu-west-2.pooler.supabase.com:6543`;

// ── the CLI contract + the target guard (T2) ────────────────────────────────

describe('parseMintAdminArgs', () => {
  it('parses email, name and the dry-run flag', () => {
    const args = parseMintAdminArgs([
      '--email', 'Admin@RepWorth.net',
      '--name', 'Admin Person',
      '--confirm-ref', STAGING_REF,
      '--env', 'staging',
      '--dry-run',
    ]);

    expect(args).toEqual({
      email: 'admin@repworth.net',
      name: 'Admin Person',
      confirmRef: STAGING_REF,
      envMode: 'staging',
      dryRun: true,
    });
  });

  it('lowercases and trims the email before use', () => {
    const args = parseMintAdminArgs([
      '--email', '  Mixed.Case@RepWorth.NET  ',
      '--name', 'Admin Person',
      '--confirm-ref', STAGING_REF,
    ]);

    expect(args.email).toBe('mixed.case@repworth.net');
    // Casing must not be able to create a second identity for one human: the
    // DB uniques are per-VALUE (001_initial_schema.sql:47,53).
    expect(args.envMode).toBe('ambient');
    expect(args.dryRun).toBe(false);
  });

  it('refuses when --confirm-ref is missing', () => {
    expect(() =>
      parseMintAdminArgs(['--email', 'admin@repworth.net', '--name', 'Admin Person']),
    ).toThrow(MintAdminUsageError);
  });

  it('refuses when --email or --name is missing', () => {
    expect(() =>
      parseMintAdminArgs(['--name', 'Admin Person', '--confirm-ref', STAGING_REF]),
    ).toThrow(MintAdminUsageError);
    expect(() =>
      parseMintAdminArgs(['--email', 'admin@repworth.net', '--confirm-ref', STAGING_REF]),
    ).toThrow(MintAdminUsageError);
  });
});

describe('assertMintTarget', () => {
  it('refuses when the Supabase host does not contain the confirmed project ref', () => {
    expect(() =>
      assertMintTarget({
        supabaseUrl: `https://${OTHER_REF}.supabase.co`,
        dbTarget: stagingDbTarget,
        confirmRef: STAGING_REF,
      }),
    ).toThrow(/supabase/i);
  });

  it('refuses when the database target does not contain the confirmed project ref', () => {
    // The mismatched-credential-pair case: staging Supabase URL beside another
    // project's database. Exact equality on PARSED refs is what catches it.
    expect(() =>
      assertMintTarget({
        supabaseUrl: stagingSupabaseUrl,
        dbTarget: `postgres.${OTHER_REF}@aws-0-eu-west-2.pooler.supabase.com:6543`,
        confirmRef: STAGING_REF,
      }),
    ).toThrow(/database/i);
  });

  it('refuses a confirmed ref that is not a full Supabase project ref', () => {
    // `supabase` is a substring of BOTH ordinary targets, so a substring test
    // would confirm nothing at all (plan §6 F2).
    for (const partial of ['supabase', STAGING_REF.slice(0, 8), '']) {
      expect(() =>
        assertMintTarget({
          supabaseUrl: stagingSupabaseUrl,
          dbTarget: stagingDbTarget,
          confirmRef: partial,
        }),
      ).toThrow();
    }
  });

  it('refuses a production project ref outright', () => {
    expect(() =>
      assertMintTarget({
        supabaseUrl: `https://${PROD_REF}.supabase.co`,
        dbTarget: `postgres.${PROD_REF}@aws-0-eu-west-2.pooler.supabase.com:6543`,
        confirmRef: PROD_REF,
      }),
    ).toThrow(/produc/i);

    // The denylist beats the flag in BOTH directions: a staging confirmation
    // may not authorise a production-looking target either.
    expect(() =>
      assertMintTarget({
        supabaseUrl: `https://${PROD_REF}.supabase.co`,
        dbTarget: stagingDbTarget,
        confirmRef: STAGING_REF,
      }),
    ).toThrow(/produc/i);
  });

  it('accepts a staging target whose parsed refs both equal the confirmation', () => {
    expect(() =>
      assertMintTarget({
        supabaseUrl: stagingSupabaseUrl,
        dbTarget: stagingDbTarget,
        confirmRef: STAGING_REF,
      }),
    ).not.toThrow();
  });
});

describe('resolveMintEnv', () => {
  it('maps STAGING_-prefixed variables onto their bare names', () => {
    const resolved = resolveMintEnv(
      {
        STAGING_SUPABASE_URL: stagingSupabaseUrl,
        STAGING_SUPABASE_SERVICE_KEY: 'service-key-placeholder',
        STAGING_DATABASE_POOL_URL: 'postgres://user:pw@host:6543/postgres',
        STAGING_NEXT_PUBLIC_APP_URL: 'https://staging.repworth.net',
        UNRELATED: 'ignored',
      },
      'STAGING_',
    );

    expect(resolved.SUPABASE_URL).toBe(stagingSupabaseUrl);
    expect(resolved.SUPABASE_SERVICE_KEY).toBe('service-key-placeholder');
    expect(resolved.DATABASE_POOL_URL).toBe('postgres://user:pw@host:6543/postgres');
    expect(resolved.NEXT_PUBLIC_APP_URL).toBe('https://staging.repworth.net');
  });

  it('falls back to STAGING_NEXT_PUBLIC_SUPABASE_URL when STAGING_SUPABASE_URL is empty', () => {
    // This repo's real .env.staging.local leaves STAGING_SUPABASE_URL empty —
    // docs/runbooks/mfa-factor-reset.md records the same fallback for the
    // break-glass procedure.
    const resolved = resolveMintEnv(
      {
        STAGING_SUPABASE_URL: '',
        STAGING_NEXT_PUBLIC_SUPABASE_URL: stagingSupabaseUrl,
        STAGING_SUPABASE_SERVICE_KEY: 'service-key-placeholder',
      },
      'STAGING_',
    );

    expect(resolved.SUPABASE_URL).toBe(stagingSupabaseUrl);
  });
});

describe('buildAdminRecoveryUrl', () => {
  it('builds the admin recovery URL from hashed_token and the admin reset path', () => {
    const url = new URL(
      buildAdminRecoveryUrl('https://staging.repworth.net', 'hashed-token+value/x'),
    );

    expect(url.origin).toBe('https://staging.repworth.net');
    expect(url.pathname).toBe('/api/auth/callback');
    expect(url.searchParams.get('token_hash')).toBe('hashed-token+value/x');
    expect(url.searchParams.get('type')).toBe('recovery');
    // flow=admin routes a failure to /admin/login, and next is the admin reset
    // page resolveCallbackDestination allow-lists by name.
    expect(url.searchParams.get('flow')).toBe('admin');
    expect(url.searchParams.get('next')).toBe('/admin/reset-password');
  });
});

// ── mintAdmin (T3) ─────────────────────────────────────────────────────────

interface SupabaseDouble {
  client: SupabaseClient;
  createUser: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
  generateLink: ReturnType<typeof vi.fn>;
}

const NEW_AUTH_ID = '11111111-2222-4333-8444-555555555555';

function supabaseDouble(): SupabaseDouble {
  const createUser = vi.fn(async () => ({
    data: { user: { id: NEW_AUTH_ID } },
    error: null,
  }));
  const deleteUser = vi.fn(async () => ({ data: null, error: null }));
  const generateLink = vi.fn(async () => ({
    data: { properties: { hashed_token: 'hashed-token' } },
    error: null,
  }));
  const client = {
    auth: { admin: { createUser, deleteUser, generateLink } },
  } as unknown as SupabaseClient;
  return { client, createUser, deleteUser, generateLink };
}

/** A rejection queued into the FIFO must be pre-handled or Node warns. */
function queuedRejection(error: unknown): Promise<never> {
  const rejected = Promise.reject(error);
  rejected.catch(() => {});
  return rejected as Promise<never>;
}

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`postgres error ${code}`), { code });
}

const MINT_INPUT = {
  email: 'admin@repworth.net',
  name: 'Admin Person',
  appUrl: 'https://staging.repworth.net',
  dryRun: false,
};

describe('mintAdmin', () => {
  let harness: MockSqlHarness;
  let sql: Sql;
  let supabase: SupabaseDouble;

  beforeEach(() => {
    harness = createMockSql();
    sql = harness.mockSql as unknown as Sql;
    supabase = supabaseDouble();
  });

  /** Queue for: users-by-email pre-check, auth-schema guard, auth-user probe. */
  function queuePreflight(options: { authSchema?: boolean; authRow?: boolean } = {}): void {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ present: options.authSchema ?? true }]),
    );
    if (options.authSchema ?? true) {
      harness.sqlReturnQueue.push(
        mkTaggedResult(options.authRow ? [{ auth_user_id: 'pre-existing-auth-id' }] : []),
      );
    }
  }

  /** Queue for the transaction body: email re-check, auth_id check, INSERT, audit INSERT. */
  function queueTransaction(): void {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
  }

  it('refuses when a users row already exists for the email', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: 'existing-user-id', role: 'owner' }]),
    );

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'users_row_exists' });
    // The pre-check runs BEFORE the Auth call precisely so the common refusal
    // creates nothing to compensate for.
    expect(supabase.createUser).not.toHaveBeenCalled();
    expect(supabase.deleteUser).not.toHaveBeenCalled();
  });

  it('refuses when an auth user already exists for the email', async () => {
    queuePreflight({ authRow: true });

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'auth_user_exists' });
    expect(supabase.createUser).not.toHaveBeenCalled();
  });

  it('refuses when a users row already exists for the resolved auth id', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));                       // tx email re-check
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'other-user-id' }])); // tx auth_id check
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'other-user-id' }])); // reconciliation

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'auth_id_taken' });
  });

  it('returns a refusal when the in-transaction email re-check fires', async () => {
    // The race the pre-check cannot close: another writer inserts the row
    // between the pre-check and the INSERT. The in-transaction re-check is
    // serialized against the INSERT, so it names the refusal instead of
    // surfacing a raw 23505 through the reconciliation path.
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'raced-user-id', role: 'admin' }]));
    harness.sqlReturnQueue.push(mkTaggedResult([])); // reconciliation: no row for our auth_id

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'users_row_exists' });
    // A refusal we raised ourselves is a CONFIRMED rollback, and no other row
    // holds this auth id, so the orphaned Auth user is cleaned up.
    expect(supabase.deleteUser).toHaveBeenCalledWith(NEW_AUTH_ID);
  });

  it('deletes the created auth user when the mint transaction fails', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    // 23514 — a server-raised, statement-level rejection: Postgres processed it
    // and postgres.js rolled back, so the rollback is CONFIRMED.
    harness.sqlReturnQueue.push(queuedRejection(pgError('23514')));
    harness.sqlReturnQueue.push(mkTaggedResult([])); // reconciliation: no row

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result.status).toBe('failed');
    expect(supabase.deleteUser).toHaveBeenCalledWith(NEW_AUTH_ID);
  });

  it('does not delete the auth user when the mint transaction committed despite an error', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    // The audit INSERT "fails" with a lost COMMIT acknowledgement.
    harness.sqlReturnQueue.push(queuedRejection(pgError('08006')));
    // Reconciliation finds OUR row — the COMMIT landed after all.
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: FIXED_USER_ID }]));

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'minted', userId: FIXED_USER_ID });
    expect(supabase.deleteUser).not.toHaveBeenCalled();
  });

  it('preserves the auth user when the transaction outcome is ambiguous', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    // No SQLSTATE at all — a client/socket failure. The transaction may still
    // be in flight, so an absent row proves nothing.
    harness.sqlReturnQueue.push(queuedRejection(new Error('write CONNECTION_CLOSED')));
    harness.sqlReturnQueue.push(mkTaggedResult([])); // reconciliation: no row (yet)

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'failed', orphanAuthId: NEW_AUTH_ID });
    expect(supabase.deleteUser).not.toHaveBeenCalled();
  });

  it('does not delete the auth user when the post-failure reconciliation read also fails', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(queuedRejection(pgError('23514')));
    harness.sqlReturnQueue.push(queuedRejection(new Error('reconciliation read failed')));

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'failed', orphanAuthId: NEW_AUTH_ID });
    expect(supabase.deleteUser).not.toHaveBeenCalled();
  });

  it('treats a reconciled row with a different id as a failure, not a mint', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(queuedRejection(pgError('23514')));
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'somebody-elses-user-id' }]));

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result.status).toBe('failed');
    expect(supabase.deleteUser).not.toHaveBeenCalled();
  });

  it('auth_id_taken returns refused without deleting the linked auth identity', async () => {
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));                       // tx email re-check
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'other-user-id' }])); // tx auth_id check
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'other-user-id' }])); // reconciliation

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'auth_id_taken' });
    // Confirmed rollback proves only that THIS transaction did not commit. A
    // row is linked to this identity, so deleting it would revoke a different
    // admin's login.
    expect(supabase.deleteUser).not.toHaveBeenCalled();
  });

  it('reports the orphan auth id when the compensating delete also fails', async () => {
    supabase.deleteUser.mockResolvedValueOnce({
      data: null,
      error: { message: 'delete failed' },
    });
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(queuedRejection(pgError('23514')));
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'failed', orphanAuthId: NEW_AUTH_ID });
  });

  it('dry run performs the refusal checks and writes nothing', async () => {
    queuePreflight();

    const result = await mintAdmin(sql, supabase.client, { ...MINT_INPUT, dryRun: true });

    expect(result).toEqual({ status: 'would_mint', authProbe: 'checked' });
    expect(supabase.createUser).not.toHaveBeenCalled();
    expect(supabase.generateLink).not.toHaveBeenCalled();
    expect(harness.mockSql.begin).not.toHaveBeenCalled();
    expect(harness.sqlCalls.every((call) => /^\s*SELECT/i.test(call.text))).toBe(true);
  });

  it('refuses in dry run when an auth identity already exists for the email', async () => {
    // The gap plan round 1 found: a dry run that skips the Auth side reports
    // would_mint for a mint the real run will refuse.
    queuePreflight({ authRow: true });

    const result = await mintAdmin(sql, supabase.client, { ...MINT_INPUT, dryRun: true });

    expect(result).toMatchObject({ status: 'refused', reason: 'auth_user_exists' });
  });

  it('reports the auth probe as unavailable when auth.users is absent', async () => {
    // The local + CI test databases create schema `auth` with auth.uid() and no
    // auth.users (scripts/ci/test-db-bootstrap.sql). Unavailable is reported,
    // never silently treated as "no such identity".
    queuePreflight({ authSchema: false });

    const result = await mintAdmin(sql, supabase.client, { ...MINT_INPUT, dryRun: true });

    expect(result).toEqual({ status: 'would_mint', authProbe: 'unavailable' });
  });

  it('never prints a password', async () => {
    queuePreflight();
    queueTransaction();

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);
    expect(result.status).toBe('minted');

    // Structural, not a redaction rule: no password is ever generated, so
    // there is none to leak.
    const [createArgs] = supabase.createUser.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(createArgs)).not.toContain('password');

    const report = formatMintReport(result, {
      projectRef: STAGING_REF,
      supabaseHost: `${STAGING_REF}.supabase.co`,
      databaseTarget: stagingDbTarget,
    }).join('\n');
    expect(report).not.toMatch(/password/i);
    expect(report).toContain('/api/auth/callback');
  });

  it('records the mint through writeAdminAuditLog with the new admin as its own actor', async () => {
    queuePreflight();
    queueTransaction();

    const result = (await mintAdmin(sql, supabase.client, MINT_INPUT)) as Extract<
      MintAdminResult,
      { status: 'minted' }
    >;

    expect(result.status).toBe('minted');
    const auditCall = harness.sqlCalls.find((call) =>
      call.text.includes('INSERT INTO admin_audit_log'),
    );
    expect(auditCall).toBeDefined();
    // In the SAME transaction as the users INSERT — which is also what makes
    // the NOT NULL actor_user_id FK resolvable without a migration.
    expect(auditCall?.inTransaction).toBe(true);
    expect(auditCall?.values).toContain(result.userId);
    expect(auditCall?.values).toContain('admin_minted');
  });
});
