// src/app/api/admin/channels/_shared/flag-off.ts
//
// Single source for the "channel disabled" response. When a channel's feature
// flag is off, the admin channel routes return the same 404 not_found, so a
// disabled channel is indistinguishable from a missing route. The telegram and
// whatsapp _shared modules re-export this so the contract can't drift per channel.

import { NextResponse } from 'next/server';

export function flagOff(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}
