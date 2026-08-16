// src/lib/notifications/channels/availability.ts
//
// "Can an owner enrol in this channel right now?" — the AND of the channel's
// feature flag (`flags.ts`) and its transport env being fully configured
// (`telegram-env.ts` / `whatsapp-env.ts`). Single owner of that conjunction:
// the owner Channels page and GET /api/dashboard/channels each spelled it out,
// byte-identically, and a page that disagreed with its own status endpoint
// would offer an enrolment the endpoint then refuses.
//
// Lives beside the flag/env modules rather than under `api/` for the reason
// recorded in CLAUDE.md: a server-component page reads it too.
//
// Server-only by construction (invariant #13) — these read `process.env`. The
// browser receives the resolved booleans as props / in an API response, never
// a `NEXT_PUBLIC_*` companion.

import { channelsTelegramEnabled, channelsWhatsappEnabled } from './flags';
import { assertTelegramEnvReady } from './telegram-env';
import { whatsappEnvReady } from './whatsapp-env';

export function telegramAvailable(): boolean {
  if (!channelsTelegramEnabled()) return false;
  // assertTelegramEnvReady returns a NextResponse describing what is missing,
  // or null when the transport is fully configured.
  return assertTelegramEnvReady() === null;
}

export function whatsappAvailable(): boolean {
  if (!channelsWhatsappEnabled()) return false;
  return whatsappEnvReady();
}
