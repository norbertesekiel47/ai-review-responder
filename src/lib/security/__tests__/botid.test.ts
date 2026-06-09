import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCheckBotId } = vi.hoisted(() => ({ mockCheckBotId: vi.fn() }));
vi.mock('botid/server', () => ({ checkBotId: mockCheckBotId }));

import { botIdBlockResponse } from '../botid';
import { BOTID_PROTECTED_ROUTES, botIdOptionsForPath } from '../botid-routes';

const HUMAN = { isBot: false, isHuman: true, isVerifiedBot: false, bypassed: false };
const BOT = { isBot: true, isHuman: false, isVerifiedBot: false, bypassed: false };

describe('botid-routes — single source of truth', () => {
  // These exact path→level pairs are the contract the client instrumentation
  // (initBotId) and the server routes both derive from. If this list changes,
  // BOTH sides must change together — a client/server checkLevel mismatch makes
  // BotID fail-block legitimate traffic.
  const EXPECTED: Record<string, 'deepAnalysis' | 'basic'> = {
    '/api/auth/signup': 'deepAnalysis',
    '/api/onboarding/start': 'deepAnalysis',
    '/api/auth/login-attempt': 'basic',
    '/api/lead-intake': 'basic',
  };

  it('does NOT register the dead /api/contact + /api/demo-request remnants', () => {
    const paths = BOTID_PROTECTED_ROUTES.map((r) => r.path);
    expect(paths).not.toContain('/api/contact');
    expect(paths).not.toContain('/api/demo-request');
    expect(() => botIdOptionsForPath('/api/contact')).toThrow(/No BotID protection/);
  });

  it('registers exactly the expected routes, methods, and levels', () => {
    const actual = Object.fromEntries(
      BOTID_PROTECTED_ROUTES.map((r) => [r.path, r.checkLevel]),
    );
    expect(actual).toEqual(EXPECTED);
    expect(BOTID_PROTECTED_ROUTES.every((r) => r.method === 'POST')).toBe(true);
  });

  it('botIdOptionsForPath returns the registered checkLevel for each path', () => {
    for (const [path, level] of Object.entries(EXPECTED)) {
      expect(botIdOptionsForPath(path)).toEqual({ advancedOptions: { checkLevel: level } });
    }
  });

  it('botIdOptionsForPath throws for an unregistered path', () => {
    expect(() => botIdOptionsForPath('/api/not-protected')).toThrow(/No BotID protection/);
  });
});

describe('botIdBlockResponse', () => {
  beforeEach(() => {
    mockCheckBotId.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null (allows) for a human', async () => {
    mockCheckBotId.mockResolvedValue(HUMAN);
    expect(await botIdBlockResponse('/api/lead-intake')).toBeNull();
  });

  it('returns a 403 { error: "forbidden" } for a bot', async () => {
    mockCheckBotId.mockResolvedValue(BOT);
    const res = await botIdBlockResponse('/api/auth/signup');
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({ error: 'forbidden' });
  });

  it('passes the per-route checkLevel through to checkBotId', async () => {
    mockCheckBotId.mockResolvedValue(HUMAN);
    await botIdBlockResponse('/api/auth/signup');
    expect(mockCheckBotId).toHaveBeenLastCalledWith({ advancedOptions: { checkLevel: 'deepAnalysis' } });

    await botIdBlockResponse('/api/lead-intake');
    expect(mockCheckBotId).toHaveBeenLastCalledWith({ advancedOptions: { checkLevel: 'basic' } });
  });

  it('FAILS OPEN (returns null) and logs when the BotID platform check throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCheckBotId.mockRejectedValue(new Error('bot-protection API unreachable'));
    expect(await botIdBlockResponse('/api/auth/signup')).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('throws (does NOT fail open) when called with an unregistered path — programmer error', async () => {
    mockCheckBotId.mockResolvedValue(HUMAN);
    await expect(botIdBlockResponse('/api/not-protected')).rejects.toThrow(/No BotID protection/);
    expect(mockCheckBotId).not.toHaveBeenCalled();
  });
});
