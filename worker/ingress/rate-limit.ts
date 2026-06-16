import type { FastifyRequest, FastifyReply } from 'fastify';
import { checkRateLimit } from '@/lib/shared/rate-limit';

// Generous per-IP DoS/abuse backstop. Providers (Stripe/Twilio/Telegram/Zernio)
// burst many webhooks from the same source IP, so the ceiling is high — this
// bounds flood/work-amplification, NOT per-tenant traffic (signature verify
// already gates forgery). checkRateLimit fails open on a Redis error, so a
// blip never drops a legitimate webhook.
const INGRESS_MAX_PER_MINUTE = 120;
const INGRESS_WINDOW_SECONDS = 60;

// Fastify runs without trustProxy, so request.ip is the Railway edge proxy.
// Read the X-Forwarded-For first hop (the real client) for keying, scoped to
// this limiter — avoids a global trustProxy change. Falls back to request.ip.
//
// NOTE: XFF is attacker-controlled — a determined abuser can rotate the header
// to bypass this per-IP limit. That is acceptable here: signature verification
// is the real forgery gate; this limiter only bounds unverified flood volume.
// 'unknown' is a safety valve (both XFF and request.ip empty) — practically
// unreachable behind Railway's edge, not an expected production key.
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
