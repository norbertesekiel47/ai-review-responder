import type { FastifyRequest, FastifyReply } from 'fastify';
import { checkRateLimit } from '@/lib/shared/rate-limit';

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
