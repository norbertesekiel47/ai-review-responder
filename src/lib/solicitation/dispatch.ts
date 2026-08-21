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
 * TASK 3 SCOPE. The whole seven-item gate is real now — the flag-off defer,
 * the two SLOW items gathered above tx1, tx1 in its precedent order, the five
 * FAST items, the consent snapshot, the **Lazy child** and the inline
 * `closeBatchIfSettled` join. What is still missing is the unsubscribe token
 * mint (Task 4) and everything downstream of a PASSING gate (Task 6), which
 * throws a marked TODO from inside tx1 so a path this file does not own yet
 * cannot commit a half-dispatched row.
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

import type { Sql, TransactionSql } from 'postgres';
import {
  lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned,
} from '@/lib/shared/outbox';
import { createWorkerLogger } from '@/lib/shared/logger';
import { moderateResponse } from '@/lib/moderation/moderate';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import {
  completeRun,
  findActiveSolicitationSendBatchRun,
  recordStep,
  startOrGetSolicitationAskRun,
} from '@/lib/agents/run-spine';
import { lintAsk, lintInputFromSnapshot } from './ask-compliance-lint';
import { SEND_ELIGIBLE_ATTESTATION_VERSIONS } from './attestation';
import { acquireSolicitationBatchLock } from './batch-builder';
import { normalizeEmail } from './handles';
import {
  BATCH_SEND_WINDOW_HOURS,
  closeBatchIfSettled,
  deriveBatchState,
  parseOutreachInterpolationInputs,
  type BatchLifecycleRow,
  type BatchState,
} from './outreach';
import { readPostalAddressState } from './postal-address';
import { suppressionMatchSql, type SuppressionChannel } from './suppression';
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

/**
 * The ids every query in this lane is scoped by.
 *
 * `accountId` is RESOLVED from the Outreach row rather than carried in the
 * queue payload: `solicitation_outreach_business_account_fk` binds
 * (business_id, account_id) to `businesses`, so the row's account cannot drift
 * from its location's, while a payload-supplied account id would be an
 * unverified claim from a producer this module does not own.
 */
interface DispatchScope {
  accountId: string;
  businessId: string;
  batchId: string;
  outreachId: string;
}

/**
 * What the pre-tx read resolves: the tenant anchor, the status the two cheap
 * short-circuits above tx1 need, and the three IMMUTABLE render columns the two
 * SLOW gate items are computed from.
 *
 * Reading the bytes here rather than under the lock is decision 3, and it is
 * safe for one reason only: stored bytes never change after approval. ADR 0020
 * (#860) struck per-ask regeneration after approval, so `regenerateAsk` refuses
 * in every state but `built` and no path replaces an approved render. That is
 * what makes an unlocked read of them equivalent to a locked one.
 *
 * `interpolation_inputs` is JSONB and arrives as an object OR as a string
 * depending on the PgBouncer path, so it is typed `unknown` and narrowed by
 * `parseOutreachInterpolationInputs` — that function is the sanctioned parse
 * site, and re-spelling its guard here is what the allowlist exists to prevent.
 */
interface OutreachDispatchRow {
  account_id: string;
  delivery_status: string;
  rendered_subject: string | null;
  rendered_body: string | null;
  interpolation_inputs: unknown;
}

/** What tx1 re-reads under `FOR UPDATE`. Tasks 4 and 6 widen it (the rendered
 *  subject, `attempt_no`); a column nobody reads is a column nobody maintains. */
interface LockedOutreachRow {
  ask_id: string;
  contact_id: string;
  delivery_status: string;
  rendered_body: string | null;
}

interface ContactHandleRow {
  email: string | null;
}

interface SuppressionMatchRow {
  scope: string;
  source: string;
}

interface ConsentRow {
  id: string;
  basis: string;
  attestation_version: string;
}

/**
 * The one channel this lane dispatches on, shared by the Suppression ledger
 * lookup and the Consent ledger lookup so the two dimensions cannot drift
 * apart — the exact argument `suppressionMatchSql` makes for taking `channel`
 * as a parameter. `solicitation_outreach.channel` carries the same CHECK.
 */
const DISPATCH_CHANNEL: SuppressionChannel = 'email';

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The two **Send batch parent** states under which a child dispatch may
 * proceed. `veto_window` is deliberately absent — releasing inside the owner's
 * veto window is what that window exists to prevent — and so are `halted`,
 * `closed`, `expired`, `built` and `pending`, which belong to the **Halt
 * latch**, the closure CAS and the approval lane respectively.
 */
const SEND_OPEN_BATCH_STATES: readonly BatchState[] = ['approved', 'sending'];

/**
 * Gate item 1, `batch_open`, from two domain owners and no hand-rolled clock
 * arithmetic of its own: `deriveBatchState` owns the halted/closed/veto
 * precedence, and `BATCH_SEND_WINDOW_HOURS` owns the send-window edge.
 *
 * The window is a separate question from the state on purpose.
 * `deriveBatchState` answers "what does the owner see", and a batch past its
 * send window still reads `sending` on their screen until a writer
 * terminalizes its rows — so a state check alone would let a stale drip send
 * on day four.
 */
function isBatchOpenForSend(row: BatchLifecycleRow, now: Date): boolean {
  if (!SEND_OPEN_BATCH_STATES.includes(deriveBatchState(row, now))) return false;
  // Both open states imply approval; this narrows the type rather than doubting
  // the invariant.
  if (row.approved_at === null) return false;
  return now.getTime() < row.approved_at.getTime() + BATCH_SEND_WINDOW_HOURS * MS_PER_HOUR;
}

/**
 * Gate item 6's byte-match — a containment test against the STORED bytes,
 * never a re-render.
 *
 * `assembleAskBody` bakes `footer.postalAddress` in VERBATIM as its own line
 * between the sender-identification line and the unsubscribe line, and refuses
 * to assemble at all without one. So the whole check is "does that line still
 * say what the column says", and re-running the assembler at dispatch would
 * replace the artifact the owner approved with a fresh derivation of it.
 *
 * The needle is `\n<address>\n` rather than a split-and-compare so a multi-line
 * address matches as the multi-line block it was baked in as. The address is
 * NOT trimmed for the comparison: `assembleAskBody` did not trim it either, and
 * trimming here would report a match for bytes that differ.
 */
function storedBodyCarriesPostalAddress(body: string | null, address: string): boolean {
  if (body === null) return false;
  return body.includes(`\n${address}\n`);
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
    SELECT account_id, delivery_status,
           rendered_subject, rendered_body, interpolation_inputs
    FROM solicitation_outreach
    WHERE id = ${input.outreachId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND batch_id = ${input.batchId}::uuid
  `;
  return row;
}

/**
 * The verdict for a row that cannot be evaluated at all — no stored artifact, or
 * no §5.3 snapshot to replay the lint's exemption corpus from.
 *
 * BOTH items report failure, and neither is a lie: an absent snapshot means a
 * never-assembled `render_failed` row or a redacted one, and in both cases there
 * are no bytes whose compliance anyone can still vouch for. Gate order then
 * turns this into `lint_failed`, which is the accurate reading — the re-lint is
 * precisely the check that could not be performed.
 */
const SLOW_GATE_UNEVALUABLE: SlowGateEvidence = {
  lintPassed: false,
  moderationClean: false,
};

/**
 * Gate items 8 and 9, gathered with NO LOCK HELD (decision 3).
 *
 * Two reasons this runs above tx1, and both bind:
 *
 *  - `moderateResponse` is a remote call with a ~10s timeout, and the repo rule
 *    is never to hold a Postgres lock across one. tx1 holds the batch lifecycle
 *    row `FOR UPDATE`, so ten seconds here is ten seconds a concurrent **Halt
 *    latch** cannot land.
 *  - It is safe because the inputs are immutable after approval (see
 *    `OutreachDispatchRow`), so a verdict computed before the lock cannot go
 *    stale inside it.
 *
 * B6's ORDER is untouched — only the gathering moved. The verdicts are applied
 * at slots 8 and 9 by `applyDispatchGate`, so a suppressed contact still reports
 * `suppressed` rather than `lint_failed`.
 *
 * FAIL-CLOSED, and deliberately the inverse of the reply lane. Spec §3.4:
 * "a clean provider moderation verdict is a DISPATCH precondition, not a
 * GENERATION precondition". So `moderationClean` requires the provider to have
 * actually returned a clean verdict — `OPENAI_MODERATION_ENABLED=false` and a
 * provider error are BOTH false, which is what keeps the flag a genuine send
 * precondition rather than a silent downgrade to local-regex-only. The
 * `!decision.flagged` conjunct mirrors the generation lane's own `'clean'`
 * mapping (`ask-generation.ts`), so the local filter keeps its veto too.
 *
 * Both items are gathered unconditionally: `SlowGateEvidence` is a record of
 * BOTH verdicts, and skipping the second because the first already failed would
 * make that record lie about a check nobody ran. The moderation endpoint is free
 * (#623 §3.4), so there is no cost argument for the generation lane's
 * short-circuit here.
 */
async function gatherSlowGateEvidence(
  row: OutreachDispatchRow,
  outreachId: string,
): Promise<SlowGateEvidence> {
  const snapshot = parseOutreachInterpolationInputs(row.interpolation_inputs, outreachId);
  const subject = row.rendered_subject;
  const body = row.rendered_body;
  if (snapshot === null || subject === null || body === null) {
    return SLOW_GATE_UNEVALUABLE;
  }

  // The stored bytes, replayed against the stored snapshot — never a re-render
  // and never the live ask row, either of which would re-derive the artifact the
  // owner approved instead of checking it.
  const lintPassed = lintAsk(lintInputFromSnapshot(snapshot, subject, body)).blockedReason === null;

  // ONE call over subject + body, the same shape generation moderates, so a
  // subject-only violation cannot slip past.
  const decision = await moderateResponse(`${subject}\n${body}`);

  return {
    lintPassed,
    moderationClean: decision.providerStatus === 'clean' && !decision.flagged,
  };
}

/**
 * The recipient's **Normalized handle**, or null when there is none to look up.
 *
 * `solicitation_contacts.email` already stores `normalizeEmail`'s output (#535
 * §1.1) — the batch builder's plain-equality consent join is the standing proof
 * — so re-running it is idempotent, and it closes the one case a stored value
 * cannot: a row written before the normalizer covered it.
 *
 * A null handle makes BOTH ledger lookups return nothing. That reads as
 * suppression failing open, and it is not: with no handle there is also no
 * consent row, and `consent` is a terminal gate item, so the attempt is
 * withheld `no_consent` — the accurate reason, since a handle that does not
 * exist cannot have opted out.
 */
async function readContactHandle(
  tx: TransactionSql,
  scope: DispatchScope,
  contactId: string,
): Promise<string | null> {
  const [row] = await tx<ContactHandleRow[]>`
    SELECT email
    FROM solicitation_contacts
    WHERE id = ${contactId}::uuid
      AND business_id = ${scope.businessId}::uuid
  `;
  if (!row || row.email === null) return null;
  return normalizeEmail(row.email);
}

/**
 * Gate item 4. The §1.2 predicate has ONE owner (`suppressionMatchSql`) and
 * this is not it — the fragment is composed, never re-spelled.
 *
 * The fragment's `handleColumn` parameter names a column in an OUTER query at
 * its other call site (the batch builder's LATERAL over `c.email`). Here there
 * is no outer row to name, so it receives a value fragment and the whole
 * lookup is wrapped as a subquery: that keeps the result set TYPED at this
 * seam instead of arriving as the library's open `Row` shape.
 *
 * `scope` is selected but never surfaced — it is read so the shape matches the
 * fragment's contract; §7.4 forbids exposing which scope matched to an owner.
 */
async function readSuppressionMatch(
  tx: TransactionSql,
  accountId: string,
  handle: string,
): Promise<SuppressionMatchRow | null> {
  const [match] = await tx<SuppressionMatchRow[]>`
    SELECT suppression.scope, suppression.source
    FROM (
      ${suppressionMatchSql(tx, tx`${handle}`, accountId, DISPATCH_CHANNEL)}
    ) AS suppression
  `;
  return match ?? null;
}

/**
 * Gate item 5's evidence — the ledger ROW, not a verdict. Whether its
 * attestation version authorizes a send is `applyDispatchGate`'s membership
 * test against `SEND_ELIGIBLE_ATTESTATION_VERSIONS`, never a "not v1" test
 * here.
 *
 * `solicitation_consent` is keyed (channel, normalized_handle, business_id) and
 * carries no account column: the location is the tenant scope (invariant #8),
 * and it sits inside `scope.accountId` by the same composite FK that resolves
 * it.
 */
async function readConsentRow(
  tx: TransactionSql,
  scope: DispatchScope,
  handle: string,
): Promise<FastGateEvidence['consent']> {
  const [row] = await tx<ConsentRow[]>`
    SELECT id, basis, attestation_version
    FROM solicitation_consent
    WHERE channel = ${DISPATCH_CHANNEL}
      AND normalized_handle = ${handle}
      AND business_id = ${scope.businessId}::uuid
  `;
  if (!row) return null;
  return {
    rowId: row.id,
    basis: row.basis,
    attestationVersion: row.attestation_version,
  };
}

/**
 * The five FAST items, gathered inside tx1 under the batch row lock.
 *
 * Returns the matched suppression row alongside the evidence because the
 * analytics event the withhold path owes carries its `source`, and re-reading
 * the ledger after the verdict would be a second, racier answer to a question
 * already asked under the lock.
 */
async function gatherFastGateEvidence(
  tx: TransactionSql,
  scope: DispatchScope,
  batch: BatchLifecycleRow,
  outreach: LockedOutreachRow,
  now: Date,
): Promise<{ evidence: FastGateEvidence; suppression: SuppressionMatchRow | null }> {
  const handle = await readContactHandle(tx, scope, outreach.contact_id);
  const suppression = handle === null
    ? null
    : await readSuppressionMatch(tx, scope.accountId, handle);
  const consent = handle === null ? null : await readConsentRow(tx, scope, handle);

  // Account-scoped: a business outside this account returns null, never a row.
  // Migration 099's all-or-nothing CHECK is why nothing branches on "is this
  // attested" — a stored address always carries its complete attestation.
  const postal = await readPostalAddressState(tx, {
    accountId: scope.accountId,
    businessId: scope.businessId,
  });
  const stored = postal?.address ?? null;
  const attestedAddress = stored !== null && stored.trim().length > 0 ? stored : null;

  return {
    suppression,
    evidence: {
      batchOpen: isBatchOpenForSend(batch, now),
      sendFlagOn: solicitationSendEnabled(),
      suppressed: suppression !== null,
      consent,
      postalAddressPresent: attestedAddress !== null,
      postalAddressMatches: attestedAddress !== null
        && storedBodyCarriesPostalAddress(outreach.rendered_body, attestedAddress),
    },
  };
}

/**
 * Migration 091 comments `consent_basis` / `consent_attestation_version` /
 * `consent_row_id` as "consent snapshot, stamped at dispatch by #630 (nullable
 * until then)". THIS is that writer.
 *
 * Written for every attempt that reaches tx1, including one the gate then
 * withholds: the snapshot answers "what did the Consent ledger say when this
 * attempt was evaluated", and a withheld attempt is an evaluation. Writing the
 * NULL triple when there is no consent row records the same fact.
 */
async function stampConsentSnapshot(
  tx: TransactionSql,
  scope: DispatchScope,
  consent: FastGateEvidence['consent'],
): Promise<void> {
  await tx`
    UPDATE solicitation_outreach
    SET consent_basis = ${consent?.basis ?? null},
        consent_attestation_version = ${consent?.attestationVersion ?? null},
        consent_row_id = ${consent?.rowId ?? null}::uuid,
        updated_at = NOW()
    WHERE id = ${scope.outreachId}::uuid
      AND account_id = ${scope.accountId}::uuid
      AND business_id = ${scope.businessId}::uuid
  `;
}

interface WithholdCommitInput {
  askId: string;
  item: DispatchGateItem;
  reason: OutreachWithheldReason;
  suppression: SuppressionMatchRow | null;
  outboxId: string;
  attempt: number;
}

/**
 * The whole withhold, in the caller's tx1: terminal row, **Lazy child**,
 * receipt step, the suppression signal, the child's terminal, the outbox
 * completion and the inline `closeBatchIfSettled` join.
 *
 * The child is created HERE (locked decision 7) — the spine records work
 * performed, never work planned — and terminalizes `completed` (decision 8): a
 * correct refusal is completed work, not a failure. `moderation_status` and
 * `moderation_detail` are NOT touched; they are render provenance (decision 6).
 *
 * The parent is looked up, never minted: a missing **Send batch parent** means
 * generation never ran, and asserting that impossible state beats inventing a
 * parent the generation lane owns.
 */
async function commitWithhold(
  tx: TransactionSql,
  scope: DispatchScope,
  input: WithholdCommitInput,
): Promise<void> {
  const parent = await findActiveSolicitationSendBatchRun(tx, {
    batchId: scope.batchId,
    accountId: scope.accountId,
    businessId: scope.businessId,
  });
  if (!parent) {
    throw new Error(
      `solicitation send: no active send batch parent run for batch ${scope.batchId}`,
    );
  }

  const child = await startOrGetSolicitationAskRun(tx, {
    askId: input.askId,
    accountId: scope.accountId,
    businessId: scope.businessId,
    parentRunId: parent.runId,
  });

  await tx`
    UPDATE solicitation_outreach
    SET delivery_status = 'withheld',
        disposition_reason = ${input.reason},
        agent_run_id = ${child.runId}::uuid,
        updated_at = NOW()
    WHERE id = ${scope.outreachId}::uuid
      AND account_id = ${scope.accountId}::uuid
      AND business_id = ${scope.businessId}::uuid
  `;

  // ids and closed enum values only — never the handle, the subject or the body.
  await recordStep(tx, {
    runId: child.runId,
    stepKey: 'dispatch_gate_evaluated',
    detail: {
      outreach_id: scope.outreachId,
      ask_id: input.askId,
      gate_item: input.item,
      outcome: 'withhold',
      disposition_reason: input.reason,
    },
  });

  if (input.item === 'suppression' && input.suppression !== null) {
    // §9.4's signal: an opt-out that landed AFTER owner approval is the
    // earliest evidence the copy or the cadence is wrong. `scope` is
    // deliberately not a property — it would surface the `account_id`
    // provenance §7.4 forbids.
    //
    // Key, distinct id and the two properties are the REGISTERED contract at
    // docs/analytics/events.md:266-275 — that doc is the owner, not this call
    // site. It keys on the ASK, not the Outreach row: "one refusal per Ask",
    // so neither a BullMQ retry nor a regenerate re-dispatch inflates the
    // count. It also lists no optional properties, which is why outreach_id is
    // absent despite being useful for debugging.
    await enqueueAnalyticsEvent(tx, {
      eventName: 'solicitation_suppressed_at_dispatch',
      eventKey: `solicitation_suppressed_at_dispatch_${input.askId}`,
      distinctId: scope.accountId,
      accountId: scope.accountId,
      businessId: scope.businessId,
      properties: {
        source: input.suppression.source,
        ask_id: input.askId,
      },
    });
  }

  await completeRun(tx, child.runId, 'completed');
  await markOutboxCompletedIfOwned(tx, input.outboxId, input.attempt);
  await closeBatchIfSettled(tx, {
    batchId: scope.batchId,
    accountId: scope.accountId,
    businessId: scope.businessId,
  });
}

/** What tx1 decided, for the caller to log. A PASSING gate is not a member:
 *  Task 6 owns that path and it throws from inside the transaction. */
type DispatchTxOutcome =
  | { kind: 'stale' }
  | { kind: 'vanished' }
  | { kind: 'cancelled' }
  | { kind: 'deferred'; item: DispatchGateItem; batchState: BatchState }
  | { kind: 'withheld'; item: DispatchGateItem; reason: OutreachWithheldReason };

/**
 * tx1: the whole of the **Dispatch gate**'s FAST evidence, and every write a
 * non-sending verdict owes, under one transaction.
 *
 * `SELECT … FOR UPDATE` is a NO-OP outside `sql.begin()` under PgBouncer's
 * transaction pooling — the row lock is dropped the instant the SELECT returns
 * — which is why all four opening statements and every write below share one
 * transaction rather than being sequenced by the caller.
 *
 * The opening order is `ask-generation.ts`'s, copied deliberately:
 *
 *  1. the stale-attempt guard FIRST. Without it, attempt N-1's job can arrive
 *     after attempt N was dispatched and both reach the provider.
 *  2. the per-business advisory lock, which by the GLOBAL LOCK ORDER on
 *     `acquireSolicitationBatchLock` precedes every row lock in this lane.
 *  3. the batch lifecycle row, locked.
 *  4. the Outreach row, locked — the **Halt latch** sweep cancels `rendered`
 *     and `queued` rows and never `sending`, so a job that arrives after it
 *     finds `cancelled` and must do nothing at all.
 */
async function runDispatchTx(
  tx: TransactionSql,
  scope: DispatchScope,
  handle: { outboxId: string; attempt: number },
  slow: SlowGateEvidence,
): Promise<DispatchTxOutcome> {
  const owns = await lockDispatchedOutboxAttemptIfOwned(tx, handle.outboxId, handle.attempt);
  if (!owns) return { kind: 'stale' };

  await acquireSolicitationBatchLock(tx, scope.businessId);

  const [batchRow] = await tx<BatchLifecycleRow[]>`
    SELECT built_at, approved_at, veto_deadline_at,
           sending_started_at, send_closed_at, halted_at
    FROM solicitation_batches
    WHERE id = ${scope.batchId}::uuid
      AND account_id = ${scope.accountId}::uuid
      AND business_id = ${scope.businessId}::uuid
    FOR UPDATE
  `;
  if (!batchRow) {
    throw new Error(`solicitation send: batch ${scope.batchId} vanished before dispatch`);
  }

  const [outreach] = await tx<LockedOutreachRow[]>`
    SELECT ask_id, contact_id, delivery_status, rendered_body
    FROM solicitation_outreach
    WHERE id = ${scope.outreachId}::uuid
      AND account_id = ${scope.accountId}::uuid
      AND business_id = ${scope.businessId}::uuid
      AND batch_id = ${scope.batchId}::uuid
    FOR UPDATE
  `;
  if (!outreach) {
    // There for the unlocked read, gone under the lock — an offboarding purge
    // landing mid-flight. A retry would find the same nothing.
    await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    return { kind: 'vanished' };
  }

  if (outreach.delivery_status === 'cancelled') {
    // Nothing to re-gate and nothing to re-terminalize — the sweep that
    // cancelled it already wrote every terminal fact and already joined the
    // batch. Completing the attempt is the only thing left owed.
    await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    return { kind: 'cancelled' };
  }

  const now = new Date();
  const { evidence, suppression } = await gatherFastGateEvidence(
    tx,
    scope,
    batchRow,
    outreach,
    now,
  );

  // The two SLOW items arrive already decided, from above tx1 (decision 3).
  // `applyDispatchGate` is the only place the two records meet, so the gate's
  // B6 order survives the split gathering.
  const verdict = applyDispatchGate(slow, evidence);

  if (!verdict.pass && verdict.outcome === 'defer') {
    // No DOMAIN state is written, not even the consent snapshot: a defer is a
    // no-decision and the row is one #900's producer re-drips. The attempt is
    // still completed — the watchdog reclaims every in-flight status, so a
    // defer left `dispatched` is re-dispatched every stale window forever.
    await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    return {
      kind: 'deferred',
      item: verdict.item,
      batchState: deriveBatchState(batchRow, now),
    };
  }

  await stampConsentSnapshot(tx, scope, evidence.consent);

  if (!verdict.pass) {
    await commitWithhold(tx, scope, {
      askId: outreach.ask_id,
      item: verdict.item,
      reason: verdict.reason,
      suppression,
      outboxId: handle.outboxId,
      attempt: handle.attempt,
    });
    return { kind: 'withheld', item: verdict.item, reason: verdict.reason };
  }

  // TODO(Task 4): mint the unsubscribe token and substitute both placeholders
  // in memory. TODO(Task 6): the `queued → sending` CAS, the provider call and
  // the tx2 terminal transaction. Thrown from INSIDE tx1 on purpose — rolling
  // this transaction back is what keeps a task that does not own the sending
  // path from committing a half-dispatched row. Unreachable in every
  // environment today: the flag is unset and #900's producer does not exist.
  throw new Error('TODO(Task 4/6): solicitation send dispatch is not implemented yet');
}

/**
 * The dispatch orchestrator.
 *
 * The unlocked row read comes first so the two cheapest refusals — a row that
 * is not there and a lane that is switched off — never open a transaction, and
 * so the deferral is logged against a real, in-scope row rather than against a
 * payload nobody has checked. A payload naming a row of another tenant
 * resolves to nothing here, never to a send.
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

  const scope: DispatchScope = {
    accountId: row.account_id,
    businessId: input.businessId,
    batchId: input.batchId,
    outreachId: input.outreachId,
  };
  const context = { batch_id: scope.batchId, outreach_id: scope.outreachId };

  // Decision 3: gate items 8 and 9 are decided HERE, above the transaction, so
  // no lock is held across the moderation provider's round trip.
  const slow = await gatherSlowGateEvidence(row, scope.outreachId);

  const outcome = await sql.begin(
    async (tx): Promise<DispatchTxOutcome> =>
      runDispatchTx(tx, scope, { outboxId, attempt }, slow),
  );

  if (outcome.kind === 'stale') {
    // Nothing done, and deliberately nothing completed either: a newer attempt
    // owns this outbox row and completing it here would strand that attempt.
    logger.warn('solicitation send: stale outbox attempt — nothing done', {
      ...context,
      outbox_id: outboxId,
      outbox_attempt: attempt,
    });
    return;
  }
  if (outcome.kind === 'vanished') {
    logger.warn('solicitation send no-op: outreach row vanished under lock', context);
    return;
  }
  if (outcome.kind === 'cancelled') {
    logger.log('solicitation send no-op: outreach row already cancelled', context);
    return;
  }
  if (outcome.kind === 'deferred') {
    logger.log('solicitation send deferred by the dispatch gate', {
      ...context,
      gate_item: outcome.item,
      batch_state: outcome.batchState,
    });
    return;
  }
  logger.log('solicitation send withheld by the dispatch gate', {
    ...context,
    gate_item: outcome.item,
    disposition_reason: outcome.reason,
  });
}
