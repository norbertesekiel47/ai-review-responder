import { readFlag } from '@/lib/config/flags';

/** WS3 Guardian escalation kill switch. Default off; staging first (spec §2.9).
 *  Checked at RAISE time (persistTriage) and again at SEND time
 *  (EscalationNoticeWorker) — flipping off stops outbound notices without
 *  hiding already-raised escalations. */
export function escalationEnabled(): boolean {
  return readFlag('ESCALATION_ENABLED');
}
