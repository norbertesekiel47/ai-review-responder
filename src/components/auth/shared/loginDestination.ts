import type { AuthFlow } from '@/lib/shared/auth-flow';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

const OWNER_ALLOWED_PREFIXES = ['/dashboard', '/settings', '/onboarding'] as const;
const ADMIN_AUTH_PAGES = ['/admin/login', '/admin/forgot-password', '/admin/reset-password'] as const;

export function resolvePostLoginDestination(
  portal: AuthFlow,
  from: string,
  defaultRoute: string,
): string {
  if (!from.startsWith('/') || from.startsWith('//')) {
    return defaultRoute;
  }
  if (portal === 'owner') {
    const allowed = OWNER_ALLOWED_PREFIXES.some((prefix) => from.startsWith(prefix));
    return allowed ? from : defaultRoute;
  }
  if (!from.startsWith('/admin')) {
    return defaultRoute;
  }
  const isAuthPage = ADMIN_AUTH_PAGES.some(
    (page) => from === page || from.startsWith(`${page}/`),
  );
  return isAuthPage ? defaultRoute : from;
}

export interface SignupStatusPayload {
  subscriptionStatus?: string;
  businessOnboarded?: boolean;
}

export function applySubscriptionGuard(
  portal: AuthFlow,
  status: SignupStatusPayload | undefined,
  from = '',
): string | null {
  if (portal !== 'owner' || !status) return null;
  if (from.startsWith('/onboarding') && !from.startsWith('//')) return null;
  if (status.subscriptionStatus === SubscriptionStatus.PENDING_PAYMENT) return '/onboarding/pay';
  if (
    (status.subscriptionStatus === SubscriptionStatus.ACTIVE
      || status.subscriptionStatus === SubscriptionStatus.TRIALING)
    && status.businessOnboarded === false
  ) {
    return '/onboarding/business';
  }
  return null;
}
