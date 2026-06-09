import { NextResponse } from 'next/server';
import { checkBotId } from 'botid/server';
import { botIdOptionsForPath } from './botid-routes';

// Server-only. Imports `botid/server`; never import this into client code.

/**
 * Vercel BotID gate for a protected route.
 *
 * Returns a 403 `NextResponse` when BotID classifies the caller as a bot, or
 * `null` to let the request continue to the route's own logic.
 *
 * Call it AFTER the cheap deterministic guards a route already has (feature-flag
 * 404s, same-origin/CSRF checks) and BEFORE rate limits or any DB/side-effect
 * work — so disabled or cross-origin requests don't incur a (billed) Deep
 * Analysis call, and a detected bot is rejected before doing real work.
 *
 * Failure posture:
 * - An unregistered path throws (programmer error — surfaced loudly, NOT caught).
 * - The positive bot signal (`isBot`) always rejects with 403.
 * - If the BotID platform check itself ERRORS (Vercel bot-protection API blip,
 *   missing OIDC token, etc.) we LOG and FAIL OPEN — returning `null` so the
 *   request proceeds to the route's existing rate limits and the Vercel WAF
 *   layers, rather than 500-ing signup/login/onboarding for every real user
 *   during a BotID outage. This mirrors the app-wide "rate limits fail open"
 *   posture (see CLAUDE.md "Non-obvious gotchas"): availability for real owners
 *   during an infra blip outranks briefly letting a bot through, which the
 *   volumetric layers underneath still cap.
 */
export async function botIdBlockResponse(path: string): Promise<NextResponse | null> {
  // Resolve options OUTSIDE the try so a misconfigured (unregistered) path
  // throws instead of being swallowed as a fail-open.
  const options = botIdOptionsForPath(path);

  let verification: Awaited<ReturnType<typeof checkBotId>>;
  try {
    verification = await checkBotId(options);
  } catch (err) {
    console.error(`[botid] platform check failed for ${path} — failing open:`, err);
    return null;
  }

  if (verification.isBot) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}
