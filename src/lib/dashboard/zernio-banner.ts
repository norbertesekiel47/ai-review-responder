import type { DashboardDataActive } from './types';

export interface ResolveZernioConnectionInput {
  hasUnresolvedIncident: boolean;
  connectionStatus?: 'pending' | 'active' | 'disconnected';
  pendingFlow?: DashboardDataActive['zernioConnection']['pendingFlow'];
  queuedReconnectCount: number;
  lastDisconnectReason?: string | null;
}

export function resolveZernioConnectionState(
  input: ResolveZernioConnectionInput,
): DashboardDataActive['zernioConnection'] {
  let status: DashboardDataActive['zernioConnection']['status'];
  let surfacedPendingFlow: typeof input.pendingFlow;

  // Zernio banner state precedence, highest to lowest:
  //   1. Unresolved finalize incident in DB            -> 'finalize_unknown'
  //   2. Pending marker with status='finalize_unknown' -> 'finalize_unknown'
  //      (mirrors #1 before OutboxPoller has written the incident row, or
  //      during the brief window between markUnknown and incident insert)
  //   3. zernio_connections.status === 'active'        -> 'active'
  //      (beats stale non-finalize pending markers; select-location's
  //      best-effort Redis cleanup can leave one behind for up to the TTL)
  //   4. Pending marker with any non-finalize status   -> 'pending'
  //   5. zernio_connections.status ('pending'|'disconnected')
  //   6. Fallback                                      -> 'none'
  if (
    input.hasUnresolvedIncident ||
    input.pendingFlow?.status === 'finalize_unknown'
  ) {
    status = 'finalize_unknown';
    surfacedPendingFlow =
      input.pendingFlow?.status === 'finalize_unknown'
        ? input.pendingFlow
        : undefined;
  } else if (input.connectionStatus === 'active') {
    status = 'active';
    surfacedPendingFlow = undefined;
  } else if (input.pendingFlow) {
    status = 'pending';
    surfacedPendingFlow = input.pendingFlow;
  } else if (input.connectionStatus) {
    status = input.connectionStatus;
    surfacedPendingFlow = undefined;
  } else {
    status = 'none';
    surfacedPendingFlow = undefined;
  }

  return {
    status,
    pendingFlow: surfacedPendingFlow,
    queuedReconnectCount: input.queuedReconnectCount,
    hasUnresolvedIncident: input.hasUnresolvedIncident,
    lastDisconnectReason: input.lastDisconnectReason ?? undefined,
  };
}
