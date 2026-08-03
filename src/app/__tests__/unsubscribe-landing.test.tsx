// @vitest-environment jsdom
//
// #644 T2 — the recipient-facing `/u/<token>` path, end to end.
//
// The crypto is REAL (token gate, receipt mint, receipt verify) and only the
// three database-touching functions are faked, by an in-memory Suppression
// ledger with real state transitions. That split is deliberate: the §1.8 tests
// turn on a suppression genuinely DISAPPEARING between the POST and the GET,
// and a `mockResolvedValue(false)` at the render-time check would assert
// nothing about the page's behaviour — it would assert the mock's.

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  hashUnsubscribeToken,
  mintUnsubscribeRawToken,
  mintUnsubscribeReceipt,
  verifyUnsubscribeReceipt,
} from '@/lib/solicitation/unsubscribe';
import { resetServerConfigForTests } from '@/lib/config/server';
import UnsubscribeLandingPage, { metadata } from '../(public)/u/[token]/page';
import { POST } from '../api/u/[token]/route';
import robots from '../robots';

const TEST_SECRET = 'test-session-cookie-secret-at-least-32-chars';
const TEN_MINUTES_MS = 10 * 60 * 1000;
const APP_ORIGIN = 'https://app.example.com';
const MAILTO = 'unsubscribe@feedback.repworth.net';
const BUSINESS_NAME = 'Blue Bottle Coffee';

const ledger = vi.hoisted(() => {
  interface FakeTokenRow {
    businessName: string | null;
    handle: string;
    redeemed: boolean;
  }
  const tokens = new Map<string, FakeTokenRow>();
  const suppressedHandles = new Set<string>();
  let redemptionWrites = 0;
  const events: string[] = [];

  function rowFor(rawToken: string): FakeTokenRow | undefined {
    return tokens.get(rawToken);
  }

  return {
    reset(): void {
      tokens.clear();
      suppressedHandles.clear();
      redemptionWrites = 0;
      events.length = 0;
    },
    /** Registers an unredeemed token, as #630's mint would. */
    mint(rawToken: string, businessName: string | null): void {
      tokens.set(rawToken, { businessName, handle: `handle:${rawToken}`, redeemed: false });
    },
    /** The audited Correction path (§8.2): removes a live global row. */
    correctionPathRemoves(rawToken: string): void {
      const row = rowFor(rawToken);
      if (row === undefined) throw new Error('correction path called for an unminted token');
      suppressedHandles.delete(row.handle);
    },
    isSuppressed(rawToken: string): boolean {
      const row = rowFor(rawToken);
      return row !== undefined && suppressedHandles.has(row.handle);
    },
    redemptionWrites: (): number => redemptionWrites,
    events: (): readonly string[] => events,
    record(event: string): void {
      events.push(event);
    },

    // ── the three faked database functions ────────────────────────────────
    // The fake lookup deliberately does NOT re-run the admission gate the real
    // one runs first, so a reserved-character token still reaches the button
    // page and the page's encoding obligation stays observable. The real gate
    // is covered in src/lib/solicitation/__tests__/unsubscribe.test.ts.
    async findRedeemableUnsubscribeToken(
      _db: unknown,
      rawToken: string,
    ): Promise<{ businessName: string | null } | null> {
      const row = rowFor(rawToken);
      if (row === undefined || row.redeemed) return null;
      return { businessName: row.businessName };
    },
    async redeemUnsubscribeToken(
      _tx: unknown,
      input: { rawToken: string },
    ): Promise<{ status: string; tokenHashPrefix: string }> {
      events.push('redeem');
      const row = rowFor(input.rawToken);
      if (row === undefined) return { status: 'unknown_token', tokenHashPrefix: '' };
      if (!row.redeemed) {
        row.redeemed = true;
        suppressedHandles.add(row.handle);
        redemptionWrites += 1;
        return { status: 'redeemed', tokenHashPrefix: 'fakehash' };
      }
      return {
        status: suppressedHandles.has(row.handle)
          ? 'already_suppressed'
          : 'already_redeemed_not_suppressed',
        tokenHashPrefix: 'fakehash',
      };
    },
    async hasLiveGlobalSuppressionForToken(_db: unknown, rawToken: string): Promise<boolean> {
      const row = rowFor(rawToken);
      return row !== undefined && suppressedHandles.has(row.handle);
    },
  };
});

const { mockBegin } = vi.hoisted(() => ({
  mockBegin: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const result = await fn({});
    // postgres.js resolves sql.begin() only after COMMIT returns.
    ledger.record('commit');
    return result;
  }),
}));

vi.mock('@/lib/db/server', () => ({ sql: { begin: mockBegin } }));

vi.mock('@/lib/solicitation/unsubscribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solicitation/unsubscribe')>();
  return {
    ...actual,
    findRedeemableUnsubscribeToken: ledger.findRedeemableUnsubscribeToken,
    redeemUnsubscribeToken: ledger.redeemUnsubscribeToken,
    hasLiveGlobalSuppressionForToken: ledger.hasLiveGlobalSuppressionForToken,
    // Real HMAC, wrapped only to observe WHEN it runs relative to the commit.
    mintUnsubscribeReceipt: (tokenHash: string, issuedAtMs: number) => {
      ledger.record('mint');
      return actual.mintUnsubscribeReceipt(tokenHash, issuedAtMs);
    },
  };
});

// Keep the assertions on page behaviour, not on the island chrome.
vi.mock('@/components/ui/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function renderLanding(token: string, searchParams: Record<string, string | string[]> = {}) {
  return UnsubscribeLandingPage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(searchParams),
  });
}

function postUnsubscribe(token: string) {
  return POST(new NextRequest(`${APP_ORIGIN}/api/u/${encodeURIComponent(token)}`, { method: 'POST' }), {
    params: Promise.resolve({ token }),
  });
}

/**
 * The receipt a real POST handed back, read off its redirect. The Location is
 * relative on purpose, so it is resolved against a throwaway base here.
 */
function receiptFrom(response: Response): string | null {
  const location = response.headers.get('location');
  if (location === null) return null;
  return new URL(location, APP_ORIGIN).searchParams.get('ok');
}

describe('/u/<token> unsubscribe landing', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('SESSION_COOKIE_SECRET', TEST_SECRET);
    vi.stubEnv('SOLICITATION_UNSUBSCRIBE_MAILTO', undefined);
    resetServerConfigForTests();
    ledger.reset();
    mockBegin.mockClear();
  });

  it('POST commits the suppression row then 303s with a signed receipt', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);

    const response = await postUnsubscribe(token);

    expect(response.status).toBe(303);
    expect(ledger.isSuppressed(token)).toBe(true);
    // The receipt may only be minted AFTER the write commits.
    expect(ledger.events()).toEqual(['redeem', 'commit', 'mint']);
    const receipt = receiptFrom(response);
    expect(receipt).not.toBeNull();
    expect(verifyUnsubscribeReceipt(hashUnsubscribeToken(token), receipt!)).toBe(true);
  });

  it('POST with an unknown token 303s to the neutral page and writes nothing', async () => {
    const token = mintUnsubscribeRawToken(); // well-formed, but never minted in the ledger

    const response = await postUnsubscribe(token);

    expect(response.status).toBe(303);
    // Relative on purpose: the browser resolves it against the origin that
    // served the POST, so a spoofed Host cannot move the recipient off-site.
    expect(response.headers.get('location')).toBe(`/u/${encodeURIComponent(token)}`);
    expect(receiptFrom(response)).toBeNull();
    expect(ledger.redemptionWrites()).toBe(0);
  });

  it('encodes reserved characters in the form action and redirect target', async () => {
    // `a%2Fb` in the URL decodes to the token `a/b`; unencoded it would become a
    // two-segment path that 404s instead of reaching the neutral page.
    const token = 'a/b';
    ledger.mint(token, BUSINESS_NAME);

    const { container } = render(await renderLanding(token));
    expect(container.querySelector('form')).toHaveAttribute('action', '/api/u/a%2Fb');

    const response = await postUnsubscribe(token);
    expect(response.headers.get('location')).toBe('/u/a%2Fb');
    // A malformed token never reaches the database.
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it('GET renders the button page and writes nothing', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);

    render(await renderLanding(token));

    expect(screen.getByRole('button', { name: /unsubscribe me/i })).toBeInTheDocument();
    expect(ledger.redemptionWrites()).toBe(0);
    expect(ledger.isSuppressed(token)).toBe(false);
    expect(mockBegin).not.toHaveBeenCalled();
  });

  it('GET names the originating business when provenance resolves', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);

    render(await renderLanding(token));

    expect(screen.getByText(new RegExp(BUSINESS_NAME))).toBeInTheDocument();
  });

  it('GET falls back to generic copy when the token business provenance was scrubbed', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, null);

    render(await renderLanding(token));

    expect(screen.getByText(/the business that contacted you/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unsubscribe me/i })).toBeInTheDocument();
  });

  it('unknown malformed and already-redeemed tokens render the identical neutral page', async () => {
    const unknown = mintUnsubscribeRawToken();
    const malformed = 'not-a-token';
    const spent = mintUnsubscribeRawToken();
    ledger.mint(spent, BUSINESS_NAME);
    await postUnsubscribe(spent);

    const renders = await Promise.all(
      [unknown, malformed, spent].map(async (token) => {
        const { container } = render(await renderLanding(token));
        return container.innerHTML;
      }),
    );

    expect(renders[1]).toBe(renders[0]);
    expect(renders[2]).toBe(renders[0]);
    expect(renders[0]).not.toContain(BUSINESS_NAME);
  });

  it('the neutral page surfaces the mailto fallback when the address is configured', async () => {
    vi.stubEnv('SOLICITATION_UNSUBSCRIBE_MAILTO', MAILTO);
    resetServerConfigForTests();

    render(await renderLanding(mintUnsubscribeRawToken()));

    expect(screen.getByRole('link', { name: MAILTO })).toHaveAttribute('href', `mailto:${MAILTO}`);
  });

  it('the neutral page omits the mailto line when the address is unset', async () => {
    const { container } = render(await renderLanding(mintUnsubscribeRawToken()));

    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(container.innerHTML).not.toContain('mailto');
  });

  it('the success page names no business', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);
    const receipt = receiptFrom(await postUnsubscribe(token));

    const { container } = render(await renderLanding(token, { ok: receipt! }));

    expect(screen.getByRole('heading', { level: 1, name: /you're unsubscribed/i })).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(BUSINESS_NAME);
  });

  it('the landing page renders exactly one main content landmark', async () => {
    const buttonPageToken = mintUnsubscribeRawToken();
    ledger.mint(buttonPageToken, BUSINESS_NAME);
    const successToken = mintUnsubscribeRawToken();
    ledger.mint(successToken, BUSINESS_NAME);
    const receipt = receiptFrom(await postUnsubscribe(successToken));

    const states: Array<[string, Record<string, string>]> = [
      [buttonPageToken, {}],
      [mintUnsubscribeRawToken(), {}],
      [successToken, { ok: receipt! }],
    ];
    for (const [token, searchParams] of states) {
      const { container } = render(await renderLanding(token, searchParams));
      expect(container.querySelectorAll('main#main-content')).toHaveLength(1);
      expect(container.querySelectorAll('main')).toHaveLength(1);
    }
  });

  it('is excluded from search indexing', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('robots disallows the unsubscribe landing path', () => {
    const [rule] = [robots().rules].flat();
    expect(rule?.disallow).toContain('/u/');
  });

  // Deviations D4: Vercel does not assert SESSION_COOKIE_SECRET at boot, so the
  // throw from getSessionCookieSecret() must reach the caller as a 500. Catching
  // it into the neutral page would render "we couldn't find that link" for every
  // recipient of every business — a silent, total statutory failure wearing the
  // face of a normal answer.
  it('a missing session secret fails loudly instead of rendering the neutral page', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);
    vi.stubEnv('SESSION_COOKIE_SECRET', undefined);
    resetServerConfigForTests();
    // Inside its TTL, so verification reaches the HMAC rather than short-circuiting.
    const receipt = `${Date.now()}.${'A'.repeat(43)}`;

    await expect(renderLanding(token, { ok: receipt })).rejects.toThrow(/SESSION_COOKIE_SECRET/);
    await expect(postUnsubscribe(token)).rejects.toThrow(/SESSION_COOKIE_SECRET/);
  });

  it('a crafted done query parameter never renders the success copy', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);

    render(await renderLanding(token, { done: '1' }));

    expect(screen.queryByText(/you're unsubscribed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unsubscribe me/i })).toBeInTheDocument();
  });

  it('a forged receipt never renders the success copy', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);
    await postUnsubscribe(token);
    const forged = `${Date.now()}.${'A'.repeat(43)}`;
    expect(verifyUnsubscribeReceipt(hashUnsubscribeToken(token), forged)).toBe(false);

    render(await renderLanding(token, { ok: forged }));

    expect(screen.queryByText(/you're unsubscribed/i)).not.toBeInTheDocument();
  });

  it('an expired receipt never renders the success copy', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);
    await postUnsubscribe(token);
    const expired = mintUnsubscribeReceipt(
      hashUnsubscribeToken(token),
      Date.now() - TEN_MINUTES_MS - 1_000,
    );
    // The suppression is live; only the receipt's age disqualifies it.
    expect(ledger.isSuppressed(token)).toBe(true);

    render(await renderLanding(token, { ok: expired }));

    expect(screen.queryByText(/you're unsubscribed/i)).not.toBeInTheDocument();
  });

  it('the success copy renders only for a receipt minted after a committed write', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);
    const other = mintUnsubscribeRawToken();
    ledger.mint(other, BUSINESS_NAME);
    const receipt = receiptFrom(await postUnsubscribe(token));
    const otherReceipt = receiptFrom(await postUnsubscribe(other));

    render(await renderLanding(token, { ok: receipt! }));
    expect(screen.getByRole('heading', { level: 1, name: /you're unsubscribed/i })).toBeInTheDocument();

    // A receipt bound to a different committed write proves nothing about this one.
    const { container } = render(await renderLanding(token, { ok: otherReceipt! }));
    expect(container.innerHTML).not.toContain("You're unsubscribed");
  });

  it('a spent token whose suppression was removed by the correction path mints no receipt', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);
    await postUnsubscribe(token);
    ledger.correctionPathRemoves(token);

    const replay = await postUnsubscribe(token);

    expect(replay.status).toBe(303);
    expect(receiptFrom(replay)).toBeNull();
    // The replay must not re-suppress: that would undo an audited correction.
    expect(ledger.isSuppressed(token)).toBe(false);
  });

  it('a spent token with a live global suppression still mints a receipt', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);
    await postUnsubscribe(token);

    const replay = await postUnsubscribe(token);

    const receipt = receiptFrom(replay);
    expect(receipt).not.toBeNull();
    expect(verifyUnsubscribeReceipt(hashUnsubscribeToken(token), receipt!)).toBe(true);
  });

  it('a correction landing between POST and GET renders the neutral state', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);
    const receipt = receiptFrom(await postUnsubscribe(token));

    ledger.correctionPathRemoves(token);

    const { container } = render(await renderLanding(token, { ok: receipt! }));
    const { container: neutral } = render(await renderLanding(mintUnsubscribeRawToken()));
    expect(container.innerHTML).toBe(neutral.innerHTML);
  });

  it('a verified receipt with no live suppression renders the neutral state', async () => {
    const token = mintUnsubscribeRawToken();
    ledger.mint(token, BUSINESS_NAME);
    const receipt = receiptFrom(await postUnsubscribe(token));
    ledger.correctionPathRemoves(token);

    // The receipt itself is still cryptographically good and inside its TTL —
    // the ledger read taken during the render is what makes the claim false.
    expect(verifyUnsubscribeReceipt(hashUnsubscribeToken(token), receipt!)).toBe(true);
    expect(ledger.isSuppressed(token)).toBe(false);

    render(await renderLanding(token, { ok: receipt! }));

    expect(screen.queryByText(/you're unsubscribed/i)).not.toBeInTheDocument();
  });
});
