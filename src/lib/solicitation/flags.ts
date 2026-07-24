import { readFlag } from '@/lib/config/flags';

/** Solicitation watch-mode master switch (design §9.1 decision 4). Default off;
 *  staging flip rides #544 via the flag-flip skill. Gates the contacts upload
 *  surface (routes 404, page hidden) — server-authoritative, invariant #13. */
export function solicitationWatchEnabled(): boolean {
  return readFlag('SOLICITATION_WATCH_ENABLED');
}
