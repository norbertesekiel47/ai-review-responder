import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getRedisOptions, parseRedisFamily } from '../redis-connection';

// getRedisOptions reads process.env at call time. Snapshot + restore so these
// cases don't leak the REDIS_QUEUE_URL/REDIS_QUEUE_TOKEN they set.
const ORIGINAL_URL = process.env.REDIS_QUEUE_URL;
const ORIGINAL_TOKEN = process.env.REDIS_QUEUE_TOKEN;

describe('parseRedisFamily', () => {
  it('accepts the three valid ioredis families', () => {
    expect(parseRedisFamily('0')).toBe(0);
    expect(parseRedisFamily('4')).toBe(4);
    expect(parseRedisFamily('6')).toBe(6);
  });

  it('returns undefined when the param is absent', () => {
    expect(parseRedisFamily(null)).toBeUndefined();
  });

  it('rejects out-of-range and non-numeric values', () => {
    expect(parseRedisFamily('9')).toBeUndefined();
    expect(parseRedisFamily('')).toBeUndefined();
    expect(parseRedisFamily('abc')).toBeUndefined();
  });
});

describe('getRedisOptions', () => {
  beforeEach(() => {
    delete process.env.REDIS_QUEUE_URL;
    delete process.env.REDIS_QUEUE_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.REDIS_QUEUE_URL;
    else process.env.REDIS_QUEUE_URL = ORIGINAL_URL;
    if (ORIGINAL_TOKEN === undefined) delete process.env.REDIS_QUEUE_TOKEN;
    else process.env.REDIS_QUEUE_TOKEN = ORIGINAL_TOKEN;
  });

  it('passes family:0 through for a Railway private-networking URL', () => {
    // Railway private net is IPv6-only; the ?family=0 hint is what lets
    // ioredis/BullMQ resolve *.railway.internal.
    process.env.REDIS_QUEUE_URL =
      'redis://default:pw@redis.railway.internal:6379/1?family=0';
    const opts = getRedisOptions();
    expect(opts.family).toBe(0);
    expect(opts.host).toBe('redis.railway.internal');
    expect(opts.db).toBe(1);
    expect(opts.password).toBe('pw');
    expect(opts.tls).toBeUndefined(); // plain redis:// — Wireguard encrypts the private net
    expect(opts.maxRetriesPerRequest).toBeNull(); // required by BullMQ
  });

  it('omits family entirely for a plain local URL (ioredis default)', () => {
    process.env.REDIS_QUEUE_URL = 'redis://localhost:6379/1';
    const opts = getRedisOptions();
    expect(opts).not.toHaveProperty('family');
    expect(opts.host).toBe('localhost');
    expect(opts.db).toBe(1);
    expect(opts.tls).toBeUndefined();
  });

  it('enables TLS for a rediss:// URL', () => {
    process.env.REDIS_QUEUE_URL = 'rediss://default:tok@host.upstash.io:6379/1';
    const opts = getRedisOptions();
    expect(opts.tls).toEqual({});
    expect(opts).not.toHaveProperty('family');
  });

  it('handles the Upstash REST https:// form with a token', () => {
    process.env.REDIS_QUEUE_URL = 'https://host.upstash.io';
    process.env.REDIS_QUEUE_TOKEN = 'rest-token';
    const opts = getRedisOptions();
    expect(opts.host).toBe('host.upstash.io');
    expect(opts.port).toBe(6379);
    expect(opts.password).toBe('rest-token');
    expect(opts.tls).toEqual({});
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  it('ignores an invalid family value rather than passing garbage to ioredis', () => {
    process.env.REDIS_QUEUE_URL = 'redis://localhost:6379/1?family=9';
    const opts = getRedisOptions();
    expect(opts).not.toHaveProperty('family');
  });

  it('supports family:6 as well', () => {
    process.env.REDIS_QUEUE_URL = 'redis://default:pw@redis.railway.internal:6379/1?family=6';
    expect(getRedisOptions().family).toBe(6);
  });
});
