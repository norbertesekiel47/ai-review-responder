/**
 * Parse a TEXT[] column that PgBouncer may return as a JSON-encoded string.
 *
 * Postgres.js + PgBouncer (transaction pooling mode) sometimes serializes
 * arrays as JSON strings instead of native arrays. See lab note 2026-04-09.
 * Returns `[]` on any parse failure or unexpected shape.
 *
 * The output is enforced to be a true `string[]` — non-string array elements
 * are filtered out (rather than being unsafely cast through). Without this,
 * a malformed row containing e.g. `[1, 2]` would lie to TypeScript and crash
 * downstream `.split()` or `.includes()` calls at the consumer.
 */
export function parseDbArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val.filter((el): el is string => typeof el === 'string');
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed)
        ? parsed.filter((el): el is string => typeof el === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}
