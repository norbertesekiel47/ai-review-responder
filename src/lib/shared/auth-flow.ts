export const AUTH_FLOWS = ['owner', 'admin'] as const;
export type AuthFlow = (typeof AUTH_FLOWS)[number];

export function isAuthFlow(v: string | null | undefined): v is AuthFlow {
  return v === 'owner' || v === 'admin';
}

export function loginUrlForFlow(flow: AuthFlow | undefined): string {
  // Default to /admin/login when flow is unset so legacy callers (middleware
  // redirects, manual URLs without ?flow=) preserve the pre-self-serve admin
  // default. Owner flows always set flow=owner explicitly — spec §3.5.
  return flow === 'owner' ? '/login' : '/admin/login';
}

export function resetPasswordPathForFlow(flow: AuthFlow): string {
  return flow === 'admin' ? '/admin/reset-password' : '/reset-password';
}
