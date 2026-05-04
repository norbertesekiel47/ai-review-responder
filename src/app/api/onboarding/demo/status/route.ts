import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') {
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

  // Exclude 'archived' rows so a 23505 race-loser (archived in lifecycle.ts)
  // doesn't shadow the actual winning completed row when both exist for the
  // same user with overlapping created_at order.
  const [row] = await sql<{
    generation_status: string;
    completed_at: Date | null;
    source: string | null;
  }[]>`
    SELECT generation_status, completed_at, source
    FROM onboarding_demos
    WHERE user_id = (SELECT id FROM users WHERE auth_id = ${user.id} LIMIT 1)
      AND generation_status <> 'archived'
    ORDER BY created_at DESC
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
