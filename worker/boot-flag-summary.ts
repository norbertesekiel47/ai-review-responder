// worker/boot-flag-summary.ts
//
// The worker's boot feature-flag line (#1173). Reading Railway variables back
// is refused because the response carries plaintext secrets, so this log line
// is the only way to confirm a flag flip actually reached the process — and
// until now it named four flags and no autonomy flag, which is why a
// 2026-09-07 TRIAGE_ENABLED staging flip is recorded as "set but unproven".
//
// The list lives here, not in `worker/index.ts`: that boot file has no test
// seam (importing it boots Fastify), and invariant #12 says entry points
// orchestrate while modules own behavior.
//
// Every value comes from its feature's existing `flags.ts` accessor — never
// `process.env` and never a second `readFlag` call site. `ci:static-policy`
// bans inline `process.env.*_ENABLED` outside `src/lib/config/`, and invariant
// #13 keeps flags server-authoritative (no `NEXT_PUBLIC_*` companion). The
// accessors are not memoized, so this reflects the live environment on each
// call.
import { selfServeSignupEnabled } from '../src/lib/auth/flags';
import { autoApprovalRuntimeEnabled, governorEnabled } from '../src/lib/auto-approval/flags';
import { escalationEnabled } from '../src/lib/escalations/flags';
import { channelsTelegramEnabled, channelsWhatsappEnabled } from '../src/lib/notifications/channels/flags';
import { zernioPublishingEnabled } from '../src/lib/publishing/flags';
import { judgeEnabled } from '../src/lib/responses/judge-flags';
import { triageEnabled } from '../src/lib/reviews/flags';
import { solicitationAutoApprovalEnabled, solicitationSendEnabled } from '../src/lib/solicitation/flags';

/**
 * One boolean per flag, keyed by the ENV VAR NAME so an operator can grep the
 * boot log for the same string they set on Railway. Exactly eleven keys: the
 * four that shipped in the original prose line, then the five autonomy flags
 * that gate acting on a customer's behalf, then the two solicitation flags.
 *
 * `SOLICITATION_WATCH_ENABLED` is deliberately excluded — it gates the contacts
 * upload surface, not outbound contact to a person.
 */
export function buildBootFlagSummary(): Record<string, boolean> {
  return {
    CHANNELS_TELEGRAM_ENABLED: channelsTelegramEnabled(),
    CHANNELS_WHATSAPP_ENABLED: channelsWhatsappEnabled(),
    SELF_SERVE_SIGNUP_ENABLED: selfServeSignupEnabled(),
    ZERNIO_PUBLISHING_ENABLED: zernioPublishingEnabled(),
    TRIAGE_ENABLED: triageEnabled(),
    ESCALATION_ENABLED: escalationEnabled(),
    JUDGE_ENABLED: judgeEnabled(),
    GOVERNOR_ENABLED: governorEnabled(),
    AUTO_APPROVAL_ENABLED: autoApprovalRuntimeEnabled(),
    SOLICITATION_SEND_ENABLED: solicitationSendEnabled(),
    SOLICITATION_AUTO_APPROVAL_ENABLED: solicitationAutoApprovalEnabled(),
  };
}

/**
 * Emits the summary. Split from the builder so a test can prove the record
 * actually reaches the log — a correct builder nobody calls leaves #1173
 * unfixed. `createWorkerLogger` writes one JSON object per line and passes
 * object args through the analytics blocked-key sanitizer; these are booleans,
 * so nothing is redacted and no env var value other than its truthiness is
 * disclosed.
 */
export function logBootFlagSummary(logger: { log(message: string, data: unknown): void }): void {
  logger.log('Feature flags', { flags: buildBootFlagSummary() });
}
