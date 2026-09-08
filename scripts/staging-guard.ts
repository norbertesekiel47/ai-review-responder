// Shared staging safety gate (ticket #505, task T1) — the SINGLE owner of "is this
// connection target safe to run destructive staging tooling against."
//
// Extracted out of scripts/wedge-repro.ts so scripts/health-bundle-differential.ts
// (ephemeral Supabase branch) and scripts/burst-drill-load.ts (shared staging) can
// share it instead of re-implementing the prod denylist.
//
// Three modes, all PURE and unit-tested:
//   - assertStagingTarget         — positive allowlist: the confirmed ref must
//                                    EQUAL the known staging ref. Used against the
//                                    shared staging Supabase project.
//   - assertEphemeralBranchTarget — branch mode: the confirmed ref must be present
//                                    in the target AND be neither the prod ref NOR
//                                    the known staging ref (a throwaway branch is
//                                    distinct from both long-lived envs).
//   - assertMintTarget            — mint mode (#1178, added 2026-09-07): the
//                                    confirmed ref must be a COMPLETE project ref
//                                    and must EQUAL the ref parsed out of BOTH the
//                                    Supabase URL and the database target, so a
//                                    mismatched credential pair cannot be
//                                    confirmed. It is the only mode that can reach
//                                    production, and only behind an explicit
//                                    `allowProduction` selector.
//
// In EVERY mode the prod denylist is checked FIRST and wins over every flag VALUE —
// no confirm value can authorize a prod-looking target. Mint mode adds the one
// sanctioned exception: an explicit `allowProduction` selector (owner decision
// 2026-09-07, ticket #1178, which requires the script to serve both projects).
// A selector is not a value: it cannot be reached by mistyping a ref, it never
// defaults on, and it lifts nothing but the denylist.

/**
 * Production Supabase project refs — the UNCONDITIONAL denylist. Refs are
 * non-secret discriminators (they appear in public connection hosts / usernames),
 * so hardcoding them here is intentional and correct; never add a password. If
 * the connection target matches ANY of these, the caller aborts regardless of
 * any flag. Source: docs/runbooks/deployment-guide.md ("Concrete IDs").
 */
export const PROD_PROJECT_REFS = ['udeyaqnvpojbwgoaxwdg'] as const;

/** The staging ref — the positive-allowlist target for assertStagingTarget, and
 * the ref assertEphemeralBranchTarget must NEVER accept (a branch is distinct
 * from shared staging). */
export const KNOWN_STAGING_REF = 'kubdiqdhqbhwmqfditeg';

function rejectProdTarget(target: string): void {
  for (const prodRef of PROD_PROJECT_REFS) {
    if (target.includes(prodRef)) {
      throw new Error(
        `REFUSING TO RUN: connection target matches a PRODUCTION project ref (${prodRef}). ` +
          `This tooling runs destructive operations against staging only.`,
      );
    }
  }
}

/**
 * PURE, unit-tested gate. `host` is a ref-BEARING connection descriptor built by
 * describeConnectionTarget() — `user@hostname:port`, never a password — so the
 * project ref is present whether the URL is a Supabase pooler (`postgres.<ref>@…`)
 * or a direct connection (`db.<ref>.supabase.co`). Throws to reject; returns void
 * to accept.
 *
 * Order matters: the prod denylist is checked FIRST and wins over any flag, so a
 * staging `--confirm-staging` value can never authorize a prod-looking target.
 * Positive allowlist (D2#7): the confirmed ref must EQUAL the known staging ref
 * (not merely "some ref that happens to appear in the target").
 */
export function assertStagingTarget(host: string, confirmRef: string): void {
  const target = host.toLowerCase();

  // 1. Unconditional prod reject — denylist beats every flag.
  rejectProdTarget(target);

  // 2. Positive staging confirmation required — the operator must pass the
  //    KNOWN staging ref, and it must actually be present in the connection target.
  const ref = confirmRef.trim().toLowerCase();
  if (!ref) {
    throw new Error(
      'REFUSING TO RUN: pass --confirm-staging <project-ref> with the expected staging Supabase project ref.',
    );
  }
  if (PROD_PROJECT_REFS.some((prodRef) => ref === prodRef || ref.includes(prodRef))) {
    throw new Error(
      `REFUSING TO RUN: --confirm-staging was given a production project ref (${ref}).`,
    );
  }
  if (ref !== KNOWN_STAGING_REF) {
    throw new Error(
      `REFUSING TO RUN: --confirm-staging (${ref}) does not match the known staging project ref ` +
        `(${KNOWN_STAGING_REF}).`,
    );
  }
  if (!target.includes(ref)) {
    throw new Error(
      `REFUSING TO RUN: connection target does not contain the confirmed staging ref (${ref}). ` +
        `The --confirm-staging value must match the DB the harness is pointed at.`,
    );
  }
}

/**
 * PURE, unit-tested gate for an EPHEMERAL Supabase branch (D5). A throwaway branch
 * has its own ref, distinct from both the prod ref and the known staging ref, so
 * this mode requires the confirmed ref to be present in the target AND be NEITHER
 * of the two long-lived-env refs.
 *
 * Order matters: the prod denylist is checked FIRST and wins over any flag, same
 * as assertStagingTarget — defense-in-depth so a branch-mode caller can never be
 * pointed at prod either.
 */
export function assertEphemeralBranchTarget(host: string, confirmBranchRef: string): void {
  const target = host.toLowerCase();

  // 1. Unconditional prod reject — denylist beats every flag.
  rejectProdTarget(target);

  // 2. Positive branch confirmation required — the operator must pass the
  //    branch's own ref, distinct from prod AND from shared staging, and it must
  //    actually be present in the connection target.
  const ref = confirmBranchRef.trim().toLowerCase();
  if (!ref) {
    throw new Error(
      'REFUSING TO RUN: pass --confirm-branch <branch-project-ref> with the ephemeral Supabase branch ref.',
    );
  }
  if (PROD_PROJECT_REFS.some((prodRef) => ref === prodRef || ref.includes(prodRef))) {
    throw new Error(
      `REFUSING TO RUN: --confirm-branch was given a production project ref (${ref}).`,
    );
  }
  if (ref === KNOWN_STAGING_REF) {
    throw new Error(
      `REFUSING TO RUN: --confirm-branch was given the known STAGING project ref (${ref}) — ` +
        `a throwaway branch must be distinct from shared staging.`,
    );
  }
  if (!target.includes(ref)) {
    throw new Error(
      `REFUSING TO RUN: connection target does not contain the confirmed branch ref (${ref}). ` +
        `The --confirm-branch value must match the DB the tooling is pointed at.`,
    );
  }
}

// ── connection-target parsing (never surfaces the password) ───────────────────

/**
 * A ref-bearing, password-FREE descriptor of a Postgres URL: `user@hostname:port`.
 * Fed to assertStagingTarget / assertEphemeralBranchTarget and used for logging.
 * Throws on an unparseable URL.
 */
export function describeConnectionTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('connection URL is not parseable');
  }
  const user = parsed.username || '(no-user)';
  const port = parsed.port || '(no-port)';
  return `${user}@${parsed.hostname}:${port}`;
}

/** Best-effort extract of the project ref for logging (host `db.<ref>.` or user `postgres.<ref>`). */
export function extractProjectRefForLog(url: string): string {
  try {
    const parsed = new URL(url);
    const hostMatch = /^db\.([a-z0-9]{16,})\./i.exec(parsed.hostname);
    if (hostMatch) return hostMatch[1]!;
    const userMatch = /^[^.]+\.([a-z0-9]{16,})$/i.exec(parsed.username);
    if (userMatch) return userMatch[1]!;
    return '(ref-not-found)';
  } catch {
    return '(unparseable)';
  }
}

// ── mode 3: assertMintTarget — the admin-minting gate (#1178) ────────────────

/**
 * A Supabase project ref: twenty lowercase alphanumerics. Both refs above have
 * exactly this shape, and requiring the FULL ref is what stops a partial or
 * common substring — `supabase` appears in every ordinary target — from
 * confirming anything at all.
 *
 * Deliberately STRICTER than `extractProjectRefForLog`'s `{16,}`: that function
 * parses for LOGGING and is permissive on purpose, while this one gates a
 * write. A value that parses for a log line but is not a complete project ref
 * must never satisfy a confirmation.
 */
export const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

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

function findProdRef(value: string): string | null {
  const lowered = value.toLowerCase();
  return PROD_PROJECT_REFS.find((ref) => lowered.includes(ref)) ?? null;
}

export interface MintTargetInput {
  supabaseUrl: string;
  /** Password-FREE descriptor from `describeConnectionTarget`: `user@host:port`. */
  dbTarget: string;
  /**
   * The database's project ref, parsed by `extractProjectRefForLog` — passed in
   * rather than re-parsed, so the ref this guard validates and the ref the
   * caller PRINTS come from one parser. Two parsers with different accepted
   * shapes is how a printed ref and a validated ref drift apart. Its miss
   * sentinels (`(ref-not-found)`, `(unparseable)`) fail the equality below, so
   * an unparseable target is a refusal, never a pass.
   */
  dbProjectRef: string;
  confirmRef: string;
  /**
   * Lifts the production denylist for THIS call, and nothing else.
   *
   * Owner decision 2026-09-07, reversing an earlier outright refusal: ticket
   * #1178 says the script works against BOTH projects, so production must be
   * reachable — but only through an explicit selector the operator typed
   * (`--env production`), never as a default and never as a fallback. Every
   * other check still applies, so production additionally requires a complete
   * `--confirm-ref` equal to the ref parsed from BOTH halves of the target. The
   * two controls are independent: the selector alone cannot mint, and a
   * matching ref alone cannot mint.
   */
  allowProduction?: boolean;
}

/**
 * Mint mode. Refuse unless the operator named the project they are actually
 * pointed at.
 *
 * Order matters and mirrors the two modes above: the production denylist runs
 * FIRST over both actual targets AND the confirmation, so no flag VALUE can
 * authorize a production-looking target — the sole exception is the explicit
 * `allowProduction` selector, which is the whole of the owner-approved
 * production path. Then the confirmation must be a complete project ref and
 * must EQUAL the ref parsed out of each half of the target, not merely appear
 * in it. Exact equality on parsed refs is what makes a mismatched credential
 * pair (one project's Supabase URL beside another's database) impossible to
 * confirm.
 */
export function assertMintTarget(input: MintTargetInput): void {
  const { supabaseUrl, dbTarget, dbProjectRef, confirmRef, allowProduction = false } = input;

  if (!allowProduction) {
    for (const [label, value] of [
      ['Supabase URL', supabaseUrl],
      ['database target', dbTarget],
      ['database project ref', dbProjectRef],
      ['--confirm-ref', confirmRef],
    ] as const) {
      const prodRef = findProdRef(value);
      if (prodRef) {
        throw new Error(
          `REFUSING TO RUN: the ${label} matches a PRODUCTION project ref (${prodRef}), ` +
            'and production was not explicitly selected. Pass --env production to target ' +
            'production deliberately; no other mode may reach it.',
        );
      }
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
