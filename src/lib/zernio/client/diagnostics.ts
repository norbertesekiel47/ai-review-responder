/**
 * Returns a JSON-safe summary of an unknown response shape: top-level keys
 * + value types (string/number/boolean/null/object/array). NEVER includes
 * actual values. Used in 'UNRECOGNIZED RESPONSE SHAPE' diagnostics so a
 * Zernio response carrying OAuth tokens / connect tokens / account IDs
 * can't leak into worker logs (which Sentry breadcrumbs auto-collect).
 * See Code Review fix Medium 5 (2026-05-02).
 */
export function summarizeShape(raw: unknown): string {
  if (raw === null) return 'null';
  if (typeof raw !== 'object') return typeof raw;
  if (Array.isArray(raw)) return `array(len=${raw.length})`;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const summary = keys.map((k) => {
    const v = o[k];
    if (v === null) return `${k}:null`;
    if (Array.isArray(v)) return `${k}:array(len=${v.length})`;
    return `${k}:${typeof v}`;
  });
  return `{${summary.join(',')}}`;
}
