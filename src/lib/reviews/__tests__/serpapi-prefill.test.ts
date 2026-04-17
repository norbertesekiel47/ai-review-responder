import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockGetJson, mockRecordApiCost, mockIsMockMode, mockGetCacheRedis } = vi.hoisted(() => ({
  mockGetJson: vi.fn(),
  mockRecordApiCost: vi.fn().mockResolvedValue('cost-id'),
  mockIsMockMode: vi.fn().mockReturnValue(false),
  mockGetCacheRedis: vi.fn(),
}));

vi.mock('serpapi', () => ({
  getJson: (...args: unknown[]) => mockGetJson(...args),
}));

vi.mock('@/lib/costs/audit', () => ({
  recordApiCost: (...args: unknown[]) => mockRecordApiCost(...args),
}));

vi.mock('@/lib/shared/mock-mode', () => ({
  isMockMode: () => mockIsMockMode(),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => mockGetCacheRedis(),
}));

import { fetchBusinessDetails } from '../serpapi-prefill';

const FULL_SERPAPI_RESPONSE = {
  place_results: {
    type: 'Mexican restaurant',
    phone: '+1 408-555-1234',
    website: 'https://example.com',
    operating_hours: {
      monday: '9am-9pm',
      tuesday: '9am-9pm',
    },
    address: '123 Main St, San Jose, CA 95112',
  },
};

const PARTIAL_SERPAPI_RESPONSE = {
  place_results: {
    type: 'Coffee shop',
  },
};

function makeRedisMock(cacheHit?: string) {
  return {
    get: vi.fn().mockResolvedValue(cacheHit ?? null),
    setex: vi.fn().mockResolvedValue('OK'),
  };
}

describe('fetchBusinessDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMockMode.mockReturnValue(false);
    process.env.SERPAPI_API_KEY = 'test-key';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379';
    mockGetCacheRedis.mockReturnValue(makeRedisMock());
  });

  it('extracts category, phone, website, hours, and fullAddress from a complete response', async () => {
    mockGetJson.mockResolvedValue(FULL_SERPAPI_RESPONSE);
    const result = await fetchBusinessDetails('ChIJ_test123');
    expect(result).toEqual({
      category: 'Mexican restaurant',
      phone: '+1 408-555-1234',
      website: 'https://example.com',
      hours: 'monday: 9am-9pm, tuesday: 9am-9pm',
      fullAddress: '123 Main St, San Jose, CA 95112',
    });
  });

  it('returns partial data (nulls for missing fields) without throwing', async () => {
    mockGetJson.mockResolvedValue(PARTIAL_SERPAPI_RESPONSE);
    const result = await fetchBusinessDetails('ChIJ_test456');
    expect(result).toEqual({
      category: 'Coffee shop',
      phone: null,
      website: null,
      hours: null,
      fullAddress: null,
    });
  });

  it('returns all-null on SerpAPI failure (never throws)', async () => {
    mockGetJson.mockRejectedValue(new Error('API error'));
    const result = await fetchBusinessDetails('ChIJ_bad');
    expect(result).toEqual({
      category: null,
      phone: null,
      website: null,
      hours: null,
      fullAddress: null,
    });
  });

  it('returns all-null when SerpAPI returns malformed payload (no place_results)', async () => {
    mockGetJson.mockResolvedValue({ unexpected: 'shape' });
    const result = await fetchBusinessDetails('ChIJ_malformed');
    expect(result).toEqual({
      category: null,
      phone: null,
      website: null,
      hours: null,
      fullAddress: null,
    });
  });

  it('normalizes website to https:// when given a bare URL', async () => {
    mockGetJson.mockResolvedValue({
      place_results: { type: 'Shop', website: 'example.com' },
    });
    const result = await fetchBusinessDetails('ChIJ_bare');
    expect(result.website).toBe('https://example.com');
  });

  it('returns null website for malformed URL', async () => {
    mockGetJson.mockResolvedValue({
      place_results: { type: 'Shop', website: 'not a url at all' },
    });
    const result = await fetchBusinessDetails('ChIJ_bad_url');
    expect(result.website).toBeNull();
  });

  it('passes http:// websites through unchanged (not forced to https)', async () => {
    mockGetJson.mockResolvedValue({
      place_results: { type: 'Shop', website: 'http://example.com' },
    });
    const result = await fetchBusinessDetails('ChIJ_http');
    expect(result.website).toBe('http://example.com');
  });

  it('records an api_costs row with business_id=NULL after a successful call', async () => {
    mockGetJson.mockResolvedValue(FULL_SERPAPI_RESPONSE);
    await fetchBusinessDetails('ChIJ_cost');
    // Wait for fire-and-forget to resolve
    await new Promise((r) => setImmediate(r));
    expect(mockRecordApiCost).toHaveBeenCalledWith({
      businessId: null,
      provider: 'serpapi',
      endpoint: 'google_maps_prefill',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.005,
      responseId: null,
    });
  });

  it('returns canned data in mock mode without calling SerpAPI', async () => {
    mockIsMockMode.mockReturnValue(true);
    const result = await fetchBusinessDetails('ChIJ_mock');
    expect(result.category).toBeTruthy();
    expect(result.phone).toBeTruthy();
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('returns cached result when Redis has a hit, without calling SerpAPI', async () => {
    const cached = JSON.stringify({
      category: 'Cached category',
      phone: '+1 555',
      website: 'https://cached.example',
      hours: null,
      fullAddress: 'Cached address',
    });
    mockGetCacheRedis.mockReturnValue(makeRedisMock(cached));

    const result = await fetchBusinessDetails('ChIJ_cached');
    expect(result.category).toBe('Cached category');
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('still returns data when Redis cache write fails', async () => {
    mockGetJson.mockResolvedValue(FULL_SERPAPI_RESPONSE);
    const redisMock = makeRedisMock();
    redisMock.setex.mockRejectedValue(new Error('Redis down'));
    mockGetCacheRedis.mockReturnValue(redisMock);

    const result = await fetchBusinessDetails('ChIJ_cache_fail');
    expect(result.category).toBe('Mexican restaurant');
  });

  it('skips cache entirely when REDIS_CACHE_URL is not set', async () => {
    delete process.env.REDIS_CACHE_URL;
    mockGetJson.mockResolvedValue(FULL_SERPAPI_RESPONSE);

    const result = await fetchBusinessDetails('ChIJ_no_redis');
    expect(result.category).toBe('Mexican restaurant');
    expect(mockGetCacheRedis).not.toHaveBeenCalled();
  });

  it('returns all-null when SERPAPI_API_KEY is not set', async () => {
    delete process.env.SERPAPI_API_KEY;
    const result = await fetchBusinessDetails('ChIJ_no_key');
    expect(result.category).toBeNull();
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});
