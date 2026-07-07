import { readFlag } from '@/lib/config/flags';

/** WS2 Guardian triage kill switch. Default off; staging first (spec §5). */
export function triageEnabled(): boolean {
  return readFlag('TRIAGE_ENABLED');
}
