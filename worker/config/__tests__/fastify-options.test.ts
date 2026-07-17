import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { buildFastifyOptions } from '../fastify-options';

describe('buildFastifyOptions', () => {
  it('bounds slow-loris and oversized-body ingress', () => {
    const opts = buildFastifyOptions('production');
    expect(opts.requestTimeout).toBe(30_000);
    expect(opts.keepAliveTimeout).toBe(60_000);
    expect(opts.connectionTimeout).toBe(10_000);
    expect(opts.bodyLimit).toBe(5 * 1024 * 1024);
    expect(opts.logger).toEqual({ level: 'warn' });
  });

  it('keeps info logging outside production', () => {
    expect(buildFastifyOptions('development').logger).toEqual({ level: 'info' });
  });

  // Options-only assertions can pass while the wiring is dead. Prove the
  // options take effect on a real (non-listening) instance via initialConfig
  // and an injected oversized body.
  it('applies to a real Fastify instance (initialConfig) and rejects oversized bodies with 413', async () => {
    const app = Fastify(buildFastifyOptions('production'));
    // initialConfig's type omits requestTimeout; the Node server carries the
    // effective value, which is the stronger wiring proof anyway.
    expect(app.server.requestTimeout).toBe(30_000);
    expect(app.initialConfig.keepAliveTimeout).toBe(60_000);
    expect(app.initialConfig.connectionTimeout).toBe(10_000);
    expect(app.initialConfig.bodyLimit).toBe(5 * 1024 * 1024);
    app.post('/echo', async () => 'ok');
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: `{"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`,
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });
});
