/**
 * Parse a TEXT[] column that PgBouncer may return as a JSON-encoded string.
 *
 * Postgres.js + PgBouncer (transaction pooling mode) sometimes serializes
 * arrays as JSON strings instead of native arrays. See lab note 2026-04-09.
 * Returns `[]` on any parse failure or unexpected shape.
 */
export function parseDbArray(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[];
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}
