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
  buildAdminRecoveryUrl,
  confirmsRollback,
  formatMintReport,
  formatMintTarget,
  mintAdmin,
  MintAdminUsageError,
  MintRefusal,
  parseMintAdminArgs,
  readMintConfig,
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
const STAGING_REF = 'kubdiqdhqbhwmqfditeg';

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

  it('treats a flag-shaped value as a missing value, not as the value', () => {
    // `--email --dry-run` used to parse the email as "--dry-run" and pass the
    // required-flag checks (review finding S3). Reverting that guard survived
    // the whole suite until this test existed (red team RT2-01).
    expect(() =>
      parseMintAdminArgs(['--email', '--dry-run', '--name', 'A', '--confirm-ref', STAGING_REF]),
    ).toThrow(/--email is required/);
    expect(() =>
      parseMintAdminArgs(['--email', 'a@b.net', '--name', '--dry-run', '--confirm-ref', STAGING_REF]),
    ).toThrow(/--name is required/);
    expect(() =>
      parseMintAdminArgs(['--email', 'a@b.net', '--name', 'A', '--confirm-ref', '--dry-run']),
    ).toThrow(/--confirm-ref is required/);
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

const TEST_OPERATOR = {
  os_user: 'test-operator',
  host: 'test-host',
  provenance: 'unauthenticated_shell',
} as const;

const MINT_INPUT = {
  email: 'admin@repworth.net',
  name: 'Admin Person',
  appUrl: 'https://staging.repworth.net',
  dryRun: false,
  operator: TEST_OPERATOR,
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
    // there is none to leak. The key set is asserted EXACTLY — `not.toContain`
    // alone would still pass if a `password` key were spelled differently, and
    // an exact set also fails if any other credential-shaped field is added.
    const [createArgs] = supabase.createUser.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(createArgs).sort()).toEqual([
      'email',
      'email_confirm',
      'user_metadata',
    ]);

    const report = formatMintReport(result, {
      projectRef: STAGING_REF,
      supabaseHost: `${STAGING_REF}.supabase.co`,
      databaseTarget: stagingDbTarget,
    }).join('\n');
    // Field-shaped, because the recovery link legitimately carries the
    // `/admin/reset-password` path: a bare /password/ matches that and would
    // fail on correct output. `password=` / `password:` is what a leak looks
    // like.
    expect(report).not.toMatch(/password\s*[:=]/i);
    expect(report).toContain('/api/auth/callback');
    expect(report).toContain('Treat it as a credential');
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

    // POSITIONAL, not `toContain` (review finding S5): writeAdminAuditLog binds
    // (uuidv7 id, actorUserId, eventType, payload, entityType, entityId, …), so
    // `entity_id` alone satisfies a membership check and a mutant binding a
    // different actor survives it.
    expect(auditCall?.values[1]).toBe(result.userId);
    expect(auditCall?.values[2]).toBe('admin_minted');

    // `inTransaction` is a TIME-WINDOW flag, not a connection identity (red
    // team RT-06): it is stamped on any query awaited while begin() is open.
    // Ordering is the part that carries the FK: the users INSERT must precede
    // the audit INSERT, or actor_user_id references a row that does not exist
    // yet. The live-DB sibling proves the FK itself.
    const texts = harness.sqlCalls.map((call) => call.text);
    const usersInsertAt = texts.findIndex((t) => t.includes('INSERT INTO users'));
    const auditInsertAt = texts.findIndex((t) => t.includes('INSERT INTO admin_audit_log'));
    expect(usersInsertAt).toBeGreaterThanOrEqual(0);
    expect(auditInsertAt).toBeGreaterThan(usersInsertAt);

    // A3 — the row records that actor and subject are the same identity, and
    // who ran the script, so a later reader is not misled into thinking this
    // admin acted.
    const payload = auditCall?.values[3] as Record<string, unknown>;
    expect(payload).toMatchObject({
      source: 'scripts/mint-admin.ts',
      actor_is_subject: true,
      attribution: 'bootstrap_self_actor',
      operator: TEST_OPERATOR,
    });
  });

  // ── oracles the red-team pass found missing ──────────────────────────────

  // The plan's SECOND independent closer, and on any database without an
  // `auth.users` relation it is the ONLY one (red team RT-01).
  //
  // ONE SIGNAL PER CASE, deliberately. A single fixture carrying both
  // `code: 'email_exists'` AND an "already registered" message cannot tell the
  // two arms of `isDuplicateEmailError` apart, so deleting either one survives
  // (red team RT2-04) — the same "looks strengthened, cannot discriminate"
  // shape as RT-05.
  it.each([
    ['the email_exists code alone', { code: 'email_exists', status: 400, message: 'nope' }],
    ['the message alone', { code: 'unexpected_failure', status: 500, message: 'User already registered' }],
  ])('refuses when the Auth API itself reports a duplicate email — %s', async (_label, error) => {
    supabase.createUser.mockResolvedValueOnce({ data: { user: null }, error });
    queuePreflight({ authSchema: false });

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'refused', reason: 'auth_user_exists' });
    expect(harness.mockSql.begin).not.toHaveBeenCalled();
  });

  it('does not report a duplicate for a non-duplicate 422', async () => {
    // 422 alone is GoTrue's generic validation status. Reporting
    // `email_address_invalid` as auth_user_exists sends the operator to a
    // runbook section about an identity that does not exist (review finding S2).
    supabase.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: { code: 'email_address_invalid', status: 422, message: 'Unable to validate email' },
    });
    queuePreflight({ authSchema: false });

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result.status).toBe('failed');
  });

  it('reports an unknown Auth outcome when createUser fails, never absence', async () => {
    // A transport failure can abort the response AFTER the identity was
    // written, so "nothing was written" is a claim the script cannot make
    // (review finding A2).
    supabase.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: { code: 'unexpected_failure', status: 500, message: 'socket hang up' },
    });
    queuePreflight({ authSchema: false });

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result.status).toBe('failed');
    expect((result as { detail: string }).detail).toMatch(/UNKNOWN/);
    expect((result as { detail: string }).detail).not.toMatch(/nothing was written/i);
  });

  it('treats createUser returning no user and no error as an unknown outcome', async () => {
    // A locked intake edge case with no oracle until now (red team RT-02);
    // hosted Auth really does return this shape, which is why
    // src/lib/auth/provision-auth-user.ts carries a recovery path for it.
    supabase.createUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    queuePreflight();

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({ status: 'failed', orphanAuthId: null });
    expect((result as { detail: string }).detail).toMatch(/UNKNOWN/);
    expect(harness.mockSql.begin).not.toHaveBeenCalled();
  });

  it('reports a committed mint with no link when generateLink fails', async () => {
    // A locked intake edge case with no oracle until now (red team RT-03). A
    // regression here tells an operator to re-run a mint that already
    // committed, which is how a second identity for one human gets created.
    supabase.generateLink.mockResolvedValueOnce({
      data: { properties: null },
      error: { message: 'rate limited' },
    });
    queuePreflight();
    queueTransaction();

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result).toMatchObject({
      status: 'minted',
      recoveryUrl: null,
      recoveryLinkError: 'rate limited',
    });
    expect(supabase.deleteUser).not.toHaveBeenCalled();
  });

  it('propagates a rejection from the real audit writer without reporting a mint', async () => {
    // The direction the live-DB sibling cannot reach: the audit INSERT ITSELF
    // rejecting (review finding S6). Its FK is satisfied by construction on a
    // real database, so only a mock can make the writer's own statement fail.
    queuePreflight();
    harness.sqlReturnQueue.push(mkTaggedResult([]));  // tx email re-check
    harness.sqlReturnQueue.push(mkTaggedResult([]));  // tx auth_id check
    harness.sqlReturnQueue.push(mkTaggedResult([]));  // users INSERT
    harness.sqlReturnQueue.push(queuedRejection(pgError('23503')));  // audit INSERT
    harness.sqlReturnQueue.push(mkTaggedResult([]));  // reconciliation: no row

    const result = await mintAdmin(sql, supabase.client, MINT_INPUT);

    expect(result.status).toBe('failed');
    expect(supabase.deleteUser).toHaveBeenCalledWith(NEW_AUTH_ID);
  });
});

// ── confirmsRollback, the asymmetric safety property (red team RT-04) ───────

describe('confirmsRollback', () => {
  // The mutant that adds class 08 to the confirmed set survived the whole
  // suite, because the only ambiguity case injected a code-less error. These
  // pin the boundary directly, class by class.
  it.each([
    ['23505', 'unique_violation'],
    ['23503', 'foreign_key_violation'],
    ['23514', 'check_violation'],
    ['22001', 'string_data_right_truncation'],
    ['42703', 'undefined_column'],
  ])('confirms a rollback for %s (%s)', (code) => {
    expect(confirmsRollback(pgError(code))).toBe(true);
  });

  it.each([
    ['08006', 'connection_failure'],
    ['08007', 'transaction_resolution_unknown — the ambiguous COMMIT outcome'],
    ['08003', 'connection_does_not_exist'],
    ['57014', 'query_canceled — statement timeout'],
    ['57P01', 'admin_shutdown'],
    ['XX000', 'internal_error'],
    ['40001', 'serialization_failure'],
  ])('never confirms a rollback for %s (%s)', (code) => {
    expect(confirmsRollback(pgError(code))).toBe(false);
  });

  it('never confirms a rollback for a client-side error with no SQLSTATE', () => {
    // postgres.js gives connection failures a NON-numeric code
    // (CONNECTION_CLOSED, ECONNRESET) — node_modules/postgres/src/errors.js.
    expect(confirmsRollback(Object.assign(new Error('x'), { code: 'CONNECTION_CLOSED' }))).toBe(false);
    expect(confirmsRollback(new Error('write ECONNRESET'))).toBe(false);
    expect(confirmsRollback(null)).toBe(false);
    expect(confirmsRollback(undefined)).toBe(false);
    expect(confirmsRollback('23505')).toBe(false);
  });

  it('confirms a rollback for a refusal this script raised', () => {
    // Raised inside the transaction body before any COMMIT is issued, so the
    // rollback is certain by construction.
    expect(confirmsRollback(new MintRefusal('users_row_exists', 'x'))).toBe(true);
  });
});

// ── the operator-facing report (red team RT-09) ────────────────────────────

describe('formatMintReport', () => {
  const target = {
    projectRef: STAGING_REF,
    supabaseHost: `${STAGING_REF}.supabase.co`,
    databaseTarget: stagingDbTarget,
  };

  it('leads every report with the TARGET line', () => {
    // DISTINCT values per field, and the labels asserted explicitly. Comparing
    // the first report line to `formatMintTarget(target)` is a tautology, and a
    // fixture whose three fields all contain STAGING_REF cannot see `project=`
    // deleted from the line (red team RT2-02).
    const distinct = {
      projectRef: 'aaaaaaaaaaaaaaaaaaaa',
      supabaseHost: 'bbbbbbbbbbbbbbbbbbbb.supabase.co',
      databaseTarget: 'postgres.cccccccccccccccccccc@pooler.example.com:6543',
    };
    const line = formatMintTarget(distinct);

    expect(line).toBe(
      'TARGET: project=aaaaaaaaaaaaaaaaaaaa ' +
        'supabase=bbbbbbbbbbbbbbbbbbbb.supabase.co ' +
        'db=postgres.cccccccccccccccccccc@pooler.example.com:6543',
    );
    // It must never carry a password: the descriptor is password-free by
    // construction (describeConnectionTarget), and this is the line printed
    // before every run.
    expect(line).not.toMatch(/:[^@\s]*@/);
    expect(formatMintReport({ status: 'would_mint', authProbe: 'checked' }, distinct)[0]).toBe(line);
  });

  it('warns loudly when a dry run could not verify the Auth half', () => {
    const report = formatMintReport(
      { status: 'would_mint', authProbe: 'unavailable' },
      target,
    ).join('\n');
    expect(report).toMatch(/WARNING/);
    expect(report).toMatch(/could NOT/);
  });

  it('tells the operator to re-issue a link, not re-run, when the mint committed without one', () => {
    const report = formatMintReport(
      {
        status: 'minted',
        userId: 'u1',
        authId: 'a1',
        recoveryUrl: null,
        recoveryLinkError: 'rate limited',
      },
      target,
    ).join('\n');
    expect(report).toMatch(/COMMITTED/);
    expect(report).toMatch(/do NOT re-run/);
  });

  it('surfaces an orphaned Auth identity on both the refused and failed arms', () => {
    const refused = formatMintReport(
      { status: 'refused', reason: 'auth_id_taken', detail: 'd', orphanAuthId: 'a1' },
      target,
    ).join('\n');
    const failed = formatMintReport(
      { status: 'failed', detail: 'd', orphanAuthId: 'a2' },
      target,
    ).join('\n');
    expect(refused).toContain('Orphaned Supabase Auth identity: a1');
    expect(failed).toContain('Orphaned Supabase Auth identity: a2');
  });
});

// ── environment selection (red team RT-08) ─────────────────────────────────

describe('readMintConfig', () => {
  it('reads the ambient environment when no --env is given', () => {
    const saved = { ...process.env };
    try {
      process.env.SUPABASE_URL = stagingSupabaseUrl;
      process.env.SUPABASE_SERVICE_KEY = 'k';
      process.env.DATABASE_POOL_URL = 'postgres://u:p@h:6543/postgres';
      process.env.NEXT_PUBLIC_APP_URL = 'https://staging.repworth.net';
      expect(readMintConfig('ambient')).toEqual({
        supabaseUrl: stagingSupabaseUrl,
        supabaseServiceKey: 'k',
        databasePoolUrl: 'postgres://u:p@h:6543/postgres',
        appUrl: 'https://staging.repworth.net',
      });
    } finally {
      process.env = saved;
    }
  });

  it('names the missing variable rather than failing obscurely', () => {
    const saved = { ...process.env };
    try {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_KEY;
      expect(() => readMintConfig('ambient')).toThrow(/SUPABASE_URL/);
    } finally {
      process.env = saved;
    }
  });
});
