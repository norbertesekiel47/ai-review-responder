// scripts/mint-admin.ts — the single admin-minting path (#1178).
//
// An admin identity is TWO halves that must be created and linked: the login
// in Supabase Auth (which yields an `auth_id`) and the row in `public.users`
// with `role='admin'` and `account_id IS NULL`. The join every admin surface
// makes is `WHERE auth_id = $1 AND role = 'admin'`
// (`src/lib/admin/shell-context.ts:103`). Until this script, both halves were
// made by hand — `docs/runbooks/completed_runbooks/signup-test-runbook.md:25`
// — and a hand process half-succeeds: half 1 alone locks the person out, half
// 2 alone is unusable, and a wrong `auth_id` is silently broken until first
// login. The database offers no guardrail, because `users_email_key` and
// `users_auth_id_key` are unique PER VALUE, so two admin identities for one
// human are perfectly legal.
//
//   pnpm tsx scripts/mint-admin.ts --email <e> --name <n> \
//     --confirm-ref <project-ref> [--env local|staging] [--dry-run]
//
// Needs the service-role key, so it is a script and never a route.
// Procedure, environment selection and the reconciliation cases:
// docs/runbooks/mint-admin.md.
//
// SHAPE. A composition root (invariant #15): it builds its own Postgres and
// Supabase clients from the environment and passes them down, rather than
// importing the `src/lib/db/server` singleton — that module reads
// `process.env.DATABASE_POOL_URL` at MODULE SCOPE, and ESM hoists imports
// above the statement that would populate it, so `--env staging` could never
// reach it. Precedent: `scripts/ws8-staging-smoke.ts`'s `connect()`.
//
// ORDERING. Auth identity first, then ONE Postgres transaction carrying both
// the `users` row and its `admin_audit_log` row. `admin-onboarding-service.ts`
// supplies the COMPENSATION precedent, not the ordering one (it writes rows
// first, then invites, then patches `auth_id`); Auth-first is this script's
// own choice, because knowing the `auth_id` before the INSERT removes the
// `auth_id IS NULL` window that file warns about at :231.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { parse as parseDotenv } from 'dotenv';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { writeAdminAuditLog } from '../src/lib/audit/log';
import { resetPasswordPathForFlow } from '../src/lib/shared/auth-flow';
import {
  describeConnectionTarget,
  extractProjectRefForLog,
  PROD_PROJECT_REFS,
} from './staging-guard';
import { runDirectCli } from './run-direct-cli';

// ── the CLI contract ───────────────────────────────────────────────────────

export type MintEnvMode = 'ambient' | 'local' | 'staging';

export interface MintAdminArgs {
  email: string;
  name: string;
  confirmRef: string;
  envMode: MintEnvMode;
  dryRun: boolean;
}

export class MintAdminUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MintAdminUsageError';
  }
}

export const MINT_ADMIN_USAGE = [
  'Usage:',
  '  pnpm tsx scripts/mint-admin.ts --email <e> --name <n> --confirm-ref <project-ref>',
  '                                [--env local|staging] [--dry-run]',
  '',
  '  --confirm-ref  the Supabase project ref you MEAN to write to. It must equal',
  '                 the ref parsed out of BOTH the Supabase URL and the database',
  '                 connection, so a mismatched credential pair cannot be confirmed.',
  '  --env          load .env.local (local) or .env.staging.local (staging, mapping',
  '                 STAGING_X -> X). Omit to use the ambient environment.',
  '  --dry-run      run every refusal check and write nothing.',
].join('\n');

/**
 * The token after `flag`, or undefined.
 *
 * A value that itself starts with `--` is treated as ABSENT, not as the value.
 * Without that, `--email --dry-run` parses the email as `"--dry-run"` and sails
 * through the required-flag checks — minting an admin named `--dry-run`, or
 * sending an invalid address to Supabase (review finding S3).
 */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/** `argv` is the arguments AFTER node and the script path. Throws on misuse. */
export function parseMintAdminArgs(argv: readonly string[]): MintAdminArgs {
  const email = flagValue(argv, '--email')?.trim().toLowerCase() ?? '';
  const name = flagValue(argv, '--name')?.trim() ?? '';
  const confirmRef = flagValue(argv, '--confirm-ref')?.trim().toLowerCase() ?? '';
  const rawEnv = flagValue(argv, '--env')?.trim() ?? 'ambient';

  if (!email) throw new MintAdminUsageError('--email is required');
  if (!name) throw new MintAdminUsageError('--name is required');
  if (!confirmRef) throw new MintAdminUsageError('--confirm-ref is required');
  if (rawEnv !== 'ambient' && rawEnv !== 'local' && rawEnv !== 'staging') {
    throw new MintAdminUsageError(`--env must be local or staging, got "${rawEnv}"`);
  }

  return { email, name, confirmRef, envMode: rawEnv, dryRun: argv.includes('--dry-run') };
}

// ── environment selection ──────────────────────────────────────────────────

/**
 * Map a parsed env file onto the bare names this script reads.
 *
 * `.env.staging.local` namespaces everything `STAGING_*`
 * (`docs/runbooks/deployment-guide.md:1431`), and this repo's copy leaves
 * `STAGING_SUPABASE_URL` EMPTY — the same trap
 * `docs/runbooks/mfa-factor-reset.md` documents for the break-glass
 * procedure — so an empty `SUPABASE_URL` falls back to the `NEXT_PUBLIC_`
 * copy, which the file's own comment and `.env.example` both document as
 * carrying the same value.
 *
 * Parsed with `dotenv.parse`, never `source`: the file contains at least one
 * unquoted value with `<`/`>` that a shell reads as redirections.
 */
export function resolveMintEnv(
  fileVars: Readonly<Record<string, string>>,
  prefix: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(fileVars)) {
    if (prefix && !key.startsWith(prefix)) continue;
    resolved[prefix ? key.slice(prefix.length) : key] = value;
  }
  if (!resolved.SUPABASE_URL?.trim() && resolved.NEXT_PUBLIC_SUPABASE_URL?.trim()) {
    resolved.SUPABASE_URL = resolved.NEXT_PUBLIC_SUPABASE_URL;
  }
  return resolved;
}

export interface MintConfig {
  supabaseUrl: string;
  supabaseServiceKey: string;
  databasePoolUrl: string;
  appUrl: string;
}

const ENV_FILES: Record<Exclude<MintEnvMode, 'ambient'>, { path: string; prefix: string }> = {
  local: { path: '.env.local', prefix: '' },
  staging: { path: '.env.staging.local', prefix: 'STAGING_' },
};

function requireValue(source: Record<string, string | undefined>, name: string): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new MintAdminUsageError(
      `${name} is not set for this target — export it, or pass --env local|staging.`,
    );
  }
  return value;
}

export function readMintConfig(envMode: MintEnvMode): MintConfig {
  let source: Record<string, string | undefined> = process.env;
  if (envMode !== 'ambient') {
    const { path, prefix } = ENV_FILES[envMode];
    if (!existsSync(path)) {
      throw new MintAdminUsageError(
        `--env ${envMode} needs ${path} in the current directory — run from the repo root.`,
      );
    }
    source = resolveMintEnv(parseDotenv(readFileSync(path, 'utf8')), prefix);
  }
  return {
    supabaseUrl: requireValue(source, 'SUPABASE_URL'),
    supabaseServiceKey: requireValue(source, 'SUPABASE_SERVICE_KEY'),
    databasePoolUrl: requireValue(source, 'DATABASE_POOL_URL'),
    appUrl: requireValue(source, 'NEXT_PUBLIC_APP_URL'),
  };
}

// ── the target guard ───────────────────────────────────────────────────────

/**
 * A Supabase project ref: twenty lowercase alphanumerics. Both known refs in
 * `staging-guard.ts` have exactly this shape, and requiring the FULL ref is
 * what stops a partial or common substring — `supabase` appears in every
 * ordinary target — from confirming anything at all.
 */
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

/** Parse the project ref out of a Supabase API URL (`https://<ref>.supabase.co`). */
function refFromSupabaseUrl(supabaseUrl: string): string | null {
  let host: string;
  try {
    host = new URL(supabaseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const [label] = host.split('.');
  return label && PROJECT_REF_PATTERN.test(label) ? label : null;
}

function containsProdRef(value: string): string | null {
  const lowered = value.toLowerCase();
  return PROD_PROJECT_REFS.find((ref) => lowered.includes(ref)) ?? null;
}

export interface MintTargetInput {
  supabaseUrl: string;
  /** Password-FREE descriptor from `describeConnectionTarget`: `user@host:port`. */
  dbTarget: string;
  /**
   * The database's project ref, parsed by `extractProjectRefForLog`
   * (`scripts/staging-guard.ts`) — the module that OWNS connection-target
   * parsing. Passed in rather than re-parsed here so the ref this guard
   * validates and the ref `main()` prints come from the same parser; two
   * parsers with different accepted shapes is how a printed ref and a
   * validated ref drift apart (review finding M2). Its miss sentinels
   * (`(ref-not-found)`, `(unparseable)`) simply fail the equality below.
   */
  dbProjectRef: string;
  confirmRef: string;
}

/**
 * Refuse unless the operator named the project they are actually pointed at.
 *
 * Order matters and mirrors `assertStagingTarget`: the production denylist runs
 * FIRST over both actual targets AND the confirmation, so no flag value can
 * ever authorise a production-looking target. Then the confirmation must be a
 * complete project ref, and must EQUAL the ref parsed out of each half of the
 * target — not merely appear in it. Exact equality on parsed refs is what makes
 * a mismatched credential pair (one project's Supabase URL beside another's
 * database) impossible to confirm, and an unparseable target is a refusal.
 */
export function assertMintTarget(input: MintTargetInput): void {
  const { supabaseUrl, dbTarget, dbProjectRef, confirmRef } = input;

  for (const [label, value] of [
    ['Supabase URL', supabaseUrl],
    ['database target', dbTarget],
    ['database project ref', dbProjectRef],
    ['--confirm-ref', confirmRef],
  ] as const) {
    const prodRef = containsProdRef(value);
    if (prodRef) {
      throw new Error(
        `REFUSING TO RUN: the ${label} matches a PRODUCTION project ref (${prodRef}). ` +
          'Minting into production is ticket #1179 and is not this script\'s job today.',
      );
    }
  }

  if (!PROJECT_REF_PATTERN.test(confirmRef)) {
    throw new Error(
      `REFUSING TO RUN: --confirm-ref must be a complete Supabase project ref ` +
        `(20 lowercase alphanumerics), got "${confirmRef}". A partial ref confirms nothing — ` +
        '"supabase" is a substring of every ordinary target.',
    );
  }

  const supabaseRef = refFromSupabaseUrl(supabaseUrl);
  if (supabaseRef !== confirmRef) {
    throw new Error(
      `REFUSING TO RUN: the Supabase URL resolves to project ref ` +
        `${supabaseRef ?? '(unparseable)'}, not the confirmed ${confirmRef}.`,
    );
  }

  if (dbProjectRef !== confirmRef) {
    throw new Error(
      `REFUSING TO RUN: the database target (${dbTarget}) resolves to project ref ` +
        `${dbProjectRef}, not the confirmed ${confirmRef}. ` +
        'The Supabase URL and the database URL must belong to the SAME project.',
    );
  }
}

// ── the recovery link ──────────────────────────────────────────────────────

/**
 * Build the link the new admin uses to set their first password.
 *
 * Deliberately NOT Supabase's `properties.action_link` (its hosted `/verify`
 * redirect honours only the project's Redirect-URL allowlist). This points at
 * THIS app's callback, which verifies `token_hash` server-side via `verifyOtp`
 * and sets the session cookies itself — the same shape `e2e/harness.ts`'s
 * `getResetUrl` builds, with `flow=admin` so a failure lands on `/admin/login`
 * and `next` on the admin reset page `resolveCallbackDestination` allow-lists.
 */
export function buildAdminRecoveryUrl(appUrl: string, hashedToken: string): string {
  const url = new URL('/api/auth/callback', appUrl);
  url.searchParams.set('token_hash', hashedToken);
  url.searchParams.set('type', 'recovery');
  url.searchParams.set('flow', 'admin');
  url.searchParams.set('next', resetPasswordPathForFlow('admin'));
  return url.toString();
}

// ── minting ────────────────────────────────────────────────────────────────

export type MintRefusalReason = 'users_row_exists' | 'auth_user_exists' | 'auth_id_taken';

/**
 * Raised INSIDE the transaction body, before any COMMIT is issued, so catching
 * it is by construction a confirmed rollback. It exists so a refusal stays
 * nameable instead of being swallowed by the reconciliation path.
 */
export class MintRefusal extends Error {
  constructor(
    readonly reason: MintRefusalReason,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'MintRefusal';
  }
}

export type AuthProbeState = 'checked' | 'unavailable';

export type MintAdminResult =
  | {
      status: 'minted';
      userId: string;
      authId: string;
      recoveryUrl: string | null;
      recoveryLinkError: string | null;
    }
  | { status: 'would_mint'; authProbe: AuthProbeState }
  // `orphanAuthId` is spelled the same way on BOTH arms — `string | null`, always
  // present. One contract, one read (review finding M5).
  | { status: 'refused'; reason: MintRefusalReason; detail: string; orphanAuthId: string | null }
  | { status: 'failed'; detail: string; orphanAuthId: string | null };

/**
 * Who ran the script, recorded WITH its provenance. A CLI has no
 * authenticated operator, so `provenance` says exactly that: this is a shell
 * environment's claim about itself, useful for correlation and worthless as
 * authentication. Recorded in the audit payload beside the self-actor marker.
 */
export interface MintOperator {
  os_user: string;
  host: string;
  provenance: 'unauthenticated_shell';
}

export function describeOperator(): MintOperator {
  return {
    os_user: userInfo().username,
    host: hostname(),
    provenance: 'unauthenticated_shell',
  };
}

export interface MintAdminInput {
  email: string;
  name: string;
  appUrl: string;
  dryRun: boolean;
  operator: MintOperator;
}

const ADMIN_MINTED_EVENT = 'admin_minted';

/**
 * SQLSTATE classes that PROVE the transaction rolled back: `22` data
 * exception, `23` integrity constraint violation, `42` syntax/access rule.
 * Postgres processed the statement, rejected it, and postgres.js awaited the
 * ROLLBACK before rethrowing.
 *
 * Everything else is AMBIGUOUS and must never confirm a rollback — no code at
 * all (a client/socket failure: `node_modules/postgres/src/errors.js` gives
 * those a non-numeric code such as `CONNECTION_CLOSED`), class `08`
 * (connection exception, including `08007 transaction_resolution_unknown`), or
 * class `57` (operator intervention, `57014 query_canceled`). This is the same
 * conservative direction `src/lib/db/transient-error.ts` takes when it omits
 * `08007` and every unlisted `08xxx` from the crash-net's recoverable set:
 * anything ambiguous or unknown fails safe.
 *
 * Classification always keys on the error that ESCAPED the awaited
 * `sql.begin` call, never on an earlier body error — a ROLLBACK that itself
 * fails surfaces its own error, and that is correctly ambiguous.
 *
 * Structural rather than an `instanceof PostgresError` test, following
 * `src/lib/channels/unique-violation.ts`.
 */
const CONFIRMED_ROLLBACK_SQLSTATE = /^(22|23|42)\d{3}$/;

export function confirmsRollback(error: unknown): boolean {
  if (error instanceof MintRefusal) return true;
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && CONFIRMED_ROLLBACK_SQLSTATE.test(code);
}

interface ExistingUserRow {
  id: string;
  role: string;
}

async function findUserByEmail(
  db: Sql | TransactionSql,
  email: string,
): Promise<ExistingUserRow | undefined> {
  const [row] = await db<ExistingUserRow[]>`
    SELECT id::text, role FROM users WHERE lower(email) = ${email} LIMIT 1
  `;
  return row;
}

/**
 * Read-only probe for an Auth identity that has no `users` row — the
 * half-succeeded hand process. It runs BEFORE the dry-run return so a dry run
 * makes every refusal the real run makes.
 *
 * Guarded by `to_regclass` because the local and CI test databases provision
 * schema `auth` with `auth.uid()` and NO `auth.users` relation
 * (`scripts/ci/test-db-bootstrap.sql`); referencing a missing relation fails at
 * parse time, so the guard cannot be folded into one statement. An absent
 * relation reports `unavailable` — never a silent "no such identity".
 */
async function probeAuthIdentity(
  sql: Sql,
  email: string,
): Promise<{ state: AuthProbeState; authUserId?: string }> {
  const [guard] = await sql<{ present: boolean }[]>`
    SELECT to_regclass('auth.users') IS NOT NULL AS present
  `;
  if (!guard?.present) return { state: 'unavailable' };

  const [row] = await sql<{ auth_user_id: string }[]>`
    SELECT id::text AS auth_user_id FROM auth.users WHERE lower(email) = ${email} LIMIT 1
  `;
  return { state: 'checked', authUserId: row?.auth_user_id };
}

/** Best-effort compensating delete. Returns the still-orphaned id, or null. */
async function deleteOrphanAuthUser(
  supabase: SupabaseClient,
  authId: string,
): Promise<string | null> {
  try {
    const { error } = await supabase.auth.admin.deleteUser(authId);
    if (error) {
      console.error(`[mint-admin] deleteUser(${authId}) returned an error:`, error.message);
      return authId;
    }
    return null;
  } catch (thrown) {
    console.error(`[mint-admin] deleteUser(${authId}) threw:`, thrown);
    return authId;
  }
}

/**
 * The ONE post-transaction path, with no special case for a refusal.
 *
 * A rejected `sql.begin` does not prove a rollback, and neither does an absent
 * row on a second connection — the original transaction may still be in
 * flight and commit a moment later. And a confirmed rollback proves only that
 * THIS invocation's transaction did not commit; it says nothing about whether
 * some other row is already linked to the Auth identity. So the reconciliation
 * read happens first, unconditionally, and the refusal reason only decides
 * what is REPORTED.
 *
 * The bias in every uncertain row is the same: an orphan Auth user is a
 * nuisance the runbook clears in one command, whereas deleting the identity
 * behind a committed `users` row produces exactly the unusable half-2 state
 * this script exists to prevent (invariant #8).
 */
async function reconcileAfterTransaction(
  sql: Sql,
  supabase: SupabaseClient,
  context: { authId: string; userId: string; error: unknown },
): Promise<Extract<MintAdminResult, { status: 'refused' | 'failed' }> | { status: 'committed' }> {
  const { authId, userId, error } = context;
  const refusal = error instanceof MintRefusal ? error : null;

  let linked: { id: string } | undefined;
  try {
    [linked] = await sql<{ id: string }[]>`
      SELECT id::text FROM users WHERE auth_id = ${authId} LIMIT 1
    `;
  } catch (readError) {
    console.error('[mint-admin] reconciliation read failed:', readError);
    return {
      status: 'failed',
      detail:
        'The mint transaction failed AND the reconciliation read failed, so the outcome is ' +
        'unknown. The Auth identity was preserved deliberately — resolve it by hand ' +
        '(docs/runbooks/mint-admin.md § Reconciling an uncertain run).',
      orphanAuthId: authId,
    };
  }

  if (linked?.id === userId) {
    // The COMMIT landed; only its acknowledgement was lost.
    return { status: 'committed' };
  }

  if (linked) {
    const detail =
      `Another users row (${linked.id}) is already linked to auth identity ${authId}. ` +
      'It was NOT deleted — that would revoke a different admin\'s login.';
    return refusal
      ? { status: 'refused', reason: refusal.reason, detail, orphanAuthId: authId }
      : { status: 'failed', detail, orphanAuthId: authId };
  }

  if (!confirmsRollback(error)) {
    return {
      status: 'failed',
      detail:
        `The mint transaction failed with an ambiguous outcome (${describeError(error)}), and no ` +
        'users row is linked to the new Auth identity yet. The transaction may still be in ' +
        'flight, so the Auth identity was preserved deliberately — resolve it by hand ' +
        '(docs/runbooks/mint-admin.md § Reconciling an uncertain run).',
      orphanAuthId: authId,
    };
  }

  const orphanAuthId = await deleteOrphanAuthUser(supabase, authId);
  if (refusal) {
    return {
      status: 'refused',
      reason: refusal.reason,
      detail: refusal.detail,
      orphanAuthId,
    };
  }
  return {
    status: 'failed',
    detail: `The mint transaction was rolled back: ${describeError(error)}`,
    orphanAuthId,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code} ${error.message}` : error.message;
  }
  return String(error);
}

/**
 * Classify `auth.admin.createUser`'s refusal as "this email already has an
 * identity". The shape mirrors `classifyAuthError` in
 * `src/lib/auth/provision-auth-user.ts`.
 *
 * Deliberately NOT `status === 422` on its own. GoTrue answers many
 * validation failures with 422 — `email_address_invalid`, `weak_password`,
 * `validation_failed` — and reporting those as `auth_user_exists` sends the
 * operator to a runbook section about an identity that does not exist (review
 * finding S2). A 422 counts only when its message actually says "already".
 */
function isDuplicateEmailError(error: { code?: string; status?: number; message?: string }): boolean {
  if (error.code === 'email_exists') return true;
  return /already (been )?registered|already exists/i.test(error.message ?? '');
}

/**
 * Create both halves of an admin identity, or leave neither.
 *
 * `sql` and `supabase` are injected — the composition root below builds them.
 */
export async function mintAdmin(
  sql: Sql,
  supabase: SupabaseClient,
  input: MintAdminInput,
): Promise<MintAdminResult> {
  const email = input.email.trim().toLowerCase();

  // Cheap read-only pre-check, before the Auth call, so the common refusal
  // never creates an identity to compensate for.
  const existing = await findUserByEmail(sql, email);
  if (existing) {
    return {
      status: 'refused',
      reason: 'users_row_exists',
      detail: `A users row already exists for ${email}: id=${existing.id} role=${existing.role}.`,
      orphanAuthId: null,
    };
  }

  const probe = await probeAuthIdentity(sql, email);
  if (probe.authUserId) {
    return {
      status: 'refused',
      reason: 'auth_user_exists',
      detail:
        `A Supabase Auth identity already exists for ${email} (auth_id=${probe.authUserId}) ` +
        'with no users row — the half-succeeded hand process. Resolve it by hand ' +
        '(docs/runbooks/mint-admin.md § An Auth identity with no users row).',
      orphanAuthId: null,
    };
  }

  if (input.dryRun) {
    return { status: 'would_mint', authProbe: probe.state };
  }

  // No `password` field at all: the new admin sets one through the recovery
  // link, so there is no password to print, log or leak. The client is
  // UNBOUNDED on purpose — src/lib/db/server.ts forbids routing identity-
  // CREATING mutations through a bounded client, because an aborted-but-
  // committed createUser leaves an orphaned Auth identity. For the same reason
  // this call is never auto-retried: a retry is what would create the second
  // identity for one human that this script exists to prevent.
  const created = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: input.name },
  });
  if (created.error) {
    if (isDuplicateEmailError(created.error)) {
      return {
        status: 'refused',
        reason: 'auth_user_exists',
        detail:
          `Supabase Auth already has an identity for ${email}. Resolve it by hand ` +
          '(docs/runbooks/mint-admin.md § An Auth identity with no users row).',
        orphanAuthId: null,
      };
    }
    // NOT "nothing was written": an aborted-but-committed createUser is exactly
    // the ambiguity src/lib/db/server.ts warns about for identity-creating
    // mutations, and the SDK surfaces a transport failure the same way it
    // surfaces a server refusal. Report the Auth outcome as UNKNOWN and send
    // the operator to a read-only reconciliation (review finding A2).
    return {
      status: 'failed',
      detail:
        `Supabase createUser failed: ${created.error.message}. Whether an Auth identity was ` +
        `created for ${email} is UNKNOWN — a transport failure can abort the response after ` +
        'the identity was written. Check before retrying, and never assume absence ' +
        '(docs/runbooks/mint-admin.md § An Auth identity with no users row).',
      orphanAuthId: null,
    };
  }
  const authId = created.data.user?.id;
  if (!authId) {
    return {
      status: 'failed',
      detail:
        `Supabase createUser returned no user and no error for ${email}. Whether an Auth ` +
        'identity was created is UNKNOWN — hosted Auth can return this shape having written ' +
        'the row (src/lib/auth/provision-auth-user.ts recovers from exactly this). Check ' +
        'before retrying (docs/runbooks/mint-admin.md § An Auth identity with no users row).',
      orphanAuthId: null,
    };
  }

  // `users.id` has no default (002_prompt2_fixes.sql:31).
  const userId = randomUUID();

  try {
    await sql.begin(async (tx) => {
      // Re-checked INSIDE the transaction, serialized against the INSERT, so
      // the race the pre-check cannot close surfaces as a named refusal rather
      // than a raw 23505.
      const raced = await findUserByEmail(tx, email);
      if (raced) {
        throw new MintRefusal(
          'users_row_exists',
          `A users row already exists for ${email}: id=${raced.id} role=${raced.role}.`,
        );
      }
      const [taken] = await tx<{ id: string }[]>`
        SELECT id::text FROM users WHERE auth_id = ${authId} LIMIT 1
      `;
      if (taken) {
        throw new MintRefusal(
          'auth_id_taken',
          `users row ${taken.id} already carries auth_id ${authId}.`,
        );
      }

      await tx`
        INSERT INTO users (id, name, email, role, auth_id, account_id)
        VALUES (${userId}::uuid, ${input.name}, ${email}, 'admin', ${authId}, NULL)
      `;

      // The ONLY sanctioned admin_audit_log writer (migration 117). The minted
      // admin is its own actor: the column is NOT NULL REFERENCES users(id) and
      // there may be NO other admin at all (#1182 revokes every admin, then
      // re-mints with this script), so a system-actor NULL is impossible and an
      // operator-actor is unavailable. Written after the users INSERT in the
      // SAME transaction, which is what makes the FK resolve without a
      // migration. Same self-actor shape as `mfa_factor_enrolled`.
      await writeAdminAuditLog(tx, {
        actorUserId: userId,
        eventType: ADMIN_MINTED_EVENT,
        entityType: 'users',
        entityId: userId,
        payload: {
          source: 'scripts/mint-admin.ts',
          email,
          name: input.name,
          auth_id: authId,
          // The actor IS the subject here, which is not the usual meaning of an
          // admin_audit_log row — mark it, so a later reader is not misled into
          // thinking this admin acted (review finding A3).
          actor_is_subject: true,
          attribution: 'bootstrap_self_actor',
          // Who ran the script, and how much that is worth. A CLI has no
          // authenticated operator identity, so this is recorded WITH its
          // provenance rather than dressed up as one.
          operator: input.operator,
        },
      });
    });
  } catch (error) {
    const reconciled = await reconcileAfterTransaction(sql, supabase, { authId, userId, error });
    if (reconciled.status !== 'committed') return reconciled;
    // Fall through: the COMMIT landed, only its acknowledgement was lost.
  }

  const link = await supabase.auth.admin.generateLink({ type: 'recovery', email });
  const hashedToken = link.data?.properties?.hashed_token;
  if (link.error || !hashedToken) {
    // The mint stands. Re-issue a link; never re-mint.
    return {
      status: 'minted',
      userId,
      authId,
      recoveryUrl: null,
      recoveryLinkError:
        link.error?.message ?? 'generateLink returned no hashed_token',
    };
  }

  return {
    status: 'minted',
    userId,
    authId,
    recoveryUrl: buildAdminRecoveryUrl(input.appUrl, hashedToken),
    recoveryLinkError: null,
  };
}

// ── reporting ──────────────────────────────────────────────────────────────

export interface MintTargetDescription {
  projectRef: string;
  supabaseHost: string;
  databaseTarget: string;
}

/**
 * The operator-facing report. A pure function so "never prints a password" is
 * an assertion over a value rather than over captured stdout.
 */
export function formatMintTarget(target: MintTargetDescription): string {
  return `TARGET: project=${target.projectRef} supabase=${target.supabaseHost} db=${target.databaseTarget}`;
}

export function formatMintReport(
  result: MintAdminResult,
  target: MintTargetDescription,
): string[] {
  const lines = [formatMintTarget(target)];

  switch (result.status) {
    case 'would_mint':
      lines.push('DRY RUN: every refusal check passed; nothing was written.');
      if (result.authProbe === 'unavailable') {
        lines.push(
          'WARNING: auth.users is not readable on this target, so the dry run could NOT ' +
            'verify the Supabase Auth half. A real run still refuses on the Auth API\'s own ' +
            'duplicate-email error.',
        );
      }
      break;
    case 'minted':
      lines.push(`MINTED: users.id=${result.userId} auth_id=${result.authId}`);
      if (result.recoveryUrl) {
        lines.push(
          'Send the new admin this single-use link. Treat it as a credential — it grants a ' +
            'session, and it expires.',
          result.recoveryUrl,
        );
      } else {
        lines.push(
          `WARNING: the mint COMMITTED but the recovery link could not be generated ` +
            `(${result.recoveryLinkError}). Re-issue a link — do NOT re-run this script.`,
        );
      }
      break;
    case 'refused':
      lines.push(`REFUSED (${result.reason}): ${result.detail}`);
      if (result.orphanAuthId) {
        lines.push(`Orphaned Supabase Auth identity: ${result.orphanAuthId}`);
      }
      break;
    case 'failed':
      lines.push(`FAILED: ${result.detail}`);
      if (result.orphanAuthId) {
        lines.push(`Orphaned Supabase Auth identity: ${result.orphanAuthId}`);
      }
      break;
  }

  return lines;
}

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const EXIT_FAILED = 4;

async function main(): Promise<number> {
  const args = parseMintAdminArgs(process.argv.slice(2));
  const config = readMintConfig(args.envMode);
  const databaseTarget = describeConnectionTarget(config.databasePoolUrl);

  const dbProjectRef = extractProjectRefForLog(config.databasePoolUrl);

  assertMintTarget({
    supabaseUrl: config.supabaseUrl,
    dbTarget: databaseTarget,
    dbProjectRef,
    confirmRef: args.confirmRef,
  });

  const target: MintTargetDescription = {
    projectRef: dbProjectRef,
    supabaseHost: new URL(config.supabaseUrl).host,
    databaseTarget,
  };

  const sql = postgres(config.databasePoolUrl, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    // Required behind Supabase's PgBouncer transaction pooler; mirrors
    // src/lib/db/server.ts.
    prepare: false,
    connection: { statement_timeout: 30_000 },
  });
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Printed BEFORE the first write, and before anything that can throw inside
  // mintAdmin — the operator must be able to see which project they are
  // pointed at even on a run that dies (review finding S1). formatMintReport
  // repeats it so a captured report is self-contained.
  console.log(formatMintTarget(target));

  try {
    const result = await mintAdmin(sql, supabase, {
      email: args.email,
      name: args.name,
      appUrl: config.appUrl,
      dryRun: args.dryRun,
      operator: describeOperator(),
    });
    for (const line of formatMintReport(result, target)) console.log(line);
    if (result.status === 'refused') return EXIT_REFUSED;
    if (result.status === 'failed') return EXIT_FAILED;
    return EXIT_OK;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

runDirectCli({
  importMetaUrl: import.meta.url,
  main,
  onError: (error: unknown) => {
    if (error instanceof MintAdminUsageError) {
      console.error(`${error.message}\n\n${MINT_ADMIN_USAGE}`);
      return EXIT_USAGE;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  },
});
