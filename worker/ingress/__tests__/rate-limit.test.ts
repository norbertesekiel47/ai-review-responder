import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const { mockCheckRateLimit } = vi.hoisted(() => ({ mockCheckRateLimit: vi.fn() }));
vi.mock('@/lib/shared/rate-limit', () => ({ checkRateLimit: mockCheckRateLimit }));

import { ingressClientIp, enforceIngressRateLimit } from '../rate-limit';

function buildReq(headers: Record<string, string | string[]>, ip = '9.9.9.9'): FastifyRequest {
  return { headers, ip } as unknown as FastifyRequest;
}
function buildReply() {
  const reply = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
  return reply as unknown as FastifyReply & {
    status: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => mockCheckRateLimit.mockReset());

describe('ingressClientIp', () => {
  it('uses the X-Forwarded-For first hop', () => {
    expect(ingressClientIp(buildReq({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe('1.2.3.4');
  });
  it('falls back to request.ip when XFF is absent', () => {
    expect(ingressClientIp(buildReq({}, '5.6.7.8'))).toBe('5.6.7.8');
  });
  it('returns "unknown" when neither is present', () => {
    expect(ingressClientIp(buildReq({}, ''))).toBe('unknown');
  });
  // Documents the deliberate F-21 limitation: XFF is attacker-controlled, so the
  // first hop is the CLAIMED client and can be spoofed/rotated. The limiter is a
  // best-effort volume backstop, not a hard per-IP control (signature verify is
  // the real gate). This test pins that behavior so it isn't "fixed" by accident.
  it('keys on the first XFF hop even when it is a spoofed/forged value', () => {
    expect(ingressClientIp(buildReq({ 'x-forwarded-for': 'totally-spoofed, 203.0.113.9' }, '10.0.0.1'))).toBe(
      'totally-spoofed',
    );
  });
});

describe('enforceIngressRateLimit', () => {
  it('sends 429 when the limiter denies', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const reply = buildReply();
    await enforceIngressRateLimit(buildReq({ 'x-forwarded-for': '1.2.3.4' }), reply);
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({ error: 'rate_limited' });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('ingress:1.2.3.4', 120, 60);
  });
  it('does not respond when the limiter allows', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
    const reply = buildReply();
    await enforceIngressRateLimit(buildReq({ 'x-forwarded-for': '1.2.3.4' }), reply);
    expect(reply.status).not.toHaveBeenCalled();
  });
});
