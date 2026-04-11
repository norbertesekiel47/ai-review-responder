import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Redis module before importing rate-limit
const mockEval = vi.fn();
const mockRedisInstance = { eval: mockEval };

vi.mock('@/lib/costs/tracker', () => ({
  getCacheRedis: () => mockRedisInstance,
}));

import { checkRateLimit } from '../rate-limit';

describe('checkRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Rate limiter skips when REDIS_CACHE_URL is not set — set it for tests
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
  });

  it('allows first request', async () => {
    mockEval.mockResolvedValue(1);

    const result = await checkRateLimit('test:key', 5, 60);

    expect(result).toEqual({ allowed: true, remaining: 4 });
    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String), // Lua script
      1,
      'test:key',
      '60',
    );
  });

  it('allows subsequent requests', async () => {
    mockEval.mockResolvedValue(3);

    const result = await checkRateLimit('test:key', 5, 60);

    expect(result).toEqual({ allowed: true, remaining: 2 });
  });

  it('allows request at exact limit', async () => {
    mockEval.mockResolvedValue(5);

    const result = await checkRateLimit('test:key', 5, 60);

    expect(result).toEqual({ allowed: true, remaining: 0 });
  });

  it('denies request exceeding limit', async () => {
    mockEval.mockResolvedValue(6);

    const result = await checkRateLimit('test:key', 5, 60);

    expect(result).toEqual({ allowed: false, remaining: 0 });
  });

  it('denies well past the limit', async () => {
    mockEval.mockResolvedValue(100);

    const result = await checkRateLimit('test:key', 3, 60);

    expect(result).toEqual({ allowed: false, remaining: 0 });
  });
});
