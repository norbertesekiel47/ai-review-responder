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
