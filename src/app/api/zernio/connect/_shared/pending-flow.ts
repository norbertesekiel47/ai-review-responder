export type ConnectPendingStatus =
  | 'starting'
  | 'oauth_in_progress'
  | 'finalize_unknown';

export interface ConnectPendingMarkerShape {
  flowId: string;
  userId: string;
  started_at: number;
  status: ConnectPendingStatus;
  profileId?: string;
  state?: string;
}

export function parseConnectPendingMarker(raw: string): ConnectPendingMarkerShape | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectPendingMarkerShape>;
    if (
      !parsed ||
      typeof parsed.flowId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.started_at !== 'number' ||
      typeof parsed.status !== 'string'
    ) {
      return null;
    }

    if (
      parsed.status !== 'starting' &&
      parsed.status !== 'oauth_in_progress' &&
      parsed.status !== 'finalize_unknown'
    ) {
      return null;
    }

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
