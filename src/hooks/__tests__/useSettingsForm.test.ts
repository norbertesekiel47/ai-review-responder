import { describe, expect, it } from 'vitest';
import { settingsRedirectForDashboardData } from '../useSettingsForm';
import type { DashboardData } from '@/lib/dashboard/types';

describe('settingsRedirectForDashboardData', () => {
  it('redirects active_pending_business away from settings before active settings are read', () => {
    // `pending_payment_admin_handoff` used to share this branch. It is gone:
    // an admin-invited owner is now a plain pending_payment owner and follows
    // the funnelUrl case below.
    const data: DashboardData = {
      subscriptionStatus: 'active_pending_business',
      businessId: 'biz-1',
      businessName: 'RepWorth Cafe',
    };

    expect(settingsRedirectForDashboardData(data)).toBe('/dashboard');
  });

  it('redirects a pending_payment owner to the server-supplied funnelUrl', () => {
    const data: DashboardData = {
      subscriptionStatus: 'pending_payment',
      businessId: 'biz-1',
      businessName: 'RepWorth Cafe',
      funnelUrl: '/onboarding/demo',
    };

    expect(settingsRedirectForDashboardData(data)).toBe('/onboarding/demo');
  });

  it('falls back to /dashboard when a pending_payment payload carries no funnelUrl', () => {
    const data: DashboardData = {
      subscriptionStatus: 'pending_payment',
      businessId: 'biz-1',
      businessName: 'RepWorth Cafe',
      funnelUrl: null,
    };

    expect(settingsRedirectForDashboardData(data)).toBe('/dashboard');
  });
});
