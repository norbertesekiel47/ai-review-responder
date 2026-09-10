import { NextRequest, NextResponse } from 'next/server';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { betaCompCouponId } from '@/lib/payments/flags';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  return NextResponse.json({ betaCompActive: betaCompCouponId() !== null });
}
