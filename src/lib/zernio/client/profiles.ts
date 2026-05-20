import { summarizeShape } from './diagnostics';
import type { ZernioTransport } from './transport';

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
