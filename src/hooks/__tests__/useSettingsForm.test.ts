import { describe, expect, it } from 'vitest';
import { settingsRedirectForDashboardData } from '../useSettingsForm';
import type { DashboardData } from '@/lib/dashboard/types';

describe('settingsRedirectForDashboardData', () => {
  it.each(['active_pending_business', 'pending_payment_admin_handoff'] as const)(
    'redirects %s away from settings before active settings are read',
    (subscriptionStatus) => {
      const data: DashboardData = {
        subscriptionStatus,
        businessId: 'biz-1',
        businessName: 'RepWorth Cafe',
      };

      expect(settingsRedirectForDashboardData(data)).toBe('/dashboard');
    },
  );
});
