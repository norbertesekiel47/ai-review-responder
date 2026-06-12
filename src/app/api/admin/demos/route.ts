import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import type { DemoListItem } from '@/lib/demos/types';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const rows = await sql<
      {
        id: string;
        demo_url_slug: string;
        business_name: string;
        generation_status: string;
        generation_error: string | null;
        view_count: number;
        generated_at: Date;
        expires_at: Date;
      }[]
    >`
      SELECT id, demo_url_slug, business_name, generation_status,
             generation_error, view_count, generated_at, expires_at
      FROM prospect_demos
      ORDER BY generated_at DESC
    `;

    const demos: DemoListItem[] = rows.map((row) => ({
      id: row.id,
      slug: row.demo_url_slug,
      businessName: row.business_name,
      generationStatus: row.generation_status,
      generationError: row.generation_error,
      viewCount: row.view_count,
      createdAt: row.generated_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    }));

    return NextResponse.json(demos);
  } catch (error) {
    reportCaughtError('api/demos', error);
    return NextResponse.json(
      { error: 'Failed to fetch demos' },
      { status: 500 },
    );
  }
}
