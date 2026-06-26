import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetWorkerConfigForTests } from '@/lib/config/worker';

vi.mock('serpapi', () => ({
  getJson: vi.fn(),
}));

// Hermetic worker-lane config (Stage-3 convention #9): place-id-resolver now reads
// SERPAPI_API_KEY / REDIS_CACHE_URL via the memoized getWorkerConfig(), which
// self-loads .env.local. The "blocks when REDIS_CACHE_URL is not set" test relies
// on that var being ABSENT, so stub the loader to a no-op — otherwise a developer's
// real .env.local could repopulate the deleted var. Production is unaffected: no
// .env.local exists on Railway. The 4 worker-required vars come from vitest.setup.ts.
vi.mock('@/lib/config/dotenv-load', () => ({ ensureWorkerDotenvLoaded: () => {} }));

// Mock Redis for the fail-closed budget guard.
// The production code uses a Lua EVAL that increments + conditionally sets TTL;
// the test mock replays the INCR semantics via mockIncr so existing tests
// (counter=1, counter=76 over limit, ECONNREFUSED) keep their meaning.
const mockIncr = vi.fn().mockResolvedValue(1);
const mockExpire = vi.fn().mockResolvedValue(1);
const mockEval = vi.fn(async () => mockIncr());

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: vi.fn(() => ({
    incr: mockIncr,
    expire: mockExpire,
    eval: mockEval,
  })),
}));

import { resolvePlaceId } from '../place-id-resolver';
import type { GoogleMapsUrlData } from '../url-parser';

async function getJsonMock() {
  const { getJson } = await import('serpapi');
  return getJson as ReturnType<typeof vi.fn>;
}

describe('resolvePlaceId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIncr.mockResolvedValue(1);
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    // Clear the memo AFTER setting env so getWorkerConfig() re-parses this test's
    // env on the next call (Stage-3 convention #6). Every assertion is unchanged.
    resetWorkerConfigForTests();
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

  it('rejects nearby result with dissimilar name (strip mall scenario)', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      local_results: [{
        place_id: 'ChIJWrongBiz1234567890abc',
        title: 'Panda Express',
        gps_coordinates: { latitude: 37.3232, longitude: -122.0124 },
      }],
    });

    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: null, businessName: 'Café LaTTea',
      coordinates: { lat: 37.3232, lng: -122.0123 },
    };
    await expect(resolvePlaceId(data)).rejects.toThrow('Could not verify business location');
  });

  it('accepts nearby result with similar name (substring match)', async () => {
    const mock = await getJsonMock();
    mock.mockResolvedValueOnce({
      local_results: [{
        place_id: 'ChIJCorrectBiz234567890abc',
        title: 'Café LaTTea - Cupertino',
        gps_coordinates: { latitude: 37.3232, longitude: -122.0124 },
      }],
    });

    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: null, businessName: 'Café LaTTea',
      coordinates: { lat: 37.3232, lng: -122.0123 },
    };
    const result = await resolvePlaceId(data);
    expect(result).toBe('ChIJCorrectBiz234567890abc');
  });

  it('blocks when daily limit exceeded', async () => {
    mockIncr.mockResolvedValueOnce(76); // over 75 limit

    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: null, businessName: 'Café LaTTea',
      coordinates: { lat: 37.3232, lng: -122.0123 },
    };
    await expect(resolvePlaceId(data)).rejects.toThrow('Daily Place ID resolution limit reached');
  });

  it('blocks when Redis is unavailable (fail closed)', async () => {
    mockIncr.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: null, businessName: 'Café LaTTea',
      coordinates: { lat: 37.3232, lng: -122.0123 },
    };
    await expect(resolvePlaceId(data)).rejects.toThrow('Daily Place ID resolution limit unavailable');
  });

  it('blocks when REDIS_CACHE_URL is not set (fail closed)', async () => {
    delete process.env.REDIS_CACHE_URL;
    resetWorkerConfigForTests();

    const data: GoogleMapsUrlData = {
      placeId: null, hexCid: null, businessName: 'Café LaTTea',
      coordinates: { lat: 37.3232, lng: -122.0123 },
    };
    await expect(resolvePlaceId(data)).rejects.toThrow('Daily Place ID resolution limit unavailable');
  });
});
