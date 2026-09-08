// scripts/revoke-admin.ts — the single admin-REVOKING path (#1182).
//
// The owner's 2026-09-08 decision on #1182 resets the admin set before the
// admin split: every existing admin loses access now, and admins are
// re-created when the transfer completes. That reset is a REVOKE, never a row
// deletion, because `users` rows are FK targets — `businesses.onboarded_by`
// (`001_initial_schema.sql:107`), `impersonation_sessions.actor_user_id` NOT
// NULL (`048`), `admin_audit_log.actor_user_id` NOT NULL (`117`), plus the
// `014`/`034` actor columns. Deleting an admin row would either fail loudly or
// take a security trail with it.
//
//   pnpm tsx scripts/revoke-admin.ts --email <e> --confirm-ref <project-ref> \
//     [--env local|staging|production] [--restore] [--dry-run]
//
// Needs the service-role key, so it is a script and never a route.
// Procedure and the reconciliation cases: docs/runbooks/mint-admin.md
// § "Revoking and restoring an admin".
//
// WHAT "REVOKED" MEANS HERE. Exactly one thing: the Supabase Auth identity is
// BANNED (`auth.admin.updateUserById(id, { ban_duration })`), so it cannot
// sign in and cannot refresh a session. Deliberately NOT done:
//   * `users.role` is left at `'admin'` and the row is left byte-for-byte
//     alone. The owner decision names the Auth ban as the revocation, and a
//     single-mechanism revoke is a single-mechanism restore.
//   * MFA factors are left in place. Deleting them would make `--restore`
//     stop being a reversal — the admin would have to re-enrol.
//   * No `auth.sessions` row is touched. Nothing in this repo writes the
//     `auth` schema, and adding the first such write for a staging reset is
//     not a trade worth making. The residual is bounded and stated in the
//     runbook: an access token minted before the ban stays valid until it
//     expires (the project's JWT expiry, 1h by default), because a ban blocks
//     the sign-in and the refresh, not an already-issued JWT.
//
// SHAPE. A composition root (invariant #15), the same one `mint-admin.ts`
// documents: it builds its own Postgres and Supabase clients from the
// environment and passes them down rather than importing the
// `src/lib/db/server` singleton, whose module-scope `process.env` read ESM
// hoisting puts ahead of any `--env` selection.
//
// WHY A SEPARATE FILE, not a `--revoke` mode on `mint-admin.ts`. The two
// verbs share their TARGETING (which project, confirmed how) and nothing else:
// minting is a create-both-halves-or-neither transaction, revoking writes one
// audit row beside an Auth-side state change. The sharing is expressed by
// IMPORTING the mint script's environment selection and the guard's third
// mode, so there is still exactly one owner of "am I pointed at the project
// the operator named" and one owner of "how is an admin identity created".
// `runDirectCli` is what makes importing one CLI from another safe: it runs
// `main()` only when Node invoked that module directly.
//
// WHY `admin_audit_log` AND NOT `account_audit_log`. The schema forces it.
// `account_audit_log.account_id` is NOT NULL (`034`) and an admin's
// `account_id` is NULL (invariant #9), so an admin event has no account sink
// at all — that is the entire reason migration 117 exists. The ticket's
// wording ("an `account_audit_log` entry via `writeAccountAuditLog`") cannot
// be satisfied for an admin; `writeAdminAuditLog` is the sanctioned writer,
// and `admin_minted` is the precedent this follows.

import postgres, { type Sql } from 'postgres';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { writeAdminAuditLog } from '../src/lib/audit/log';
import {
  describeOperator,
  flagValue,
  MintAdminUsageError,
  readMintConfig,
  type MintEnvMode,
  type MintOperator,
} from './mint-admin';
import {
  assertMintTarget,
  describeConnectionTarget,
  extractProjectRefForLog,
  type MintTargetInput,
} from './staging-guard';
import { runDirectCli } from './run-direct-cli';

// ── the CLI contract ───────────────────────────────────────────────────────

/** The direction of the state change. `restore` is the exact reversal. */
export type RevokeAction = 'revoke' | 'restore';

export interface RevokeAdminArgs {
  email: string;
  confirmRef: string;
  envMode: MintEnvMode;
  action: RevokeAction;
  dryRun: boolean;
}

const REVOKE_ADMIN_USAGE = [
  'Usage:',
  '  pnpm tsx scripts/revoke-admin.ts --email <e> --confirm-ref <project-ref>',
  '                                  [--env local|staging|production] [--restore] [--dry-run]',
  '',
  '  --confirm-ref  the Supabase project ref you MEAN to write to. It must equal',
  '                 the ref parsed out of BOTH the Supabase URL and the database',
  '                 connection, so a mismatched credential pair cannot be confirmed.',
  '  --env          local     load .env.local',
  '                 staging   load .env.staging.local, mapping STAGING_X -> X',
  '                 production  use the ambient environment AND permit a production',
  '                             project ref. Never a default; the only way to reach',
  '                             production, and a matching --confirm-ref is still',
  '                             required.',
  '                 Omit to use the ambient environment WITHOUT production access.',
  '  --restore      lift the ban instead of applying it. The exact reversal.',
  '  --dry-run      run every refusal check and write nothing.',
].join('\n');

/** `argv` is the arguments AFTER node and the script path. Throws on misuse. */
export function parseRevokeAdminArgs(argv: readonly string[]): RevokeAdminArgs {
  const email = flagValue(argv, '--email')?.trim().toLowerCase() ?? '';
  const confirmRef = flagValue(argv, '--confirm-ref')?.trim().toLowerCase() ?? '';
  const rawEnv = flagValue(argv, '--env')?.trim() ?? 'ambient';

  if (!email) throw new MintAdminUsageError('--email is required');
  if (!confirmRef) throw new MintAdminUsageError('--confirm-ref is required');
  if (
    rawEnv !== 'ambient' && rawEnv !== 'local' &&
    rawEnv !== 'staging' && rawEnv !== 'production'
  ) {
    throw new MintAdminUsageError(
      `--env must be local, staging or production, got "${rawEnv}"`,
    );
  }

  return {
    email,
    confirmRef,
    envMode: rawEnv,
    action: argv.includes('--restore') ? 'restore' : 'revoke',
    dryRun: argv.includes('--dry-run'),
  };
}

/**
 * Assemble the guard's input from the parsed args and the resolved config.
 *
 * Byte-for-byte the same join `mint-admin.ts`'s `buildMintGuardInput` makes,
 * and extracted for the same reason: both ENDS are pinned (the guard by
 * mutation, the parse default by test) while the WIRING between them would be
 * executed by nothing, so a mutant hard-coding `allowProduction: true` would
 * ship green (red team RT3-02 on #1178).
 */
export function buildRevokeGuardInput(
  args: Pick<RevokeAdminArgs, 'confirmRef' | 'envMode'>,
  config: { supabaseUrl: string; databasePoolUrl: string },
  databaseTarget: string,
): MintTargetInput {
  return {
    supabaseUrl: config.supabaseUrl,
    dbTarget: databaseTarget,
    dbProjectRef: extractProjectRefForLog(config.databasePoolUrl),
    confirmRef: args.confirmRef,
    allowProduction: args.envMode === 'production',
  };
}

// ── the ban ────────────────────────────────────────────────────────────────

/**
 * Supabase's documented "ban a user" duration — 100 years
 * (https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid).
 * GoTrue has no unbounded form; `none` is the documented lift.
 */
export const REVOKE_BAN_DURATION = '876000h';
export const RESTORE_BAN_DURATION = 'none';

export function banDurationFor(action: RevokeAction): string {
  return action === 'revoke' ? REVOKE_BAN_DURATION : RESTORE_BAN_DURATION;
}

const ADMIN_REVOKED_EVENT = 'admin_revoked';
const ADMIN_RESTORED_EVENT = 'admin_restored';

export function auditEventFor(action: RevokeAction): string {
  return action === 'revoke' ? ADMIN_REVOKED_EVENT : ADMIN_RESTORED_EVENT;
}

// ── results ────────────────────────────────────────────────────────────────

export type RevokeRefusalReason =
  | 'users_row_missing'
  | 'not_an_admin'
  | 'auth_id_missing';

export type BanProbeState = 'checked' | 'unavailable';

export interface AdminIdentity {
  userId: string;
  authId: string;
}

export type RevokeAdminResult =
  /** The Auth state changed AND the audit row landed. The only clean outcome. */
  | { status: 'changed'; action: RevokeAction; identity: AdminIdentity }
  /** Already in the target state. Nothing called, nothing written. */
  | { status: 'unchanged'; action: RevokeAction; identity: AdminIdentity }
  | {
      status: 'would_change';
      action: RevokeAction;
      identity: AdminIdentity;
      banProbe: BanProbeState;
    }
  /**
   * The Auth state changed but the audit INSERT did not. The ban STANDS —
   * it is the security-relevant half, and rolling it back to keep the ledger
   * tidy would restore a login the operator asked to remove. Reported as a
   * failure so it is never mistaken for a clean run.
   */
  | {
      status: 'audit_failed';
      action: RevokeAction;
      identity: AdminIdentity;
      detail: string;
    }
  | { status: 'refused'; reason: RevokeRefusalReason; detail: string }
  /**
   * `authOutcome` is UNKNOWN on every Auth failure, deliberately. The SDK
   * surfaces a transport failure the same way it surfaces a server refusal
   * (the #1178 A2 finding), so "nothing changed" is a claim this script
   * cannot make. The operator re-reads `auth.users.banned_until`.
   */
  | { status: 'failed'; detail: string; authOutcome: 'unknown' };

// ── reads ──────────────────────────────────────────────────────────────────

interface AdminUserRow {
  id: string;
  role: string;
  auth_id: string | null;
}

async function findUserByEmail(sql: Sql, email: string): Promise<AdminUserRow | undefined> {
  const [row] = await sql<AdminUserRow[]>`
    SELECT id::text, role, auth_id::text
    FROM users
    WHERE lower(email) = ${email}
    LIMIT 1
  `;
  return row;
}

/**
 * Read-only ban-state probe, the authority for idempotency.
 *
 * Reads `auth.users.banned_until` rather than the Auth admin API's user
 * payload: GoTrue OMITS `banned_until` from that JSON when it is null (probed
 * against the staging project on 2026-09-08 — the key is simply absent), so
 * absence there is indistinguishable from "the field is not serialized on this
 * version". The column is unambiguous.
 *
 * Guarded by `to_regclass` for the same reason `mint-admin.ts`'s
 * `probeAuthIdentity` is: the local and CI test databases provision schema
 * `auth` with `auth.uid()` and NO `auth.users` relation
 * (`scripts/ci/test-db-bootstrap.sql`), and referencing a missing relation
 * fails at PARSE time, so the guard cannot be folded into one statement.
 *
 * `unavailable` never reports "not banned": the caller attempts the transition
 * instead, which is safe because the Auth ban is itself idempotent.
 */
export async function probeBanState(
  sql: Sql,
  authId: string,
): Promise<{ state: BanProbeState; banned?: boolean }> {
  const [guard] = await sql<{ present: boolean }[]>`
    SELECT to_regclass('auth.users') IS NOT NULL AS present
  `;
  if (!guard?.present) return { state: 'unavailable' };

  const [row] = await sql<{ banned: boolean }[]>`
    SELECT (banned_until IS NOT NULL AND banned_until > NOW()) AS banned
    FROM auth.users
    WHERE id::text = ${authId}
    LIMIT 1
  `;
  // No auth.users row for a linked auth_id is the half-2-only state. It is not
  // "banned", so the transition is attempted and the Auth API reports the
  // missing identity in its own vocabulary.
  return { state: 'checked', banned: row?.banned ?? false };
}

// ── the operation ──────────────────────────────────────────────────────────

export interface RevokeAdminInput {
  email: string;
  action: RevokeAction;
  dryRun: boolean;
  operator: MintOperator;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code} ${error.message}` : error.message;
  }
  return String(error);
}

/**
 * Ban (or unban) an admin's Supabase Auth identity and record it.
 *
 * `sql` and `supabase` are injected — the composition root below builds them.
 *
 * ORDERING: Auth first, audit second, and NOT wrapped in `sql.begin`. There is
 * exactly ONE Postgres write here and it is not paired with a Postgres state
 * change, so a transaction would buy nothing but the appearance of atomicity
 * across a boundary Postgres does not span. Auth-first is the deliberate
 * direction: an audit row written first would claim a revocation that may
 * never happen, whereas a ban whose audit row failed is a real, reported,
 * repairable gap.
 */
export async function revokeAdmin(
  sql: Sql,
  supabase: SupabaseClient,
  input: RevokeAdminInput,
): Promise<RevokeAdminResult> {
  const email = input.email.trim().toLowerCase();
  const { action } = input;

  const row = await findUserByEmail(sql, email);
  if (!row) {
    return {
      status: 'refused',
      reason: 'users_row_missing',
      detail: `No users row exists for ${email}; there is no admin identity to ${action}.`,
    };
  }
  if (row.role !== 'admin') {
    return {
      status: 'refused',
      reason: 'not_an_admin',
      detail:
        `The users row for ${email} is id=${row.id} role=${row.role}, not an admin. ` +
        'This script only reaches admin identities.',
    };
  }
  const authId = row.auth_id?.trim();
  if (!authId) {
    return {
      status: 'refused',
      reason: 'auth_id_missing',
      detail:
        `The admin users row for ${email} (id=${row.id}) carries no auth_id, so there is no ` +
        'Supabase Auth identity to ban. Resolve it by hand ' +
        '(docs/runbooks/mint-admin.md § An Auth identity with no users row).',
    };
  }

  const identity: AdminIdentity = { userId: row.id, authId };
  const probe = await probeBanState(sql, authId);
  const alreadyInTargetState =
    probe.state === 'checked' &&
    (action === 'revoke' ? probe.banned === true : probe.banned === false);

  if (alreadyInTargetState) {
    return { status: 'unchanged', action, identity };
  }

  if (input.dryRun) {
    return { status: 'would_change', action, identity, banProbe: probe.state };
  }

  const banDuration = banDurationFor(action);
  // NEVER `deleteUser`. The whole point of the reset is that the row survives.
  const updated = await supabase.auth.admin.updateUserById(authId, {
    ban_duration: banDuration,
  });
  if (updated.error) {
    return {
      status: 'failed',
      detail:
        `Supabase updateUserById failed for ${email} (auth_id=${authId}): ` +
        `${updated.error.message}. Whether the ban was applied is UNKNOWN — a transport ` +
        'failure can abort the response after the write. Re-read auth.users.banned_until ' +
        'before retrying, and never assume it did not apply.',
      authOutcome: 'unknown',
    };
  }

  try {
    // The ONLY sanctioned admin_audit_log writer (migration 117). The revoked
    // admin is its own actor: `actor_user_id` is NOT NULL REFERENCES users(id)
    // and this run may be revoking the LAST admin, so a system-actor NULL is
    // impossible and an operator-actor is unavailable. Same self-actor shape
    // as `admin_minted` and `mfa_factor_enrolled`.
    await writeAdminAuditLog(sql, {
      actorUserId: identity.userId,
      eventType: auditEventFor(action),
      entityType: 'users',
      entityId: identity.userId,
      payload: {
        source: 'scripts/revoke-admin.ts',
        action,
        email,
        auth_id: authId,
        ban_duration: banDuration,
        // The users row is untouched by design; recorded so a later reader is
        // not left wondering whether the row was removed.
        users_row_preserved: true,
        // The actor IS the subject, which is not the usual meaning of an
        // admin_audit_log row — mark it, exactly as `admin_minted` does.
        actor_is_subject: true,
        attribution: 'bootstrap_self_actor',
        operator: input.operator,
      },
    });
  } catch (error) {
    return {
      status: 'audit_failed',
      action,
      identity,
      detail: describeError(error),
    };
  }

  return { status: 'changed', action, identity };
}

// ── reporting ──────────────────────────────────────────────────────────────

export interface RevokeTargetDescription {
  projectRef: string;
  supabaseHost: string;
  databaseTarget: string;
}

/**
 * The operator-facing report. A pure function so "never prints a secret" is an
 * assertion over a value rather than over captured stdout.
 */
export function formatRevokeTarget(target: RevokeTargetDescription): string {
  return `TARGET: project=${target.projectRef} supabase=${target.supabaseHost} db=${target.databaseTarget}`;
}

export function formatRevokeReport(
  result: RevokeAdminResult,
  target: RevokeTargetDescription,
): string[] {
  const lines = [formatRevokeTarget(target)];

  switch (result.status) {
    case 'would_change':
      lines.push(
        `DRY RUN (${result.action}): every refusal check passed; nothing was written. ` +
          `users.id=${result.identity.userId} auth_id=${result.identity.authId}`,
      );
      if (result.banProbe === 'unavailable') {
        lines.push(
          'WARNING: auth.users is not readable on this target, so the dry run could NOT ' +
            'read the current ban state. A real run would attempt the transition anyway; ' +
            'the Auth ban is idempotent.',
        );
      }
      break;
    case 'changed':
      lines.push(
        result.action === 'revoke'
          ? `REVOKED: users.id=${result.identity.userId} auth_id=${result.identity.authId} — ` +
            'the Supabase Auth identity is banned. The users row was left in place, ' +
            "role='admin' unchanged."
          : `RESTORED: users.id=${result.identity.userId} auth_id=${result.identity.authId} — ` +
            'the ban was lifted. Under MFA enforcement this identity is challenged for its ' +
            'existing factor at the next sign-in, or enrols one if it has none.',
      );
      lines.push(
        'NOTE: an access token minted before a ban stays valid until it expires ' +
          '(project JWT expiry, 1h by default); a ban blocks sign-in and refresh, not an ' +
          'already-issued JWT.',
      );
      break;
    case 'unchanged':
      lines.push(
        result.action === 'revoke'
          ? `ALREADY REVOKED: users.id=${result.identity.userId} is already banned; nothing written.`
          : `ALREADY ACTIVE: users.id=${result.identity.userId} is not banned; nothing written.`,
      );
      break;
    case 'audit_failed':
      lines.push(
        `WARNING: the ${result.action} COMMITTED in Supabase Auth ` +
          `(users.id=${result.identity.userId} auth_id=${result.identity.authId}) but the ` +
          `admin_audit_log row FAILED (${result.detail}). The Auth change STANDS — do NOT ` +
          `re-run to "fix" the ledger; record one ${auditEventFor(result.action)} row for ` +
          'that actor by hand (docs/runbooks/mint-admin.md § Revoking and restoring an admin).',
      );
      break;
    case 'refused':
      lines.push(`REFUSED (${result.reason}): ${result.detail}`);
      break;
    case 'failed':
      lines.push(`FAILED: ${result.detail}`);
      break;
  }

  return lines;
}

// ── the composition root ───────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const EXIT_FAILED = 4;

async function main(): Promise<number> {
  const args = parseRevokeAdminArgs(process.argv.slice(2));
  const config = readMintConfig(args.envMode);
  const databaseTarget = describeConnectionTarget(config.databasePoolUrl);

  assertMintTarget(buildRevokeGuardInput(args, config, databaseTarget));

  const target: RevokeTargetDescription = {
    projectRef: extractProjectRefForLog(config.databasePoolUrl),
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

  // Printed BEFORE the first write and before anything that can throw, so the
  // operator sees which project they are pointed at even on a run that dies.
  console.log(formatRevokeTarget(target));

  try {
    const result = await revokeAdmin(sql, supabase, {
      email: args.email,
      action: args.action,
      dryRun: args.dryRun,
      operator: describeOperator(),
    });
    for (const line of formatRevokeReport(result, target)) console.log(line);
    if (result.status === 'refused') return EXIT_REFUSED;
    if (result.status === 'failed' || result.status === 'audit_failed') return EXIT_FAILED;
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
      console.error(`${error.message}\n\n${REVOKE_ADMIN_USAGE}`);
      return EXIT_USAGE;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  },
});
