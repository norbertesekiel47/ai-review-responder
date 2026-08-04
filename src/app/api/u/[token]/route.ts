import { NextResponse, type NextRequest } from 'next/server';
import { sql } from '@/lib/db/server';
import {
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
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;
  // A RELATIVE Location (RFC 7231 §7.1.2): the browser resolves it against the
  // origin that served this POST, so the recipient lands on our page whatever
  // the Host header claimed and whatever origin the form was submitted from.
  // Deriving an absolute origin from the request would make a public,
  // cross-site-postable endpoint trust an attacker-supplied header — the same
  // "never trust the raw request target" lesson as deviations D11.
  const landingPath = `/u/${encodeURIComponent(token)}`;

  // The admission gate FIRST — a forged or random string costs one HMAC compare
  // and never opens a connection, which is what lets this route stay unthrottled.
  if (!isWellFormedUnsubscribeToken(token)) return seeOther(landingPath);

  const outcome = await sql.begin((tx) =>
    redeemUnsubscribeToken(tx, { rawToken: token, source: 'unsubscribe_link' }),
  );

  // The ONLY sanctioned success test. `status !== 'unknown_token'` reads as a
  // reasonable substitute and is wrong for `already_redeemed_not_suppressed` —
  // a spent token whose suppression the Correction path removed, which must not
  // be handed evidence that lets the page claim success.
  if (!redemptionConfirmsSuppression(outcome)) return seeOther(landingPath);

  // Minted only now: `sql.begin` resolves after COMMIT returns, so a receipt
  // cannot exist for a write that never landed.
  const receipt = mintUnsubscribeReceipt(token, Date.now());
  return seeOther(`${landingPath}?ok=${encodeURIComponent(receipt)}`);
}

// Built by hand rather than via NextResponse.redirect, which requires an
// absolute URL and would reintroduce the Host-header dependency above.
function seeOther(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}
