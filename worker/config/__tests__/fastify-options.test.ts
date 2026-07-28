import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { requiresProductionConfig } from '../../../src/lib/config/deployment-lane';
import { buildFastifyOptions } from '../fastify-options';

describe('buildFastifyOptions', () => {
  it('bounds slow-loris and oversized-body ingress', () => {
    const opts = buildFastifyOptions(true);
    expect(opts.requestTimeout).toBe(30_000);
    expect(opts.keepAliveTimeout).toBe(60_000);
    expect(opts.connectionTimeout).toBe(10_000);
    expect(opts.bodyLimit).toBe(5 * 1024 * 1024);
    expect(opts.logger).toEqual({ level: 'warn' });
  });

  it('keeps info logging outside production', () => {
    expect(buildFastifyOptions(false).logger).toEqual({ level: 'info' });
  });

  it('buildFastifyOptions selects the warn log level when production config is required', () => {
    expect(buildFastifyOptions(true).logger).toEqual({ level: 'warn' });
  });

  it('buildFastifyOptions keeps the warn log level on staging', () => {
    // Staging's live Railway env: RAILWAY_ENVIRONMENT_NAME=staging alongside
    // NODE_ENV=production. Routed through the real predicate so a change to it
    // cannot quietly turn staging ingress logging back up to `info`.
    const staging = requiresProductionConfig({
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      NODE_ENV: 'production',
    });
    expect(buildFastifyOptions(staging).logger).toEqual({ level: 'warn' });
  });

  // Options-only assertions can pass while the wiring is dead. Prove the
  // options take effect on a real (non-listening) instance via initialConfig
  // and an injected oversized body.
  it('applies to a real Fastify instance (initialConfig) and rejects oversized bodies with 413', async () => {
    const app = Fastify(buildFastifyOptions(true));
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
