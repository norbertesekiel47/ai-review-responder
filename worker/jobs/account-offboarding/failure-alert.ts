// The one Sentry emitter for an account-offboarding worker failure (#1412).
//
// Three workers (billing schedule, teardown, purge) used to carry a private
// copy of this `captureMessage` call, and two of the three copies kept the
// shape #1016 removed from the purge worker: one constant message with no
// fingerprint, so a retry `warning` and the terminal `error` landed in ONE
// Sentry issue and a first-seen rule fired on an early retry, then stayed
// silent for the terminal event (red-team RT-08). Every terminal branch in
// these workers RETURNS after marking instead of throwing, so BullMQ emits no
// `failed` event and `attachJobFailureSink` never covers them either — this
// call is the whole page.
//
// Grouping, per step:
//   terminal → [<message>, 'terminal', <account_offboarding_id>]  at `error`
//   retry    → [<message>, 'retry']                                at `warning`
// The terminal arm carries the offboarding id because Sentry's action throttle
// is PER ISSUE: one shared terminal issue would swallow a second account's
// page inside the rule's 60-minute window (review finding Codex A1). The retry
// arm stays shared — a retry is noise until it terminalizes.
//
// `docs/runbooks/beta-launch-alerting.md` rules 16, 17 and 18 name these exact
// messages and fingerprint members, and `failure-alert.test.ts` reads each
// rule's own table row back against the exports below, so a rename here turns
// the pin red.
//
// Best-effort by construction: a Sentry throw is logged and swallowed, so an
// alert can never strand the durable marks that precede it
// (`.claude/rules/worker-layout.md`, "best-effort work after a side effect").
import * as Sentry from '@sentry/node';
import { createWorkerLogger, toError } from '../../../src/lib/shared/logger';

export const OFFBOARDING_FAILURE_ALERT_MESSAGE = {
  billing: 'account_offboarding_billing_schedule_failed',
  teardown: 'account_offboarding_teardown_failed',
  purge: 'account_offboarding_purge_failed',
} as const;

export type OffboardingFailureStep = keyof typeof OFFBOARDING_FAILURE_ALERT_MESSAGE;

/**
 * The outbox `last_error` and alert text for a dispatch whose (offboarding id,
 * account id) pair matches no row. Every handler loads on BOTH ids, so a valid
 * offboarding id with the wrong account id lands here too: absence does not
 * prove there is no obligation, and the branch returns after marking, so it
 * is terminal by construction and alerts as terminal (#1413).
 */
export const OFFBOARDING_NOT_FOUND = 'account_offboarding_not_found';

export const OFFBOARDING_FAILURE_STEPS = Object.keys(
  OFFBOARDING_FAILURE_ALERT_MESSAGE,
) as readonly OffboardingFailureStep[];

/** The terminal fingerprint WITHOUT its third member, the offboarding id. */
export function offboardingTerminalFingerprintPrefix(
  step: OffboardingFailureStep,
): readonly [string, 'terminal'] {
  return [OFFBOARDING_FAILURE_ALERT_MESSAGE[step], 'terminal'];
}

export function offboardingRetryFingerprint(
  step: OffboardingFailureStep,
): readonly [string, 'retry'] {
  return [OFFBOARDING_FAILURE_ALERT_MESSAGE[step], 'retry'];
}

export interface OffboardingFailureAlert {
  step: OffboardingFailureStep;
  accountOffboardingId: string;
  accountId: string;
  /** Already passed through `scrubOffboardingErrorForStorage`. */
  safeMessage: string;
  terminal: boolean;
}

const logger = createWorkerLogger('[AccountOffboardingFailureAlert]');

export function alertOffboardingFailure(alert: OffboardingFailureAlert): void {
  const { step, accountOffboardingId, accountId, safeMessage, terminal } = alert;
  try {
    Sentry.captureMessage(OFFBOARDING_FAILURE_ALERT_MESSAGE[step], {
      level: terminal ? 'error' : 'warning',
      fingerprint: terminal
        ? [...offboardingTerminalFingerprintPrefix(step), accountOffboardingId]
        : [...offboardingRetryFingerprint(step)],
      tags: {
        subsystem: 'account_offboarding',
        step,
        terminal: String(terminal),
      },
      extra: {
        account_offboarding_id: accountOffboardingId,
        account_id: accountId,
        error: safeMessage,
      },
    });
  } catch (sinkError) {
    // A failure to REPORT a failure must never reach the handler: the durable
    // marks have already landed and a throw here would flip the job to failed.
    logger.error('account-offboarding failure alert failed', toError(sinkError), {
      step,
      account_offboarding_id: accountOffboardingId,
      terminal,
    });
  }
}
