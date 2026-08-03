import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { checkRateLimit } from '@/lib/shared/rate-limit';

// The opt-out flag lives beside the rule it governs. `fastify-raw-body` augments
// FastifyContextConfig with only `rawBody` and Fastify's own interface is
// otherwise empty, so without this the config read below does not typecheck.
declare module 'fastify' {
  interface FastifyContextConfig {
    /** Opt a route out of the global /ingress/ limiter (§9.2). Statutory paths only. */
    skipIngressRateLimit?: boolean;
  }
}

const INGRESS_PATH_PREFIX = '/ingress/';

// BEST-EFFORT per-IP DoS/abuse backstop — NOT a hard per-IP control (F-21 is
// closed as best-effort, see the design doc). Providers (Stripe/Twilio/Telegram/
// Zernio) burst many webhooks from the same source IP, so the ceiling is high —
// this bounds flood/work-amplification, NOT per-tenant traffic. checkRateLimit
// fails open on a Redis error, so a blip never drops a legitimate webhook.
const INGRESS_MAX_PER_MINUTE = 120;
const INGRESS_WINDOW_SECONDS = 60;

// Best-effort client-IP key. Fastify runs without trustProxy, so request.ip is
// the Railway edge proxy; we read the X-Forwarded-For first hop (the CLAIMED
// client) instead, scoped to this limiter (avoids a global trustProxy change).
//
// LIMITATION (deliberate): XFF is attacker-controlled and Railway does not
// document a non-spoofable client-IP header, so a determined abuser can rotate
// the header to evade the per-IP cap. That is acceptable: signature verification
// is the real forgery gate; this limiter only throttles honest/unsophisticated
// flood volume + the unauthenticated work (sig-verify + dedup claim) it triggers.
// A reliable per-IP close would need a trusted CDN header (e.g. CF-Connecting-IP)
// — deferred, see the design doc §7. 'unknown' is a safety valve (both XFF and
// request.ip empty) — practically unreachable behind Railway's edge.
export function ingressClientIp(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  const firstHop = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return firstHop || request.ip || 'unknown';
}

export async function enforceIngressRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { allowed } = await checkRateLimit(
    `ingress:${ingressClientIp(request)}`,
    INGRESS_MAX_PER_MINUTE,
    INGRESS_WINDOW_SECONDS,
  );
  if (!allowed) {
    reply.status(429).send({ error: 'rate_limited' });
  }
}

/**
 * Installs the per-IP backstop on every `/ingress/*` route. Registered from the
 * composition root but owned here, beside the limiter and the exemption flag —
 * the scoping rule below is policy, not wiring, and it has been wrong twice.
 *
 * `onRequest` runs before body parsing and before signature verification, so a
 * 429 short-circuits the lifecycle and the handler never runs.
 *
 * **Both arms of the scope test are required.** An unmatched path yields
 * `routeOptions.url === undefined`, so a resolved-route-only test would drop
 * every 404 out of the hook and reopen an unthrottled flood namespace. A
 * raw-URL-only test — what shipped before #644 — misses `/%69ngress/resend`,
 * which resolves to the real route while failing a literal prefix compare, and
 * therefore escaped the limiter entirely on EVERY provider.
 *
 * The **exemption** keys strictly on resolved route config, never on the URL, so
 * an unmatched path can never inherit it.
 */
export function registerIngressRateLimitHook(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const isIngress =
      request.routeOptions.url?.startsWith(INGRESS_PATH_PREFIX) === true ||
      decodeIngressPath(request.url).startsWith(INGRESS_PATH_PREFIX);
    if (!isIngress) return;
    if (request.routeOptions.config?.skipIngressRateLimit === true) return;
    await enforceIngressRateLimit(request, reply);
  });
}

/** Total: any string in, a path out. Malformed percent-encoding falls back raw. */
function decodeIngressPath(url: string): string {
  const boundary = url.search(/[?#]/);
  const rawPath = boundary === -1 ? url : url.slice(0, boundary);
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}
