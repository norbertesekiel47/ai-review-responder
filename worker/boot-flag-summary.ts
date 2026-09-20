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
// Every value comes from its feature's existing `flags.ts` accessor, with ONE
// documented exception below (`AUTOPILOT_PURCHASABLE`, whose accessor is a
// composite). Never `process.env` directly: `ci:static-policy` bans inline
// `process.env.*_ENABLED` outside `src/lib/config/`, and invariant #13 keeps
// flags server-authoritative (no `NEXT_PUBLIC_*` companion). Neither `readFlag`
// nor the accessors are memoized, so this reflects the live environment on
// each call.
import { selfServeSignupEnabled } from '../src/lib/auth/flags';
import { readFlag } from '../src/lib/config/flags';
import {
  autoApprovalRuntimeEnabled,
  governorEnabled,
  providerModerationEnabled,
} from '../src/lib/auto-approval/flags';
import { escalationEnabled } from '../src/lib/escalations/flags';
import { channelsTelegramEnabled, channelsWhatsappEnabled } from '../src/lib/notifications/channels/flags';
import { zernioPublishingEnabled } from '../src/lib/publishing/flags';
import { judgeEnabled } from '../src/lib/responses/judge-flags';
import { triageEnabled } from '../src/lib/reviews/flags';
import { solicitationAutoApprovalEnabled, solicitationSendEnabled } from '../src/lib/solicitation/flags';

/**
 * One boolean per flag, keyed by the ENV VAR NAME so an operator can grep the
 * boot log for the same string they set on Railway. Exactly thirteen keys: the
 * four that shipped in the original prose line, then **all six autonomy flags**,
 * then the provider-moderation safety prerequisite, then the two solicitation
 * flags.
 *
 * The audited set is "flags that gate an autonomous external action, plus the
 * safety prerequisites of those actions" — not a historical grouping.
 * `OPENAI_MODERATION_ENABLED` is here on that rule even though no doc calls it
 * an autonomy flag: `buildAutoApprovalPostingStatus` treats it as an
 * account-wide veto on auto-posting, so a boot record showing all six autonomy
 * flags on while moderation is off would show a lane that looks live and is
 * not.
 *
 * SIX, not five. `.claude/rules/agentic-platform.md` and
 * `.claude/skills/flag-flip/SKILL.md` both own that term and both include
 * `AUTOPILOT_PURCHASABLE`, which is the LAST step of the fixed go-live order
 * (`SKILL.md`: triage → escalation → judge+governor → auto-approval →
 * purchasable). Issue #1173's sketch listed five and this module first shipped
 * five, which left the flip most in need of an audit trail unlogged. Do not
 * re-derive this list from the issue; derive it from the rule that owns the
 * term.
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
    // The RAW env var, deliberately NOT `autopilotPurchasable()`. That accessor
    // is a COMPOSITE — `AUTOPILOT_PURCHASABLE === 'true' && autoApprovalRuntimeEnabled()`
    // (`tier-purchasability.ts:8`) — and it reads through `getServerConfig()`,
    // the Next-server path that `readFlag` exists to avoid on the worker. Under
    // the composite this key would read `false` for an operator who had just
    // correctly set it, whenever the earlier go-live step is still off. Every
    // other key here answers "did the value I set on Railway land in this
    // process", and this one must answer the same question.
    AUTOPILOT_PURCHASABLE: readFlag('AUTOPILOT_PURCHASABLE'),
    OPENAI_MODERATION_ENABLED: providerModerationEnabled(),
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
