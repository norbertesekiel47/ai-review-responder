import { NextResponse, type NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import {
  hashUnsubscribeToken,
  isWellFormedUnsubscribeToken,
  mintUnsubscribeReceipt,
  redeemUnsubscribeToken,
  redemptionConfirmsSuppression,
} from '@/lib/solicitation/unsubscribe';

/**
 * `POST /api/u/<token>` — the button on `/u/<token>` (#644 §5.3).
 *
 * Lands on Vercel, not the worker: invariant #1 bans LLM calls, external API
 * calls, and long-running work in a Next.js route, not a Postgres write, and
 * invariant #6 governs third-party ingress — a human clicking our own button is
 * neither. The RFC 8058 one-click path stays on Railway (`worker/ingress`).
 *
 * Unauthenticated, unrate-limited, and cross-site POSTs are accepted by design
 * (§9.2): a token can only suppress the handle it already belongs to, and a
 * throttled unsubscribe is a silently lost statutory opt-out.
 *
 * Answers with a 303 in every case so the browser re-issues the landing page as
 * a GET — a refresh can never replay the write, and the page stays the single
 * owner of what the recipient is told.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  // Same-origin: the landing page is this app, and deriving the origin from the
  // request keeps preview, staging, and production correct without config.
  const landingUrl = new URL(`/u/${encodeURIComponent(token)}`, new URL(request.url).origin);

  // The admission gate FIRST — a forged or random string costs one HMAC compare
  // and never opens a connection, which is what lets this route stay unthrottled.
  if (!isWellFormedUnsubscribeToken(token)) return seeOther(landingUrl);

  const outcome = await sql.begin((tx) =>
    redeemUnsubscribeToken(tx, { rawToken: token, source: 'unsubscribe_link' }),
  );

  // The ONLY sanctioned success test. `status !== 'unknown_token'` reads as a
  // reasonable substitute and is wrong for `already_redeemed_not_suppressed` —
  // a spent token whose suppression the Correction path removed, which must not
  // be handed evidence that lets the page claim success.
  if (!redemptionConfirmsSuppression(outcome)) return seeOther(landingUrl);

  // Minted only now: `sql.begin` resolves after COMMIT returns, so a receipt
  // cannot exist for a write that never landed.
  landingUrl.searchParams.set('ok', mintUnsubscribeReceipt(hashUnsubscribeToken(token), Date.now()));
  return seeOther(landingUrl);
}

function seeOther(location: URL): NextResponse {
  return NextResponse.redirect(location, {
    status: 303,
    headers: { 'Cache-Control': 'no-store' },
  });
}
