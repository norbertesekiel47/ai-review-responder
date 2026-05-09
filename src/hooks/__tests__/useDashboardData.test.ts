// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDashboardData } from '../useDashboardData';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockJsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

describe('useDashboardData', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // VAL-DASH-017: useDashboardData('all') fetches /api/dashboard?scope=all
  it('fetches aggregate endpoint when scope is "all"', async () => {
    const aggregateData = {
      scope: 'aggregate',
      valueSummary: { totalReviewsHandled: 0, totalTimeSavedMinutes: 0, currentResponseRate: 0, baselineResponseRate: null },
      reviewVelocity: [],
      perLocationVelocity: [],
      ranking: null,
      perLocationRanking: [],
      recentReviews: [],
      perLocationBriefs: [],
      locationKpis: [],
      activeLocationCount: 2,
    };
    mockFetch.mockReturnValue(mockJsonResponse(aggregateData));

    const { result } = renderHook(() => useDashboardData('all'));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('/api/dashboard?scope=all');
    expect(result.current.data).toEqual(aggregateData);
    expect(result.current.loading).toBe(false);
  });

  // VAL-DASH-018: useDashboardData(locationId) fetches per-location endpoint
  it('fetches per-location endpoint when scope is a LocationId', async () => {
    const locationId = '123e4567-e89b-12d3-a456-426614174000';
    const perLocationData = {
      business: { name: 'Downtown Cafe', createdAt: '2026-01-01' },
      valueSummary: { totalReviewsHandled: 10, totalTimeSavedMinutes: 70, currentResponseRate: 80, baselineResponseRate: 30 },
      reviewVelocity: [],
      ranking: null,
      recentReviews: [],
      latestBrief: null,
      settings: {
        tone: 'professional', productsServices: '', avoidFacts: [], sampleResponses: [],
        ownerPhone: '', ownerEmail: '', weeklySummaryEnabled: true, monthlyImpactEnabled: true,
        category: '', googlePlaceId: '',
      },
      zernioConnection: { status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false },
    };
    mockFetch.mockReturnValue(mockJsonResponse(perLocationData));

    const { result } = renderHook(() => useDashboardData(locationId as '123e4567-e89b-12d3-a456-426614174000' & { __brand: 'LocationId' }));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('/api/dashboard?scope=');
    expect(calledUrl).toContain(locationId);
  });

  it('fetches default endpoint when scope is null', async () => {
    const defaultData = {
      business: { name: 'Test', createdAt: '2026-01-01' },
      valueSummary: { totalReviewsHandled: 5, totalTimeSavedMinutes: 35, currentResponseRate: 60, baselineResponseRate: null },
      reviewVelocity: [],
      ranking: null,
      recentReviews: [],
      latestBrief: null,
      settings: {
        tone: 'professional', productsServices: '', avoidFacts: [], sampleResponses: [],
        ownerPhone: '', ownerEmail: '', weeklySummaryEnabled: true, monthlyImpactEnabled: true,
        category: '', googlePlaceId: '',
      },
      zernioConnection: { status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false },
    };
    mockFetch.mockReturnValue(mockJsonResponse(defaultData));

    const { result } = renderHook(() => useDashboardData(null));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toBe('/api/dashboard');
    expect(calledUrl).not.toContain('scope');
  });

  it('sets error state on failed fetch', async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ error: 'Unauthorized' }, 401));

    const { result } = renderHook(() => useDashboardData('all'));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // VAL-DASH-025: Clears stale data from previous scope
  it('clears data when scope changes', async () => {
    const aggregateData = {
      scope: 'aggregate',
      valueSummary: { totalReviewsHandled: 10, totalTimeSavedMinutes: 70, currentResponseRate: 80, baselineResponseRate: null },
      reviewVelocity: [], perLocationVelocity: [], ranking: null, perLocationRanking: [],
      recentReviews: [], perLocationBriefs: [], locationKpis: [], activeLocationCount: 1,
    };
    mockFetch.mockReturnValue(mockJsonResponse(aggregateData));

    const { result, rerender } = renderHook(
      ({ scope }) => useDashboardData(scope),
      { initialProps: { scope: 'all' as const } },
    );

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    // Now change scope — data should be cleared before new fetch
    mockFetch.mockReturnValue(mockJsonResponse({
      business: { name: 'Test', createdAt: '2026-01-01' },
      valueSummary: { totalReviewsHandled: 5, totalTimeSavedMinutes: 35, currentResponseRate: 60, baselineResponseRate: null },
      reviewVelocity: [], ranking: null, recentReviews: [], latestBrief: null,
      settings: { tone: 'pro', productsServices: '', avoidFacts: [], sampleResponses: [], ownerPhone: '', ownerEmail: '', weeklySummaryEnabled: true, monthlyImpactEnabled: true, category: '', googlePlaceId: '' },
      zernioConnection: { status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false },
    }));

    rerender({ scope: 'loc-123' as unknown as 'all' });

    // Data is cleared immediately on scope change (set to null before fetch)
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('provides a refresh function that re-fetches data', async () => {
    const data1 = {
      scope: 'aggregate' as const,
      valueSummary: { totalReviewsHandled: 10, totalTimeSavedMinutes: 70, currentResponseRate: 80, baselineResponseRate: null },
      reviewVelocity: [], perLocationVelocity: [], ranking: null, perLocationRanking: [],
      recentReviews: [], perLocationBriefs: [], locationKpis: [], activeLocationCount: 1,
    };
    mockFetch.mockReturnValue(mockJsonResponse(data1));

    const { result } = renderHook(() => useDashboardData('all'));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Refresh
    const data2 = { ...data1, valueSummary: { ...data1.valueSummary, totalReviewsHandled: 15 } };
    mockFetch.mockReturnValue(mockJsonResponse(data2));

    await result.current.refresh();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // VAL-DASH-029: scopeFallback is set when API returns fallback indicator
  it('sets scopeFallback when API returns location_archived fallback', async () => {
    const fallbackData = {
      business: { name: 'Primary Biz', createdAt: '2026-01-01' },
      valueSummary: { totalReviewsHandled: 5, totalTimeSavedMinutes: 35, currentResponseRate: 60, baselineResponseRate: null },
      reviewVelocity: [], ranking: null, recentReviews: [], latestBrief: null,
      settings: { tone: 'pro', productsServices: '', avoidFacts: [], sampleResponses: [], ownerPhone: '', ownerEmail: '', weeklySummaryEnabled: true, monthlyImpactEnabled: true, category: '', googlePlaceId: '' },
      zernioConnection: { status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false },
      scopeFallback: { reason: 'location_archived', fallbackLocationId: 'primary-loc-id' },
    };
    mockFetch.mockReturnValue(mockJsonResponse(fallbackData));

    const onFallback = vi.fn();
    const { result } = renderHook(() => useDashboardData('archived-loc-id' as unknown as 'all', { onScopeFallback: onFallback }));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(result.current.scopeFallback).toEqual({
      reason: 'location_archived',
      fallbackLocationId: 'primary-loc-id',
    });
    expect(onFallback).toHaveBeenCalledWith({
      reason: 'location_archived',
      fallbackLocationId: 'primary-loc-id',
    });
  });
});
