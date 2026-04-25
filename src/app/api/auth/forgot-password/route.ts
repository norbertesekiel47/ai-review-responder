import { NextRequest, NextResponse } from 'next/server';
import { sql, supabaseServer } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { ForgotPasswordSchema } from '@/lib/shared/schemas';
import { getIpKey } from '@/lib/shared/request-ip';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/forgot-password
 *
 * Shared endpoint between the owner-branded `/forgot-password` page (flag-gated)
 * and the admin-branded `/admin/forgot-password` page (never flag-gated — staff
 * need the reset flow regardless of owner self-serve rollout state).
 *
 * Cross-portal protection: an owner email submitted through `/admin/forgot-password`
 * (role='admin') must NOT receive an admin-branded reset link and vice versa.
 * We look up the email's actual role server-side and silently no-op on mismatch —
 * no `resetPasswordForEmail` call happens when roles disagree.
 *
 * Recovery-flow redirect contract: `redirectTo` points at `/api/auth/callback`,
 * NOT directly at the reset page. Supabase's recovery URL lands on a Supabase-
 * hosted page which redirects to `redirectTo` with a recovery `code`. Our
 * callback exchanges the code + sets the session + then redirects to the reset
 * page. If `redirectTo` pointed directly at `/reset-password`, the page would
 * have a `code` query param but NO session.
 *
 * Returns a generic 200 `{ ok: true }` on every non-error outcome (mismatch,
 * unknown email, success) so callers can't use response differences to probe
 * which addresses have accounts.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Parse + validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = ForgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { email: parsedEmail, role } = parsed.data;
  // Schema already normalizes via z.preprocess(trim+lower). Defensive redundant
  // normalization here keeps the invariant obvious at the call site and protects
  // against future schema refactors that might drop the preprocess step.
  const email = parsedEmail.trim().toLowerCase();

  // 2. Body-level flag gate: owner requests 404 when self-serve is off; admin
  //    requests always proceed (staff need reset regardless of rollout state).
  if (role === 'owner' && process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 3. Rate limit on BOTH IP (3/hr) and email (5/hr). Strict mode — Redis down
  //    fails closed with 503 rather than silently allowing unlimited reset
  //    emails (which Supabase would eventually throttle at the API level, but
  //    at the cost of flooding the owner's inbox during an outage). The email
  //    limit was 2/hr originally, but that turned the endpoint into a DoS
  //    amplifier for the victim's email budget — 2 attacker requests would
  //    burn the owner's reset quota for the rest of the hour. 5/hr is loose
  //    enough not to lock legitimate retry traffic out.
  try {
    const ipRl = await checkRateLimit(getIpKey(req, 'forgot-pw'), 3, 3600, { strict: true });
    if (!ipRl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
    const emailRl = await checkRateLimit(
      `forgot-pw:email:${email}`,
      5,
      3600,
      { strict: true },
    );
    if (!emailRl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch (err) {
    console.error('[forgot-password] rate-limit strict failure:', err);
    return NextResponse.json(
      { error: 'rate_limit_unavailable' },
      { status: 503 },
    );
  }

  // 4. Cross-portal protection. Look up the email's actual role and only
  //    trigger the reset email when the submitted role matches what the
  //    DB says. role='admin' accepts both 'admin' and 'sales_partner' —
  //    both portal variants share `/admin/reset-password`.
  const [actual] = await sql<{ role: string }[]>`
    SELECT role FROM users WHERE email = ${email} LIMIT 1
  `;
  const roleMatches =
    actual &&
    ((role === 'owner' && actual.role === 'owner') ||
      (role === 'admin' &&
        (actual.role === 'admin' || actual.role === 'sales_partner')));

  if (roleMatches) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
    const redirectTo =
      role === 'admin'
        ? `${appUrl}/api/auth/callback?flow=admin&next=/admin/reset-password`
        : `${appUrl}/api/auth/callback?flow=owner&next=/reset-password`;
    await supabaseServer.auth
      .resetPasswordForEmail(email, { redirectTo })
      .catch((err) => {
        // Swallow + log: never let a Supabase hiccup leak through as a 500,
        // because the response body would then differ from the no-user-found
        // path and give attackers an enumeration signal.
        console.error(
          '[forgot-password] resetPasswordForEmail failed:',
          err,
        );
      });
  }

  // 5. Generic success response — identical on match, mismatch, and unknown.
  return NextResponse.json({ ok: true });
}
