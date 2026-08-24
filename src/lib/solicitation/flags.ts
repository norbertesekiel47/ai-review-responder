import { readFlag } from '@/lib/config/flags';

/** Solicitation watch-mode master switch (design §9.1 decision 4). Default off;
 *  staging flip rides #544 via the flag-flip skill. Gates the contacts upload
 *  surface (routes 404, page hidden) — server-authoritative, invariant #13. */
export function solicitationWatchEnabled(): boolean {
  return readFlag('SOLICITATION_WATCH_ENABLED');
}

/** Solicitation send-mode master switch (#628 decision 7): masters the whole
 *  send surface including ask generation. Default off; the flag exists in no
 *  environment yet, so the generation lane lands inert. Do NOT flip anywhere
 *  before #627's postal-address migration lands (see the #628 deviations
 *  file). Server-authoritative, invariant #13. */
export function solicitationSendEnabled(): boolean {
  return readFlag('SOLICITATION_SEND_ENABLED');
}

/** Auto-approval lane switch (#631, map #617 decision 7). Default off; #633
 *  owns the staging flip via the flag-flip skill. Gates ONLY the Autopilot
 *  lane — SOLICITATION_SEND_ENABLED masters the whole send surface.
 *  Server-authoritative, invariant #13. */
export function solicitationAutoApprovalEnabled(): boolean {
  return readFlag('SOLICITATION_AUTO_APPROVAL_ENABLED');
}
