import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('serpapi', () => ({
  getJson: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 50 }),
}));

import { resolvePlaceId } from '../place-id-resolver';
import type { GoogleMapsUrlData } from '../url-parser';

async function getJsonMock() {
  const { getJson } = await import('serpapi');
  return getJson as ReturnType<typeof vi.fn>;
}

async function getRateLimitMock() {
  const { checkRateLimit } = await import('@/lib/shared/rate-limit');
  return checkRateLimit as ReturnType<typeof vi.fn>;
}

describe('resolvePlaceId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns canonical Place ID directly without SerpAPI call', async () => {
    const data: GoogleMapsUrlData = {
      placeId: 'ChIJgUbEo8cfqokR5lP9_Wh_DaM',
      hexCid: null,
      businessName: 'Test',
      coordinates: { lat: 40.7, lng: -74.0 },
    };

    const result = await resolvePlaceId(data);
    expect(result).toBe('ChIJgUbEo8cfqokR5lP9_Wh_DaM');

    const mock = await getJsonMock();
    expect(mock).not.toHaveBeenCalled();
  });

  it('resolves via SerpAPI search when name + coords available', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      local_results: [{
        place_id: 'ChIJResolved1234567890abc',
        title: 'Café LaTTea',
        gps_coordinates: { latitude: 37.3232, longitude: -122.0123 },
      }],
    });

    const data: GoogleMapsUrlData = {
      placeId: null,
      hexCid: '0x808fb59e48e954f1:0xd8ad2f3c266775b',
      businessName: 'Café LaTTea',
      coordinates: { lat: 37.3231977, lng: -122.0123423 },
    };

    const result = await resolvePlaceId(data);
    expect(result).toBe('ChIJResolved1234567890abc');
    expect(mock).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'google_maps',
      q: 'Café LaTTea',
    }));
  });

  it('fails fast when only business name available (no coords)', async () => {
    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: null, businessName: 'Some Restaurant', coordinates: null,
    };
    await expect(resolvePlaceId(data)).rejects.toThrow('Cannot resolve Place ID without coordinates');
  });

  it('fails fast when only hex CID available (no name or coords)', async () => {
    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: '0x808fb59e48e954f1:0xd8ad2f3c266775b',
      businessName: null, coordinates: null,
    };
    await expect(resolvePlaceId(data)).rejects.toThrow('Cannot resolve Place ID without business name and coordinates');
  });

  it('fails when no SerpAPI results match within 200m', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      local_results: [{
        place_id: 'ChIJFarAway1234567890abc',
        title: 'Totally Different Place',
        gps_coordinates: { latitude: 50.0, longitude: 10.0 },
      }],
    });

    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: null, businessName: 'Café LaTTea',
      coordinates: { lat: 37.3232, lng: -122.0123 },
    };
    await expect(resolvePlaceId(data)).rejects.toThrow('Could not verify business location');
  });

  it('fails when SerpAPI returns no results', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({ local_results: [] });

    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: null, businessName: 'Nonexistent Place',
      coordinates: { lat: 37.0, lng: -122.0 },
    };
    await expect(resolvePlaceId(data)).rejects.toThrow('Could not verify business location');
  });

  it('respects daily rate limit', async () => {
    const rateLimitMock = await getRateLimitMock();
    rateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: null, businessName: 'Café LaTTea',
      coordinates: { lat: 37.3232, lng: -122.0123 },
    };
    await expect(resolvePlaceId(data)).rejects.toThrow('Daily Place ID resolution limit reached');
  });
});
