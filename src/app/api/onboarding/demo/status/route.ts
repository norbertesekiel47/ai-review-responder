import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { onboardingDemoEnabled } from '@/lib/onboarding/flags';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

interface OwnerRow {
  user_id: string;
  business_id: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!onboardingDemoEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // Soft rate limit: 60/auth-id/minute. Read endpoint — Redis-down allowed.
  try {
    const rl = await checkRateLimit(`demo-status:auth:${user.id}`, 60, 60);
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
    }
  } catch {
    // intentional: read endpoint, allow on Redis flake
  }

  const [owner] = await sql<OwnerRow[]>`
    SELECT u.id AS user_id, b.id AS business_id
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
    LIMIT 1
  `;
  if (!owner) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  // Exclude 'archived' rows so a 23505 race-loser (archived in lifecycle.ts)
  // doesn't shadow the actual winning completed row when both exist for the
  // same user with overlapping created_at order.
  const [row] = await sql<{
    generation_status: string;
    completed_at: Date | null;
    source: string | null;
  }[]>`
    SELECT d.generation_status, d.completed_at, d.source
    FROM onboarding_demos d
    WHERE d.user_id = ${owner.user_id}::uuid
      AND d.business_id = ${owner.business_id}::uuid
      AND d.generation_status <> 'archived'
    ORDER BY d.created_at DESC
    LIMIT 1
  `;

  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json(
    {
      status: row.generation_status,
      completedAt: row.completed_at?.toISOString(),
      source: row.source ?? undefined,
    },
    { status: 200, headers: NO_STORE },
  );
}
