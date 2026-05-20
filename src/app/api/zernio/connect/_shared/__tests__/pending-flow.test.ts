import { describe, expect, it } from 'vitest';
import { CONNECT_PENDING_STATUSES } from '@/lib/zernio/types';
import { parseConnectPendingMarker } from '../pending-flow';

describe('parseConnectPendingMarker', () => {
  it('parses a valid pending marker', () => {
    expect(
      parseConnectPendingMarker(
        JSON.stringify({
          flowId: 'flow_123',
          userId: 'user_123',
          started_at: 1_700_000_000_000,
          status: 'oauth_in_progress',
          profileId: 'profile_123',
          state: 'state_123',
        }),
      ),
    ).toMatchObject({
      flowId: 'flow_123',
      status: 'oauth_in_progress',
      profileId: 'profile_123',
      state: 'state_123',
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseConnectPendingMarker('{bad json')).toBeNull();
  });

  it('parses a finalizing pending marker', () => {
    expect(
      parseConnectPendingMarker(
        JSON.stringify({
          flowId: 'flow_123',
          userId: 'user_123',
          started_at: 1_700_000_000_000,
          status: 'finalizing',
        }),
      ),
    ).toMatchObject({
      flowId: 'flow_123',
      status: 'finalizing',
    });
  });

  it('parses every canonical pending marker status', () => {
    for (const status of CONNECT_PENDING_STATUSES) {
      expect(
        parseConnectPendingMarker(
          JSON.stringify({
            flowId: 'flow_123',
            userId: 'user_123',
            started_at: 1_700_000_000_000,
            status,
          }),
        ),
      ).toMatchObject({ status });
    }
  });

  it('returns null when required shape is missing', () => {
    expect(parseConnectPendingMarker(JSON.stringify({ status: 'starting' }))).toBeNull();
  });
});
