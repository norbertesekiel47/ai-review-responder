/**
 * Dispatch orchestration (#899): the deep module behind the
 * `solicitation_send` topic. One job, one **Outreach row** — one dispatch
 * attempt for one **Ask**. Two doors:
 *
 *  - `applyDispatchGate` — PURE. The single owner of amendment B6's seven-item
 *    ORDER and of the withheld-reason mapping. It takes evidence and returns a
 *    verdict; how that evidence was gathered is not its business.
 *  - `dispatchOutreach` — the orchestrator the composition root calls.
 *
 * The **Dispatch gate** is per-CHILD and therefore per-CONTACT: an
 * account-level fact (subscription, daily cap, the **Send breaker**) is the
 * release poller's to decide (#900), never an item here. Two of the seven
 * items are gathered with NO lock held (lint, moderation — decision 3) and
 * five inside tx1 under the batch row lock, which is why the evidence arrives
 * as two records rather than one.
 *
 * TASK 1 SCOPE. This file today implements the tracer only: the ONE case where
 * nothing is sent. A job arrives, `SOLICITATION_SEND_ENABLED` is off, the
 * outbox attempt completes, the row stays `queued` and no message goes out.
 * Tasks 2–7 fill in the fast/slow evidence, the token mint, the provider call
 * and the terminal transaction; every path they own throws a marked TODO here.
 *
 * Outbox contract: a defer is a SUCCESS, never a stranded `dispatched` row —
 * `completeOutboxNoop` mirrors `ask-generation.ts`'s helper of the same name.
 * Leaving the attempt in flight would have the watchdog re-pend a row that was
 * correctly deferred, turning a quiet no-op into a retry storm.
 *
 * PII contract: this lane holds the rendered subject, the rendered body, the
 * recipient handle and (from Task 4) a raw unsubscribe token. NONE of them is
 * ever logged. `createWorkerLogger` passes object args through the analytics
 * blocked-key sanitizer but logs string args VERBATIM, so redaction is this
 * module's obligation, not the logger's.
 *
 * Domain module (invariant #15): takes `sql: Sql` explicitly and never imports
 * `@/lib/db/server`; every query is tenant-scoped by the payload's business_id
 * (the tenant proof — a bare row UUID proves nothing).
 */

import type { Sql } from 'postgres';
import { markOutboxCompletedIfOwned } from '@/lib/shared/outbox';
import { createWorkerLogger } from '@/lib/shared/logger';
import { SEND_ELIGIBLE_ATTESTATION_VERSIONS } from './attestation';
// Type-only, and deliberately not a third declaration of the same two fields:
// `ask-generation.ts` already owns `extractOutboxHandle`'s result shape for
// this folder. A domain module that spends its own outbox attempt needs the
// handle in its interface, and two lanes disagreeing about it is a bug nobody
// would see until a stale attempt stomped a newer one.
import type { OutboxHandle } from './ask-generation';
import { solicitationSendEnabled } from './flags';

// ── The Dispatch gate ────────────────────────────────────────────────────────

/** The seven items B6 leaves to the child, in B6's order. */
export type DispatchGateItem =
  | 'batch_open'          // 1. not halted, send window open
  | 'send_flag'           // 2. SOLICITATION_SEND_ENABLED
  | 'suppression'         // 4. Suppression ledger
  | 'consent'             // 5. consent row + SEND_ELIGIBLE_ATTESTATION_VERSIONS
  | 'postal_address'      // 6. exists and byte-matches the stored footer
  | 'lint'                // 8. re-lint at current ASK_LINT_VERSION
  | 'moderation';         // 9. clean provider verdict

/**
 * The SIX withheld reasons this gate can produce — deliberately not the whole
 * 091/110 vocabulary. `render_failed` and `unsubscribed` are written by other
 * lanes, and re-spelling them here would invite a gate arm that has no item.
 */
export type OutreachWithheldReason =
  | 'suppressed'
  | 'no_consent'
  | 'no_postal_address'
  | 'postal_address_mismatch'
  | 'lint_failed'
  | 'moderation_high';

/** Evidence gathered with NO lock held (decision 3). */
export interface SlowGateEvidence {
  lintPassed: boolean;
  /** false when OPENAI_MODERATION_ENABLED is off — this lane inverts the reply
   *  lane's fail-open: an unmoderated ask is not a send-eligible ask. */
  moderationClean: boolean;
}

/** Evidence gathered inside tx1 under the batch row lock. */
export interface FastGateEvidence {
  batchOpen: boolean;
  sendFlagOn: boolean;
  suppressed: boolean;
  consent: { rowId: string; basis: string; attestationVersion: string } | null;
  postalAddressMatches: boolean;
  postalAddressPresent: boolean;
}

export type DispatchGateVerdict =
  | { pass: true }
  | { pass: false; item: DispatchGateItem; outcome: 'withhold'; reason: OutreachWithheldReason }
  | { pass: false; item: DispatchGateItem; outcome: 'defer' };

const ELIGIBLE_ATTESTATION_VERSIONS: readonly string[] = SEND_ELIGIBLE_ATTESTATION_VERSIONS;

function withhold(
  item: DispatchGateItem,
  reason: OutreachWithheldReason,
): DispatchGateVerdict {
  return { pass: false, item, outcome: 'withhold', reason };
}

function defer(item: DispatchGateItem): DispatchGateVerdict {
  return { pass: false, item, outcome: 'defer' };
}

/**
 * PURE. Walks B6's seven items IN ORDER and returns the FIRST failure.
 *
 * The two DEFER items are the first two and are deferrals for different
 * reasons: `batch_open` because the **Halt latch** sweep already cancelled the
 * row, so this child has nothing left to decide; `send_flag` because 091/110
 * carry no `flag_off` withheld reason and inventing one would terminalize a
 * row the owner never withdrew (decision 5). Everything after them is terminal.
 *
 * `postal_address` is ONE item with TWO reasons — absent and
 * present-but-mismatched are different facts, and only the reason mapping
 * tells the owner which one to fix.
 */
export function applyDispatchGate(
  slow: SlowGateEvidence,
  fast: FastGateEvidence,
): DispatchGateVerdict {
  if (!fast.batchOpen) return defer('batch_open');
  if (!fast.sendFlagOn) return defer('send_flag');
  if (fast.suppressed) return withhold('suppression', 'suppressed');
  if (
    fast.consent === null
    || !ELIGIBLE_ATTESTATION_VERSIONS.includes(fast.consent.attestationVersion)
  ) {
    return withhold('consent', 'no_consent');
  }
  if (!fast.postalAddressPresent) return withhold('postal_address', 'no_postal_address');
  if (!fast.postalAddressMatches) {
    return withhold('postal_address', 'postal_address_mismatch');
  }
  if (!slow.lintPassed) return withhold('lint', 'lint_failed');
  if (!slow.moderationClean) return withhold('moderation', 'moderation_high');
  return { pass: true };
}

// ── dispatchOutreach ─────────────────────────────────────────────────────────

export interface DispatchOutreachInput {
  batchId: string;
  /** Tenant proof from the queue payload (invariant #8). */
  businessId: string;
  outreachId: string;
  outboxHandle: OutboxHandle;
  correlationId: string;
}

/** Only what the tracer reads. Tasks 2–6 widen this projection as their gates
 *  and their CAS need more; a column nobody reads is a column nobody maintains. */
interface OutreachDispatchRow {
  delivery_status: string;
}

function requireAttempt(handle: OutboxHandle, door: string): number {
  if (handle.attempt === undefined) {
    throw new Error(`${door} requires an exact outbox_attempt`);
  }
  return handle.attempt;
}

/**
 * A defer is a SUCCESS: complete the owned attempt in a minimal transaction so
 * the row can never strand in `dispatched`. A stale attempt no-ops inside the
 * CAS itself. Shape copied from `ask-generation.ts`'s `completeOutboxNoop`.
 */
async function completeOutboxNoop(
  sql: Sql,
  outboxId: string,
  attempt: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    await markOutboxCompletedIfOwned(tx, outboxId, attempt);
  });
}

async function loadOutreachRow(
  sql: Sql,
  input: DispatchOutreachInput,
): Promise<OutreachDispatchRow | undefined> {
  const [row] = await sql<OutreachDispatchRow[]>`
    SELECT delivery_status
    FROM solicitation_outreach
    WHERE id = ${input.outreachId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND batch_id = ${input.batchId}::uuid
  `;
  return row;
}

/**
 * The dispatch orchestrator. TASK 1 implements the flag-off arm only.
 *
 * The row read comes first so the deferral is logged against a real, in-scope
 * row rather than against a payload nobody has checked — and a payload naming
 * a row of another tenant resolves to nothing here, never to a send.
 */
export async function dispatchOutreach(
  sql: Sql,
  input: DispatchOutreachInput,
): Promise<void> {
  const logger = createWorkerLogger('solicitation-send', input.correlationId);
  const { outboxId } = input.outboxHandle;
  const attempt = requireAttempt(input.outboxHandle, 'solicitation_send');

  const row = await loadOutreachRow(sql, input);
  if (!row) {
    // No-op SUCCESS: an offboarding purge (or a payload for another tenant)
    // leaves nothing to dispatch, and a retry would find the same nothing.
    await completeOutboxNoop(sql, outboxId, attempt);
    logger.warn('solicitation send no-op: outreach row missing', {
      batch_id: input.batchId,
      outreach_id: input.outreachId,
    });
    return;
  }

  // Decision 5: the flag flipped between enqueue and run ⇒ DEFER. The row keeps
  // its current status — most often `queued` — and #900's producer re-drips it
  // once the lane is switched back on. Never a withhold: there is no `flag_off`
  // reason in 091/110 and terminalizing here would end an attempt the owner
  // still owns.
  if (!solicitationSendEnabled()) {
    await completeOutboxNoop(sql, outboxId, attempt);
    logger.log('solicitation send deferred: send flag disabled', {
      batch_id: input.batchId,
      outreach_id: input.outreachId,
      delivery_status: row.delivery_status,
    });
    return;
  }

  // TODO(Task 2/3): gather the fast evidence inside tx1 and the slow evidence
  // before it, then apply `applyDispatchGate`. TODO(Task 4): mint the
  // unsubscribe token. TODO(Task 6): the CAS, the provider call and the
  // terminal transaction. Unreachable today — the flag is unset in every
  // environment and #900's producer does not exist yet.
  throw new Error('TODO(Task 2): solicitation send dispatch is not implemented yet');
}
