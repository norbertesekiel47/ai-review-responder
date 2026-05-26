const ALLOWED_ACTIONS = new Set([
  'view_dashboard',
  'view_settings',
  'view_billing_state',
]);

export function assertImpersonatedActionAllowed(
  action: string,
): { ok: true } | { ok: false; error: 'impersonated_action_blocked' } {
  return ALLOWED_ACTIONS.has(action)
    ? { ok: true }
    : { ok: false, error: 'impersonated_action_blocked' };
}
