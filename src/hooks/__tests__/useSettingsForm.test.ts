// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { settingsRedirectForDashboardData, useSettingsForm } from '../useSettingsForm';
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

// ── S5: unsaved edits arm the browser's leave-page prompt ───────────────────

describe('useSettingsForm — unsaved-changes guard', () => {
  const SETTINGS_PAYLOAD = {
    business: { name: 'RepWorth Cafe', createdAt: '2026-01-01T00:00:00.000Z' },
    settings: {
      tone: 'professional',
      productsServices: 'Coffee',
      avoidFacts: [],
      sampleResponses: [],
      ownerPhone: '',
      weeklySummaryEnabled: true,
      monthlyImpactEnabled: false,
      category: 'Cafe',
      googlePlaceId: 'ChIJ123',
      ownerEmail: 'owner@example.com',
    },
  };

  function fireBeforeUnload(): BeforeUnloadEvent {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);
    return event;
  }

  it('prevents beforeunload only while the form is dirty', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => SETTINGS_PAYLOAD,
    } as unknown as Response);

    const { result, unmount } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.form).not.toBeNull());

    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    act(() => result.current.set('tone', 'playful'));
    expect(result.current.dirty).toBe(true);
    expect(fireBeforeUnload().defaultPrevented).toBe(true);

    act(() => result.current.discard());
    expect(result.current.dirty).toBe(false);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    unmount();
    vi.restoreAllMocks();
  });
});
