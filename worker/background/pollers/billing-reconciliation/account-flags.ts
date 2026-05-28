// worker/background/pollers/billing-reconciliation/account-flags.ts
//
// Parses the accounts.flags JSONB column (which Postgres.js + PgBouncer may
// return as a string) and derives pilot status used in drift-alert metadata.

export function parseAccountFlags(
  flags: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
  if (!flags) return {};
  if (typeof flags === 'string') {
    try {
      const parsed = JSON.parse(flags);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return flags;
}

export function isPilotAccount(
  flags: Record<string, unknown> | string | null | undefined,
): boolean {
  const parsedFlags = parseAccountFlags(flags);
  return parsedFlags.is_pilot === true || parsedFlags.pilot === true;
}
