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
    role: string;
  }[]>`
    SELECT d.generation_status, d.completed_at, d.source, u.role
    FROM onboarding_demos d
    JOIN users u ON u.id = d.user_id
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
      AND d.generation_status <> 'archived'
    ORDER BY d.created_at DESC
    LIMIT 1
  `;

  if (!row || row.role !== 'owner') {
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
