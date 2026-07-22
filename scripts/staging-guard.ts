// Shared staging safety gate (ticket #505, task T1) — the SINGLE owner of "is this
// connection target safe to run destructive staging tooling against."
//
// Extracted out of scripts/wedge-repro.ts so scripts/health-bundle-differential.ts
// (ephemeral Supabase branch) and scripts/burst-drill-load.ts (shared staging) can
// share it instead of re-implementing the prod denylist.
//
// Two modes, both PURE and unit-tested:
//   - assertStagingTarget         — positive allowlist: the confirmed ref must
//                                    EQUAL the known staging ref. Used against the
//                                    shared staging Supabase project.
//   - assertEphemeralBranchTarget — branch mode: the confirmed ref must be present
//                                    in the target AND be neither the prod ref NOR
//                                    the known staging ref (a throwaway branch is
//                                    distinct from both long-lived envs).
//
// In BOTH modes the prod denylist is checked FIRST and wins over every flag — no
// confirm value can ever authorize a prod-looking target.

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
