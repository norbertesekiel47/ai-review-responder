export const AUTH_FLOWS = ['owner', 'admin'] as const;
export type AuthFlow = (typeof AUTH_FLOWS)[number];

export function isAuthFlow(v: string | null | undefined): v is AuthFlow {
  return v === 'owner' || v === 'admin';
}

export function loginUrlForFlow(flow: AuthFlow | undefined): string {
  return flow === 'admin' ? '/admin/login' : '/login';
}

export function resetPasswordPathForFlow(flow: AuthFlow): string {
  return flow === 'admin' ? '/admin/reset-password' : '/reset-password';
}
