import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import { redactSensitivePathsAndQueries } from '@/lib/shared/sentry-scrub';

/**
 * Ingress server limits. Fastify's defaults leave requestTimeout at 0
 * (disabled) and no explicit body cap — a slow-loris or slow-body client
 * could exhaust the single Railway worker's connections and block
 * Stripe/Zernio webhooks. Values are owner-selected (prod-hardening spec):
 * 30s request / 60s keep-alive / 10s connect, 5 MB body (headroom for batch
 * Zernio payloads; webhooks are otherwise small).
 *
 * `productionConfigRequired` is the already-made decision, not an env string:
 * the caller resolves the deployment lane (`requiresProductionConfig()`) and
 * passes the answer in, so this module stays free of `process.env`.
 *
 * The logger block also owns URL redaction for the whole ingress server. A
 * route-level `logLevel: 'silent'` applies only AFTER the exact route resolves,
 * so it cannot reach an unmatched 404 like /ingress/unsubscribe/<token>/extra —
 * only global config can, and it must, or the raw Unsubscribe token reaches the
 * logs (invariant #5). Fastify writes that URL in two distinct shapes, so both
 * are covered below; the rule itself is `redactSensitivePathsAndQueries`, shared
 * with the Sentry scrubber.
 */
export function buildFastifyOptions(productionConfigRequired: boolean): FastifyServerOptions {
  return {
    logger: {
      level: productionConfigRequired ? 'warn' : 'info',
      hooks: {
        // Shape 2 — a plain message string. Fastify's default 404 handler logs
        // "Route GET:/ingress/unsubscribe/<token>/extra not found", which no
        // serializer can reach, so without this the unmatched-404 case still
        // leaked the token.
        logMethod(args, method) {
          for (let index = 0; index < args.length; index += 1) {
            const arg = args[index];
            if (typeof arg === 'string') args[index] = redactSensitivePathsAndQueries(arg);
          }
          method.apply(this, args);
        },
      },
      serializers: {
        // Shape 1 — the serialized request object. Fastify emits `incoming
        // request` before onRequest and before any route resolves, copying
        // request.url verbatim.
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: redactSensitivePathsAndQueries(request.url),
          host: request.host,
          remoteAddress: request.ip,
        }),
      },
    },
    requestTimeout: 30_000,
    keepAliveTimeout: 60_000,
    connectionTimeout: 10_000,
    bodyLimit: 5 * 1024 * 1024,
  };
}
