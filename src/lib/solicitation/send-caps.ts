import type { Sql, TransactionSql } from 'postgres';

/**
 * Platform default when an account's `auto_approval_policies.daily_send_cap`
 * is NULL — amendment B3 / #622 D4. Ten, not 25, because the cap must bind a
 * SINGLE approved batch: at 25 (= BATCH_CAP) a full batch could dispatch
 * inside one calendar day and the cap would only bite on a second batch. At
 * 10 a 25-ask batch is structurally forced across >= 3 calendar days, so the
 * velocity story is true by construction rather than by the drip worker
 * behaving. #619 §8's 50 is superseded.
 *
 * Deliberately the same number as DEFAULT_DAILY_AUTO_POST_CAP
 * (src/lib/auto-approval/policy.ts). SEPARATELY OWNED constants that coincide
 * by design today — never derive one from the other.
 */
export const DEFAULT_DAILY_SEND_CAP_ACCOUNT = 10;

/**
 * The enforced per-account cap. LEAST(configured, platform default): the
 * schema CHECK admits 1..50, so an admin CAN store 50 — this resolver is what
 * makes that harmless. **The dial moves toward restraint only** (#619 D20).
 */
export function resolveAccountDailySendCap(policy: { dailySendCap: number | null }): number {
  const configured = policy.dailySendCap;
  if (configured === null) return DEFAULT_DAILY_SEND_CAP_ACCOUNT;
  return Math.min(configured, DEFAULT_DAILY_SEND_CAP_ACCOUNT);
}

/**
 * The platform-wide daily ceiling (#622 §3.2A) — the warm-up dial and the
 * emergency brake in one var.
 *
 * FAILS CLOSED: unset, blank or unparseable yields 0, and 0 means NO SENDS.
 * An explicit '0' is the dial at rest, not a misconfiguration — the two are
 * indistinguishable by design, because both must stop sending.
 *
 * Takes the raw value as a parameter so it is a pure function; the caller
 * (a composition root) is what reads the environment.
 */
export function resolvePlatformDailyCap(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  if (!/^\d+$/.test(trimmed)) return 0; // rejects '-1', '1.5', 'nope', 'Infinity'
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/**
 * Dispatch attempts made by one account in the current UTC day.
 *
 * COUNTING BASIS IS `queued_at`, NOT `sent_at` (amendment B3): a bounce still
 * spent reputation, so #619 D9's sent_at counting is superseded. UTC day
 * boundary mirrors worker/jobs/response-generation/auto-approval.ts.
 *
 * Takes `sql` explicitly (invariant #15) — this module never imports
 * @/lib/db/server.
 */
export async function countAccountDispatchAttemptsToday(
  sql: Sql | TransactionSql,
  accountId: string,
): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
      FROM solicitation_outreach
     WHERE account_id = ${accountId}
       AND queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
  `;
  return row?.count ?? 0;
}

/**
 * Dispatch attempts made across ALL accounts in the current UTC day — the
 * figure the platform ceiling bounds. Cross-account BY DESIGN: the ceiling is
 * the blast-radius bound for a runaway fan-out, so a per-account view cannot
 * express it. Allowlisted in scripts/ci/tenant-scope-allowlist.ts.
 */
export async function countPlatformDispatchAttemptsToday(
  sql: Sql | TransactionSql,
): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
      FROM solicitation_outreach
     WHERE queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
  `;
  return row?.count ?? 0;
}
