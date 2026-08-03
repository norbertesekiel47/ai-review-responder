import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type {
  FastifyInstance,
  FastifyLoggerOptions,
  FastifyRequest,
  FastifyServerOptions,
} from 'fastify';
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

type CapturedLogLine = {
  level?: number;
  msg?: string;
  req?: Record<string, unknown>;
  err?: Record<string, unknown>;
};

/**
 * Drive a real (non-listening) Fastify instance with request logging left ON.
 *
 * `productionConfigRequired` is a REQUIRED input, never defaulted: the two log
 * levels see disjoint sets of lines. `incoming request` and the 404 message are
 * level 30 and vanish in production, while Fastify's own
 * FST_ERR_REP_ALREADY_SENT (40) and the default 5xx handler (50) are the shapes
 * production actually emits. A harness pinned to one lane can only ever prove
 * half the redaction.
 */
async function injectWithLogCapture(input: {
  productionConfigRequired: boolean;
  method: 'GET' | 'POST';
  url: string;
  register?: (app: FastifyInstance) => void;
}): Promise<{ statusCode: number; lines: CapturedLogLine[] }> {
  const raw: string[] = [];
  const options = buildFastifyOptions(input.productionConfigRequired);
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
  input.register?.(app);

  try {
    const res = await app.inject({ method: input.method, url: input.url });
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
    const { statusCode, lines } = await injectWithLogCapture({
      productionConfigRequired: false,
      method: 'GET',
      url: '/ingress/unsubscribe/SECRET_TOK/extra',
    });
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
    const { lines } = await injectWithLogCapture({
      productionConfigRequired: false,
      method: 'GET',
      url: '/ingress/resend',
      register: (app) => {
        app.get('/ingress/resend', async () => 'ok');
      },
    });

    const requestLine = lines.find((line) => line.req !== undefined);
    expect(requestLine?.req).toMatchObject({ method: 'GET', url: '/ingress/resend' });
    expect(requestLine?.req).toHaveProperty('remoteAddress');
    expect(requestLine?.req).toHaveProperty('host');
  });

  it('emits every field fastify\'s own request serializer emits', () => {
    // Field parity has to be asserted against the serializer directly: under
    // app.inject() there is no real socket and no accept-version header, so
    // `remotePort` and `version` serialize to undefined and JSON drops the keys.
    const serializeRequest = loggerOptions(buildFastifyOptions(true)).serializers?.req;
    if (serializeRequest === undefined) throw new Error('expected a req serializer');

    const serialized = serializeRequest({
      method: 'POST',
      url: '/ingress/stripe',
      headers: { 'accept-version': '1.2.3' },
      host: 'worker.example.com',
      ip: '10.0.0.4',
      socket: { remotePort: 54_321 },
      // Only the six fields the serializer reads; the rest of FastifyRequest is
      // irrelevant to it.
    } as unknown as FastifyRequest);

    // Field-for-field against fastify/lib/logger-pino.js. A redaction change must
    // not narrow ingress diagnostics for Stripe/Resend/Twilio/Telegram/Zernio.
    expect(serialized).toEqual({
      method: 'POST',
      url: '/ingress/stripe',
      version: '1.2.3',
      host: 'worker.example.com',
      remoteAddress: '10.0.0.4',
      remotePort: 54_321,
    });
  });

  it('redacts the token from a 5xx error logged at the production warn level', async () => {
    // The production lane. `incoming request` (30) and the 404 message (30) are
    // BELOW this threshold — the shapes production actually writes are Fastify's
    // default 5xx handler (50) and its double-send warning (40), and both carry
    // the URL inside the error, where no string hook and no `req` serializer can
    // reach it.
    const { statusCode, lines } = await injectWithLogCapture({
      productionConfigRequired: true,
      method: 'GET',
      url: '/u/SECRET_TOK',
      register: (app) => {
        app.get('/u/:token', async (request) => {
          throw new Error(`boom handling ${request.url}`);
        });
      },
    });

    expect(statusCode).toBe(500);
    const errorLine = lines.find((line) => line.err !== undefined);
    expect(errorLine?.err?.message).toBe('boom handling /u/[REDACTED]');
    expect(String(errorLine?.err?.stack)).toContain('/u/[REDACTED]');
    expect(JSON.stringify(lines)).not.toContain('SECRET_TOK');
  });

  it("redacts the token from fastify's own double-send warning", async () => {
    // FST_ERR_REP_ALREADY_SENT interpolates request.url into its message
    // (fastify/lib/reply.js:145) and logs `{ err }` at warn with NO string
    // argument — so this needs no application bug in the message itself and is
    // unreachable by a string-only hook.
    const { lines } = await injectWithLogCapture({
      productionConfigRequired: true,
      method: 'GET',
      url: '/u/SECRET_TOK',
      register: (app) => {
        app.get('/u/:token', (_request, reply) => {
          reply.send('ok');
          reply.send('again');
        });
      },
    });

    const warnLine = lines.find((line) => line.err !== undefined);
    expect(warnLine?.level).toBe(40);
    expect(String(warnLine?.err?.message)).toContain('/u/[REDACTED]');
    expect(JSON.stringify(lines)).not.toContain('SECRET_TOK');
  });

  it('redacts the token from an aggregate error at the production warn level', async () => {
    // pino-std-serializers emits aggregated errors as a SEPARATE recursive array
    // (lib/err.js), which `err.message` / `err.stack` never reach — so the
    // enumerated redact path list needs its own entry for them.
    const { lines } = await injectWithLogCapture({
      productionConfigRequired: true,
      method: 'GET',
      url: '/u/SECRET_TOK',
      register: (app) => {
        app.get('/u/:token', async (request) => {
          throw new AggregateError(
            [new Error(`inner failure at ${request.url}`)],
            'every attempt failed',
          );
        });
      },
    });

    const errorLine = lines.find((line) => line.err !== undefined);
    expect(errorLine?.err?.aggregateErrors).toBeDefined();
    expect(JSON.stringify(lines)).not.toContain('SECRET_TOK');
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
