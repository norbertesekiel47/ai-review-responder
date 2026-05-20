import {
  CONNECT_PENDING_STATUSES,
  type ConnectPendingMarker,
} from '@/lib/zernio/types';

export type ConnectPendingMarkerShape = Pick<
  ConnectPendingMarker,
  'flowId' | 'userId' | 'started_at' | 'status' | 'profileId' | 'state'
>;

function isConnectPendingStatus(status: string): status is ConnectPendingMarkerShape['status'] {
  return (CONNECT_PENDING_STATUSES as readonly string[]).includes(status);
}

export function parseConnectPendingMarker(raw: string): ConnectPendingMarkerShape | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectPendingMarker>;
    if (
      !parsed ||
      typeof parsed.flowId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.started_at !== 'number' ||
      typeof parsed.status !== 'string'
    ) {
      return null;
    }

    if (!isConnectPendingStatus(parsed.status)) {
      return null;
    }

    // This parser intentionally returns only fields consumed by start/route.ts.
    // It validates canonical statuses but does not round-trip finalize_unknown_at.
    return {
      flowId: parsed.flowId,
      userId: parsed.userId,
      started_at: parsed.started_at,
      status: parsed.status,
      profileId: typeof parsed.profileId === 'string' ? parsed.profileId : undefined,
      state: typeof parsed.state === 'string' ? parsed.state : undefined,
    };
  } catch {
    return null;
  }
}

export function isFreshPendingMarker(marker: { started_at: number }, ttlSeconds: number): boolean {
  return Date.now() - marker.started_at <= ttlSeconds * 1000;
}
