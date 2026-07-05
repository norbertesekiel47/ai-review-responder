// src/app/api/settings/channels/overrides/route.ts
//
// GET endpoint for the per-location channel override view. Used by
// ChannelsTabClient to refresh after add/remove operations. Returns the full
// ChannelOverridesView (overrides + locations + verifiedOrgChannels) so the
// client can refresh everything it rendered from SSR, not just the override
// list.
//
// VAL-SETTINGS-013: Per-location override panel collapsed by default.
// VAL-SETTINGS-015: Per-location override displays location name label.

import { NextRequest, NextResponse } from 'next/server';
import { jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { getChannelOverridesView } from '@/lib/channels/overrides-view';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;

  const view = await getChannelOverridesView(sql, owner.accountId);
  return jsonResponse(view);
}
