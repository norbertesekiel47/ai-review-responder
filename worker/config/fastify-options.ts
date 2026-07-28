import type { FastifyServerOptions } from 'fastify';

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
 */
export function buildFastifyOptions(productionConfigRequired: boolean): FastifyServerOptions {
  return {
    logger: { level: productionConfigRequired ? 'warn' : 'info' },
    requestTimeout: 30_000,
    keepAliveTimeout: 60_000,
    connectionTimeout: 10_000,
    bodyLimit: 5 * 1024 * 1024,
  };
}
