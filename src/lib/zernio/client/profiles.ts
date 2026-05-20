import type { ZernioTransport } from './transport';

/**
 * Returns a JSON-safe summary of an unknown response shape: top-level keys
 * + value types (string/number/boolean/null/object/array). NEVER includes
 * actual values. Used in 'UNRECOGNIZED RESPONSE SHAPE' diagnostics so a
 * Zernio response carrying OAuth tokens / connect tokens / account IDs
 * can't leak into worker logs (which Sentry breadcrumbs auto-collect).
 * See Code Review fix Medium 5 (2026-05-02).
 */
function summarizeShape(raw: unknown): string {
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

// Zernio uses MongoDB-shaped responses. POST /v1/profiles returns:
//   { message, profile: { _id, name, userId, isDefault, color, createdAt, ... } }
// The canonical profile id is at profile._id.
function extractProfileId(raw: unknown): string {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const profileObj = o.profile as Record<string, unknown> | undefined;
    const candidates = [
      profileObj?._id,
      profileObj?.id,
      o._id,
      o.profileId,
      o.id,
      o.profile_id,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
  }
  console.warn(
    `[zernio.createProfile] UNRECOGNIZED RESPONSE SHAPE: ${summarizeShape(raw)}`,
  );
  throw new Error('zernio_createProfile_unexpected_response_shape');
}

export function createProfileClient(transport: ZernioTransport) {
  return {
    createProfile: async (input: { name: string }) => {
      const raw = await transport.request<unknown>({
        method: 'POST',
        path: '/v1/profiles',
        endpointKind: 'create_profile',
        body: input,
        timeoutMs: 10_000,
      });
      return { profileId: extractProfileId(raw) };
    },

    deleteProfile: (profileId: string) =>
      transport.request<void>({
        method: 'DELETE',
        path: `/v1/profiles/${encodeURIComponent(profileId)}`,
        endpointKind: 'delete_profile',
        timeoutMs: 10_000,
      }),
  };
}
