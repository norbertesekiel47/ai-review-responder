export type DashboardScopePolicy =
  | { mode: 'aggregate' }
  | { mode: 'location'; locationId: string | null };

export function resolveDashboardScopePolicy(input: {
  scopeParam: string | null;
  userLocationId: string | null | undefined;
  multiLocationEnabled: boolean;
}): DashboardScopePolicy {
  if (input.multiLocationEnabled && input.scopeParam === 'all') {
    return { mode: 'aggregate' };
  }

  return {
    mode: 'location',
    locationId:
      input.scopeParam && input.scopeParam !== 'all'
        ? input.scopeParam
        : input.userLocationId ?? null,
  };
}
