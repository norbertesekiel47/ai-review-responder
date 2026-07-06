import { NextRequest, NextResponse } from 'next/server';
import {
  jsonResponse,
  requireOwnerWithAccount,
} from '@/lib/auth/route-helpers';
import { accountOffboardingEnabled } from '@/lib/account-offboarding/flags';
import { getAccountOffboardingStatus } from '@/lib/account-offboarding/status';
import { sql } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

async function readOffboardingStatus(req: NextRequest): Promise<NextResponse> {
  if (!accountOffboardingEnabled()) {
    return jsonResponse({
      enabled: false,
      accountTimeZone: 'UTC',
      activeOffboarding: null,
    });
  }

  const owner = await requireOwnerWithAccount(req);
  if (!owner.ok) return owner.response;

  const status = await getAccountOffboardingStatus(owner.accountId, sql);
  return jsonResponse({
    enabled: true,
    // The current account schema has no persisted IANA timezone. Keep the
    // display timezone server-owned and explicit until a future schema adds it.
    accountTimeZone: 'UTC',
    activeOffboarding: status.activeOffboarding
      ? routeOffboardingStatus(status.activeOffboarding)
      : null,
  });
}

function routeOffboardingStatus(offboarding: {
  id: string;
  accountId: string;
  mode: string;
  status: string;
  failedStep: string | null;
  accessEndsAt: Date | string | null;
  teardownStartedAt: Date | string | null;
  purgeAfter: Date | string | null;
  operationalUIBlocked: boolean;
}) {
  return {
    id: offboarding.id,
    accountId: offboarding.accountId,
    mode: offboarding.mode,
    status: offboarding.status,
    failedStep: offboarding.failedStep,
    accessEndsAt: offboarding.accessEndsAt,
    teardownStartedAt: offboarding.teardownStartedAt,
    purgeAfter: offboarding.purgeAfter,
    operationalUIBlocked: offboarding.operationalUIBlocked,
  };
}

export const GET = readOffboardingStatus;
