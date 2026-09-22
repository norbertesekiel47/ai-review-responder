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
// the pin red. Rule 16's row is additionally pinned cell-for-cell, by string
// equality, against the typed `OFFBOARDING_ALERT_RULE_16` record below it in
// this file (#1414) — see that record's own header comment for why.
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

// ── Rule 16 as data, not prose to regex over (#1414) ───────────────────────
//
// Three red-team rounds on #1016 kept beating a pin built from `toContain` /
// `toMatch` over the runbook row: presence survives a `do **not**` prefix
// (RT16-11), `.find()` hides a contradicting duplicate row below the real one
// (RT16-13), and a position-scoped regex still cannot tell "the row says this"
// from "the row says the opposite of this" without re-deriving the whole
// sentence as a pattern. The fix is to stop matching prose at all: this record
// IS the row, typed, and `failure-alert.test.ts` asserts each of its four
// cell fields against the runbook's own parsed cells with `toBe` — plain
// string equality, not a search. A reworded sentence, a negated facet, or the
// two fingerprint spellings swapped in place all change the string and all
// turn the assertion red, the same way changing this record and forgetting
// the runbook (or the reverse) would.
//
// Scope: rule 16 only (#1414 suggested scope item 2). Rules 17 and 18 below
// it in the runbook stay on the older position-scoped substring pin — RT16-11
// is an accepted, open risk on those two rows until they get their own record
// (owner decision tracked in #1447).
export interface OffboardingAlertRuleRecord {
  /** The rule's number in `docs/runbooks/beta-launch-alerting.md`. */
  readonly rule: number;
  /** The Sentry `captureMessage` string this rule filters on. */
  readonly signal: string;
  /** Every filter facet Sentry evaluates, in the order the runbook states them — informational; the `filterCell` below is what the test checks. */
  readonly filterFacets: readonly string[];
  /** The event level the TERMINAL alert fires at (the retry twin is `warning`). */
  readonly level: 'error';
  /** How the runbook groups terminal vs. retry events into distinct issues — informational; the `groupingCell` below is what the test checks. */
  readonly grouping: string;
  /** When the rule evaluates ("Every event", never first-seen). */
  readonly trigger: string;
  /** The action throttle: window and scope. */
  readonly throttle: string;
  /** Where the alert is delivered. */
  readonly destination: string;
  /** The runbook row's "Rule name" cell, VERBATIM — equality-checked, not searched. */
  readonly ruleNameCell: string;
  /** The runbook row's "Emitted identity and filter" cell, VERBATIM. */
  readonly filterCell: string;
  /** The runbook row's "Level and grouping" cell, VERBATIM. */
  readonly groupingCell: string;
  /** The runbook row's "Trigger and destination" cell, VERBATIM. */
  readonly triggerCell: string;
}

export const OFFBOARDING_ALERT_RULE_16: OffboardingAlertRuleRecord = {
  rule: 16,
  signal: OFFBOARDING_FAILURE_ALERT_MESSAGE.purge,
  filterFacets: [
    'terminal equals true',
    'level equals error',
    'subsystem equals account_offboarding',
    'step equals purge',
    'scoped to the deployment environment',
  ],
  level: 'error',
  grouping:
    'one issue per terminally failed offboarding, keyed by the offboarding id; the retry arm shares one issue at warning and never groups with a terminal event',
  trigger: 'Every event',
  throttle: '60 minutes per issue',
  destination: 'Discord via integration 443670',
  ruleNameCell: "`account-offboarding-purge-terminal → discord`",
  filterCell:
    "Worker `captureMessage` with the constant message `account_offboarding_purge_failed`, emitted by `alertPurgeFailure` (`worker/jobs/account-offboarding/PurgeWorker.ts`); filter tag `terminal` equals `true` **AND** level equals `error`, together with `subsystem` equals `account_offboarding` and `step` equals `purge`; scope to the deployment environment. Do **not** filter on Sentry priority — CONFIG-1 established that a level alone does not reliably classify, and the retry twin of this signal is a `warning`",
  groupingCell:
    "`error`; custom fingerprint `[account_offboarding_purge_failed, terminal, <account_offboarding_id>]`, which is the whole grouping: **one issue per terminally failed offboarding** (the paragraph below owns why, and what it costs). The retry arm takes the shared `[account_offboarding_purge_failed, retry]` at `warning`, so a retry can never group with a terminal event. Default title (the message). The event carries `account_offboarding_id`, `account_id` and the scrubbed error only — never an owner name, email, address or review text",
  triggerCell:
    "Every event, action throttle 60 minutes per issue; the environment's existing Discord alerts channel via integration 443670",
};
