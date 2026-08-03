import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyLoggerOptions, FastifyServerOptions } from 'fastify';
import { requiresProductionConfig } from '../../../src/lib/config/deployment-lane';
import { buildFastifyOptions } from '../fastify-options';

// `FastifyServerOptions['logger']` is a union (boolean | options | a live
// logger). buildFastifyOptions always returns the options branch; narrowing here
// keeps every assertion below free of inline casts.
function loggerOptions(options: FastifyServerOptions): FastifyLoggerOptions {
  const { logger } = options;
  if (typeof logger !== 'object' || logger === null) {
    throw new Error('buildFastifyOptions must configure an object logger');
  }
  return logger as FastifyLoggerOptions;
}

type CapturedLogLine = { msg?: string; req?: Record<string, unknown> };

/**
 * Drive a real (non-listening) Fastify instance built from the production
 * options, with request logging left ON — the prod default of `warn` hides this
 * whole class, which is what let the leak survive three reviews.
 */
async function injectWithLogCapture(
  method: 'GET' | 'POST',
  url: string,
  register?: (app: FastifyInstance) => void,
): Promise<{ statusCode: number; lines: CapturedLogLine[] }> {
  const raw: string[] = [];
  const options = buildFastifyOptions(false);
  const app = Fastify({
    ...options,
    logger: {
      ...loggerOptions(options),
      stream: {
        write: (line: string) => {
          raw.push(line);
        },
      },
    },
  });
  register?.(app);

  try {
    const res = await app.inject({ method, url });
    return { statusCode: res.statusCode, lines: raw.map((line) => JSON.parse(line) as CapturedLogLine) };
  } finally {
    await app.close();
  }
}

describe('buildFastifyOptions', () => {
  it('bounds slow-loris and oversized-body ingress', () => {
    const opts = buildFastifyOptions(true);
    expect(opts.requestTimeout).toBe(30_000);
    expect(opts.keepAliveTimeout).toBe(60_000);
    expect(opts.connectionTimeout).toBe(10_000);
    expect(opts.bodyLimit).toBe(5 * 1024 * 1024);
    expect(loggerOptions(opts).level).toBe('warn');
  });

  it('keeps info logging outside production', () => {
    expect(loggerOptions(buildFastifyOptions(false)).level).toBe('info');
  });

  it('buildFastifyOptions selects the warn log level when production config is required', () => {
    expect(loggerOptions(buildFastifyOptions(true)).level).toBe('warn');
  });

  it('buildFastifyOptions keeps the warn log level on staging', () => {
    // Staging's live Railway env: RAILWAY_ENVIRONMENT_NAME=staging alongside
    // NODE_ENV=production. Routed through the real predicate so a change to it
    // cannot quietly turn staging ingress logging back up to `info`.
    const staging = requiresProductionConfig({
      RAILWAY_ENVIRONMENT_NAME: 'staging',
      NODE_ENV: 'production',
    });
    expect(loggerOptions(buildFastifyOptions(staging)).level).toBe('warn');
  });

  it('a trailing segment url is redacted by the global request serializer', async () => {
    // Deliberately unmatched: Fastify emits `incoming request` before routing,
    // so a 404 under the unsubscribe prefix is exactly the case a route-level
    // `logLevel: 'silent'` can never reach (invariant #5).
    const { statusCode, lines } = await injectWithLogCapture(
      'GET',
      '/ingress/unsubscribe/SECRET_TOK/extra',
    );
    expect(statusCode).toBe(404);

    // Two distinct shapes carry the URL on this path and BOTH must be covered:
    // the serialized `req.url`, and the default 404 handler's plain message
    // string, which no serializer can reach.
    const requestLine = lines.find((line) => line.req !== undefined);
    const notFoundLine = lines.find((line) => line.msg?.startsWith('Route ') === true);
    expect(requestLine?.req?.url).toBe('/ingress/unsubscribe/[REDACTED]');
    expect(notFoundLine?.msg).toBe('Route GET:/ingress/unsubscribe/[REDACTED] not found');
    expect(JSON.stringify(lines)).not.toContain('SECRET_TOK');
  });

  it('keeps the ordinary ingress url and request fields in the serialized log', async () => {
    const { lines } = await injectWithLogCapture('GET', '/ingress/resend', (app) => {
      app.get('/ingress/resend', async () => 'ok');
    });

    const requestLine = lines.find((line) => line.req !== undefined);
    expect(requestLine?.req).toMatchObject({ method: 'GET', url: '/ingress/resend' });
    expect(requestLine?.req).toHaveProperty('remoteAddress');
    expect(requestLine?.req).toHaveProperty('host');
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
