import { NextResponse } from 'next/server';

// Dependency-light by contract: no DB, LLM, Stripe, Zernio, or PostHog calls.
// Used by external synthetic checks; must stay fast and side-effect free.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: 'ok',
    service: 'web',
    timestamp: new Date().toISOString(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}
