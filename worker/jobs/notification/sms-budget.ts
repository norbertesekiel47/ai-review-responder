// worker/jobs/notification/sms-budget.ts
//
// SMS budget passthrough for the notification dispatch loop. Keeps the
// dispatcher's import surface scoped to ./notification/* — the actual
// pessimistic-reserve / refund logic lives in src/lib/costs/sms-tracker.
//
// The wrapping pattern (`try { reserveSmsCost } catch (DailySmsLimitExceededError)`)
// stays inline in the dispatcher because the catch branch needs to invoke
// loop-level `continue` and write a failed delivery row — it can't be
// hoisted into a callback without changing control flow.

export {
  reserveSmsCost,
  refundSmsCost,
  DailySmsLimitExceededError,
} from '../../../src/lib/costs/sms-tracker';
