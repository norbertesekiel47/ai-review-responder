import { describe, expect, it } from 'vitest';
import { resolveZernioConnectionState } from '../zernio-banner';

describe('resolveZernioConnectionState', () => {
  it('prefers unresolved incidents over active connection', () => {
    expect(
      resolveZernioConnectionState({
        hasUnresolvedIncident: true,
        connectionStatus: 'active',
        pendingFlow: undefined,
        queuedReconnectCount: 2,
        lastDisconnectReason: null,
      }).status,
    ).toBe('finalize_unknown');
  });

  it('prefers active DB connection over stale non-finalize pending flow', () => {
    expect(
      resolveZernioConnectionState({
        hasUnresolvedIncident: false,
        connectionStatus: 'active',
        pendingFlow: { status: 'oauth_in_progress', started_at: 1 },
        queuedReconnectCount: 0,
        lastDisconnectReason: null,
      }).pendingFlow,
    ).toBeUndefined();
  });

  it('surfaces pending flow when no active connection exists', () => {
    expect(
      resolveZernioConnectionState({
        hasUnresolvedIncident: false,
        connectionStatus: undefined,
        pendingFlow: { status: 'oauth_in_progress', started_at: 1 },
        queuedReconnectCount: 0,
        lastDisconnectReason: null,
      }).status,
    ).toBe('pending');
  });

  it('surfaces finalizing pending flow as pending when no active connection exists', () => {
    expect(
      resolveZernioConnectionState({
        hasUnresolvedIncident: false,
        connectionStatus: undefined,
        pendingFlow: { status: 'finalizing', started_at: 1 },
        queuedReconnectCount: 0,
        lastDisconnectReason: null,
      }).status,
    ).toBe('pending');
  });
});
