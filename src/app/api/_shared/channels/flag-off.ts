// src/app/api/_shared/channels/flag-off.ts
//
// Single source for the "channel disabled" response. When a channel's feature
// flag is off, every channel route — both portals, both channels — returns the
// same 404 not_found, so a disabled channel is indistinguishable from a missing
// route. The three runners call this directly; it is deliberately NOT a config
// field, because it never varied across the 12 call sites.

import { NextResponse } from 'next/server';

export function flagOff(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}
