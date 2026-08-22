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
 * TWO TRANSACTIONS AND ONE PROVIDER CALL BETWEEN THEM. tx1 evaluates the gate,
 * mints the token, creates the **Lazy child** and CASes `queued → sending`;
 * `getMessagingAdapter().send` then runs with NO lock held; tx2 commits the
 * five terminal facts at once — the `sending → sent | failed` CAS, the child's
 * terminal, the `solicitation_sent` outcome, the outbox completion and the
 * `closeBatchIfSettled` join. D12a: if tx2 does not commit, the outbox row is
 * not completed either, so the watchdog still owns the work and there is no
 * orphan class for a sweeper to own.
 *
 * THE CAS IS IN tx1 WITH THE MINT, and that pairing is load-bearing rather than
 * stylistic. After tx1 commits, a token row ALWAYS implies a `sending` row —
 * which is exactly what the resume path below assumes. Splitting them would
 * leave a window where a committed token coexists with a still-`queued` row,
 * and a fresh process arriving in that window would re-gate and re-send.
 *
 * INVARIANT #5 IS THE POINT OF THE MINT. Only the SHA-256 hash reaches
 * Postgres; the raw token lives in this module's memory and in the recipient's
 * link. It is therefore NOT recoverable from the row, which is what makes
 * locked decision 9 structural rather than a rule to remember:
 *
 *  - RETRYABLE provider failures are retried IN PROCESS, under bounded jittered
 *    backoff, while the raw token is still in scope (`sendWithBoundedRetry`).
 *    That is the only retry this lane performs, and CLAUDE.md's standing rule
 *    for every outbound provider call.
 *  - A FRESH PROCESS that finds the row already `sending` — or, defensively,
 *    finds the token row already minted — cannot rebuild the same body and MUST
 *    NOT send. It completes the outbox attempt, leaves the Outreach row exactly
 *    as it found it, and returns; #900's D12d sweep terminalizes a `sending` row
 *    `unknown` / `send_indeterminate` after `UNKNOWN_GRACE_MINUTES`.
 *
 * Re-issuing to the provider and hoping the idempotency key saves us is the
 * WRONG answer: if the first request never reached Resend, the RETRY's body is
 * what gets delivered, carrying an unsubscribe URL that resolves to nothing — a
 * CAN-SPAM defect, not a degraded send. B4's "idempotent on `outreach_id`"
 * guarantees the token ROW is never duplicated; it guarantees nothing about a
 * recoverable BODY. Re-GATING is forbidden on that path for the mirror-image
 * reason: recording `withheld` for a message that may already have reached a
 * real person is the lie-with-teeth D12d created `unknown` to avoid.
 *
 * Outbox contract: a defer is a SUCCESS, never a stranded `dispatched` row —
 * `completeOutboxNoop` mirrors `ask-generation.ts`'s helper of the same name.
 * Leaving the attempt in flight would have the watchdog re-pend a row that was
 * correctly deferred, turning a quiet no-op into a retry storm. A defer also
 * owes a `dispatch_gate_evaluated` step on the **Send batch parent**
 * (`recordDeferStepOnParent`) — without it a deferred contact leaves no trace
 * on the spine at all, and both defer paths write the same step for the same
 * reason.
 *
 * PII contract: this lane holds the rendered subject, the rendered body, the
 * recipient handle and a raw unsubscribe token. NONE of them is ever logged —
 * the token only ever through `unsubscribeTokenLogPrefix`'s digest prefix.
 * `createWorkerLogger` passes object args through the analytics blocked-key
 * sanitizer but logs string args VERBATIM, so redaction is this module's
 * obligation, not the logger's.
 *
 * Domain module (invariant #15): takes `sql: Sql` explicitly and never imports
 * `@/lib/db/server`; every query is tenant-scoped by the payload's business_id
 * (the tenant proof — a bare row UUID proves nothing).
 */

import { createHash, randomInt } from 'node:crypto'; // invariant #10: node's own crypto
import type { PendingQuery, Row, Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid'; // invariant #10 posture: uuid lib is the repo-standard UUIDv7 source
import {
  lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned,
} from '@/lib/shared/outbox';
import { createWorkerLogger } from '@/lib/shared/logger';
import { escapeHtml } from '@/lib/shared/html';
import { moderateResponse } from '@/lib/moderation/moderate';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { getWorkerConfig } from '@/lib/config/worker';
import { isPlaceId } from '@/lib/reviews/url-parser';
// The seam, never `EmailAdapter` and never a Resend client: the adapter is
// SELECTED in `getMessagingAdapter`, so this call site names no channel and a
// WhatsApp adapter is a second adapter there rather than a branch here. The
// envelope's shape has ONE owner (#657's seam) and it is not this file.
import { getMessagingAdapter, type OutboundMessage } from '@/lib/messaging/messaging-adapter';
import {
  completeRun,
  findActiveSolicitationSendBatchRun,
  recordOutcome,
  recordStep,
  startOrGetSolicitationAskRun,
} from '@/lib/agents/run-spine';
import { lintAsk, lintInputFromSnapshot } from './ask-compliance-lint';
import { REVIEW_LINK_PLACEHOLDER, UNSUBSCRIBE_URL_PLACEHOLDER } from './ask-render';
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
import { classifySendFailure, type SendFailureClass } from './send-retry';
import { suppressionMatchSql, type SuppressionChannel } from './suppression';
import {
  hashUnsubscribeToken,
  mintUnsubscribeRawToken,
  unsubscribeTokenLogPrefix,
} from './unsubscribe';
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

/**
 * What the unlocked gather produces: the two verdicts, plus proof of WHICH bytes
 * they were computed over.
 *
 * The digest is deliberately NOT a member of `SlowGateEvidence`. That type is
 * the pure gate's input, and the gate decides on verdicts alone — handing it a
 * digest it never reads would widen a pure interface for a caller's benefit.
 * tx1 is the only consumer.
 */
export interface SlowGateResult {
  evidence: SlowGateEvidence;
  /**
   * SHA-256 of the exact `rendered_subject` + `rendered_body` the verdicts were
   * computed over, so tx1 can PROVE it is sending the bytes that were linted and
   * moderated rather than assuming it.
   *
   * Decision 3 gathers the slow items from an UNLOCKED read, which is safe only
   * because stored bytes are immutable after approval. But that immutability is
   * enforced by a domain module (ADR 0020's refusal in `regenerateAsk`), NOT by
   * the schema — nothing in Postgres stops a repair script, a new lane or a
   * future writer from editing `rendered_body` between the gather and tx1.
   * Without this digest the worker would moderate old bytes and send new ones,
   * silently, and the **Owner approval** byte-for-byte contract would be a
   * convention rather than a check. Round-1 adversarial review, finding A4.
   *
   * `null` only when there were no bytes to hash — a `render_failed` or redacted
   * row, which `lintPassed: false` already withholds.
   */
  evaluatedBytesDigest: string | null;
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

/** What tx1 re-reads under `FOR UPDATE`. Deliberately still five columns —
 *  `attempt_no` was pencilled in for this task and left out: nothing reads it,
 *  and a column nobody reads is a column nobody maintains.
 *
 *  `delivery_status` is re-read here and NOT trusted from the pre-tx read: the
 *  unlocked read is a hint, and a concurrent worker can CAS the row to
 *  `sending` in the gap between the two. The authoritative resume check is the
 *  one taken under this lock.
 *
 *  `rendered_subject` is read HERE and not taken from the pre-tx read, even
 *  though both resolve the same immutable bytes: the subject goes on the wire,
 *  and every value that does should come from the read taken under the lock. */
interface LockedOutreachRow {
  ask_id: string;
  contact_id: string;
  delivery_status: string;
  rendered_subject: string | null;
  rendered_body: string | null;
}

interface ContactHandleRow {
  email: string | null;
}

/**
 * The three `businesses` columns the outbound envelope needs, read inside tx1.
 *
 * Deliberately a separate read from `readPostalAddressState`, which also reads
 * this table: that function owns the attested-address question and returns the
 * five-column attestation unit, and widening it to carry envelope identity
 * would give one accessor two unrelated duties.
 */
interface BusinessIdentityRow {
  name: string;
  owner_email: string;
  google_place_id: string | null;
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
 * A no-op refusal is a SUCCESS: complete the owned attempt in a minimal
 * transaction so the row can never strand in `dispatched`. A stale attempt
 * no-ops inside the CAS itself.
 *
 * A DELIBERATE second copy of `ask-generation.ts`'s helper of the same name,
 * not an oversight. Its real owner is `src/lib/shared/outbox.ts` — where
 * `markOutboxCompletedIfOwned` already lives and where both lanes already
 * import from — and that is where it should be hoisted the next time this file
 * is opened for a reason that includes it. What it must NOT become is an export
 * of `ask-generation.ts`: this module's only edge to that one is `import type
 * { OutboxHandle }`, deliberately type-only, and a value import would drag the
 * LLM task seam, the cost guard and the Redis cost tracker into the dispatch
 * lane's module graph to borrow five lines.
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
const SLOW_GATE_UNEVALUABLE: SlowGateResult = {
  evidence: { lintPassed: false, moderationClean: false },
  evaluatedBytesDigest: null,
};

/**
 * The identity of the bytes a slow verdict was computed over. Length-prefixed so
 * a subject/body pair cannot be re-partitioned to collide (`"ab"+"c"` and
 * `"a"+"bc"` must not hash alike). `node:crypto` per invariant #10.
 */
export function digestEvaluatedBytes(subject: string, body: string): string {
  return createHash('sha256')
    .update(`${subject.length}:${subject}|${body.length}:${body}`)
    .digest('hex');
}

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
): Promise<SlowGateResult> {
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
    evidence: {
      lintPassed,
      moderationClean: decision.providerStatus === 'clean' && !decision.flagged,
    },
    evaluatedBytesDigest: digestEvaluatedBytes(subject, body),
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
 *
 * It returns the recipient's **Normalized handle** for the same reason. The
 * send path needs it as the envelope's `to:` AND as the token row's
 * `normalized_handle`, and a second read would be a second answer: the handle
 * the ledgers were checked against is the ONLY handle it can be safe to send
 * to, so it has to be the one that travels forward, not one re-derived after
 * the gate has already spoken.
 */
async function gatherFastGateEvidence(
  tx: TransactionSql,
  scope: DispatchScope,
  batch: BatchLifecycleRow,
  outreach: LockedOutreachRow,
  now: Date,
): Promise<{
  evidence: FastGateEvidence;
  suppression: SuppressionMatchRow | null;
  handle: string | null;
}> {
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
    handle,
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

// ── The outbound envelope: token mint + message assembly ─────────────────────
//
// NOT "the send handoff", which is a LOCKED term for a different act in a
// different module at a different point in the lifecycle: the
// `enqueueGenerateSolicitationAsks` call at the end of `constructBatch`
// (`batch-builder.ts`), where a batch becomes send-mode work. What follows is
// per-CONTACT and runs inside one dispatch attempt.

/**
 * Google's write-review deep link, the destination `assembleAskBody`'s
 * `Leave a review: {{review_link}}` line promises. Shape attested in two places
 * already — `src/lib/reviews/url-parser.ts` recognises it as a parseable input,
 * and the review-generation design records it as the format.
 *
 * Deliberately NOT `businesses.google_maps_url`, which the `/r/google/<id>`
 * redirect uses: that is a VIEW link. Sending a recipient who was asked to
 * leave a review to a page that merely displays the business is the whole lane
 * quietly failing at its one job.
 */
const GOOGLE_WRITE_REVIEW_URL_PREFIX = 'https://search.google.com/local/writereview?placeid=';

/**
 * The business's review link, or a THROW — there is no third answer.
 *
 * No new withheld reason (that needs a migration this ticket does not own) and
 * no eighth gate item (B6/B14 lock the gate at seven). An ask whose entire call
 * to action cannot be built is not a message worth sending, and a business that
 * reached the send lane without a usable place id is an UPSTREAM bug: a loud
 * failure names it as one, where a per-contact `withheld` row would file it
 * away as a routine outcome nobody investigates.
 *
 * BOTH arms throw, and the second is the one a reader will assume is fine:
 * migration 007's legacy rows carry hex CIDs (`0x…:0x…`) rather than canonical
 * Place IDs, and `writereview?placeid=<hex cid>` resolves to nothing at all.
 * A silently broken call to action is exactly what failing loudly prevents, so
 * the value is VALIDATED rather than trusted — by `isPlaceId`, which already
 * owns that question and already excludes hex CIDs.
 */
function buildReviewLink(placeId: string | null, outreachId: string): string {
  const candidate = placeId?.trim() ?? '';
  if (!isPlaceId(candidate)) {
    throw new Error(
      `solicitation send: outreach ${outreachId} cannot build its review link — the business `
        + `has no canonical Google place id`,
    );
  }
  // A no-op for every value `isPlaceId` admits (its charset is already
  // URL-safe), kept so a future loosening of that regex cannot silently start
  // producing malformed URLs here.
  return `${GOOGLE_WRITE_REVIEW_URL_PREFIX}${encodeURIComponent(candidate)}`;
}

/**
 * The human-facing opt-out URL (#622 §7.2 block 3), through the SAME accessor
 * and the same route the unsubscribe ingress reads
 * (`worker/ingress/unsubscribe.ts`). The landing page is
 * `src/app/(public)/u/[token]/page.tsx`.
 *
 * FAIL CLOSED when `NEXT_PUBLIC_APP_URL` is unset, exactly as that ingress
 * does: a message whose legally-required opt-out cannot resolve is a compliance
 * defect, not a degraded send.
 */
function buildUnsubscribeUrl(rawToken: string): string {
  const appUrl = getWorkerConfig().NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) {
    throw new Error(
      'NEXT_PUBLIC_APP_URL is unset — a solicitation ask cannot carry a resolvable unsubscribe URL',
    );
  }
  return `${appUrl.replace(/\/+$/, '')}/u/${encodeURIComponent(rawToken)}`;
}

/** The mint's result. The raw token exists ONLY here and downstream in memory. */
interface MintedUnsubscribeToken {
  rawToken: string;
  /** The stored representation, and the only loggable one. */
  tokenHash: string;
}

/**
 * B4's mint: one token row per **Outreach row**, hash only (invariant #5).
 *
 * `ON CONFLICT (outreach_id) WHERE outreach_id IS NOT NULL` is copied
 * BYTE-FOR-BYTE from migration 096's `solicitation_unsubscribe_tokens_outreach_uniq`.
 * A partial index is only inferred from a predicate that matches exactly — a
 * near-miss does not fall back, it raises "no unique or exclusion constraint
 * matching the ON CONFLICT specification" and fails the whole dispatch.
 *
 * `DO NOTHING … RETURNING` returns NO row on conflict, and that is the signal
 * this function exists to produce: the hash is one-way, so an existing row
 * cannot give the raw token back. Returning `null` rather than the row is what
 * makes decision 9's refusal to re-send structural — a caller has nothing it
 * could send WITH.
 */
async function mintUnsubscribeToken(
  tx: TransactionSql,
  scope: DispatchScope,
  input: { askId: string; handle: string },
): Promise<MintedUnsubscribeToken | null> {
  const rawToken = mintUnsubscribeRawToken();
  const tokenHash = hashUnsubscribeToken(rawToken);

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO solicitation_unsubscribe_tokens (
      id, token_hash, normalized_handle, channel,
      account_id, business_id, ask_id, outreach_id, sent_at
    ) VALUES (
      ${uuidv7()}::uuid, ${tokenHash}, ${input.handle}, ${DISPATCH_CHANNEL},
      ${scope.accountId}::uuid, ${scope.businessId}::uuid,
      ${input.askId}::uuid, ${scope.outreachId}::uuid, NOW()
    )
    ON CONFLICT (outreach_id) WHERE outreach_id IS NOT NULL DO NOTHING
    RETURNING id
  `;

  return row === undefined ? null : { rawToken, tokenHash };
}

async function readBusinessIdentity(
  tx: TransactionSql,
  scope: DispatchScope,
): Promise<BusinessIdentityRow> {
  const [row] = await tx<BusinessIdentityRow[]>`
    SELECT name, owner_email, google_place_id
    FROM businesses
    WHERE id = ${scope.businessId}::uuid
      AND account_id = ${scope.accountId}::uuid
  `;
  if (!row) {
    // tx1 already read this location's attested postal address and the gate
    // passed on it, so the row was there moments ago under the same lock.
    throw new Error(
      `solicitation send: business ${scope.businessId} vanished between the gate and the mint`,
    );
  }
  return row;
}

/** Everything `assembleOutboundMessage` needs, so the function itself stays
 *  PURE — no DB, no clock, no config read. */
export interface OutboundMessageInput {
  outreachId: string;
  accountId: string;
  businessId: string;
  batchId: string;
  businessName: string;
  ownerEmail: string;
  recipient: string;
  subject: string;
  /** The STORED bytes, exactly as the owner approved them. */
  storedBody: string;
  unsubscribeUrl: string;
  reviewLink: string;
}

/**
 * `<a>`-wraps a URL that has ALREADY been HTML-escaped. Both the href and the
 * link text are that same escaped string, so the anchor is self-describing and
 * §7.2's "conspicuous" opt-out is a visible URL rather than a bare word.
 */
function anchor(escapedUrl: string): string {
  return `<a href="${escapedUrl}">${escapedUrl}</a>`;
}

/**
 * PURE. B4's substitution and §7.1's mandatory multipart, in one owner.
 *
 * `bodyText` is the STORED body and nothing else — `replaceAll` over the two
 * placeholder constants, no re-render, no reflow, no trim. That byte-identity
 * is what keeps the **Owner approval** contract honest: the recipient reads the
 * bytes the owner approved, with two deterministic tokens resolved. Everything
 * else about the message is envelope, not content.
 *
 * `replaceAll`, not `replace`: lint class 7 already guarantees exactly one of
 * each placeholder, so a second occurrence is an impossible state — but the
 * failure mode of `replace` for that impossible state is a literal
 * `{{review_link}}` in a recipient's inbox, and there is no reason to leave
 * that reachable.
 *
 * `bodyHtml` is derived, never authored: escape the substituted text, promote
 * the two URLs to real anchors, then turn newlines into line breaks. The
 * escape runs FIRST and the anchors are inserted after it, so the anchor markup
 * is structural and the surrounding copy can carry no injected HTML — the URLs
 * are matched in their escaped form for exactly that reason. `solicitation_outreach`
 * stores one plain-text body and `EmailAdapter` refuses a blank `bodyText`, so
 * this derivation is what makes always-multipart possible from one column.
 */
export function assembleOutboundMessage(input: OutboundMessageInput): OutboundMessage {
  const bodyText = input.storedBody
    .replaceAll(UNSUBSCRIBE_URL_PLACEHOLDER, input.unsubscribeUrl)
    .replaceAll(REVIEW_LINK_PLACEHOLDER, input.reviewLink);

  const escapedUnsubscribe = escapeHtml(input.unsubscribeUrl);
  const escapedReview = escapeHtml(input.reviewLink);
  const bodyHtml = escapeHtml(bodyText)
    .replaceAll(escapedUnsubscribe, anchor(escapedUnsubscribe))
    .replaceAll(escapedReview, anchor(escapedReview))
    .replaceAll('\n', '<br />\n');

  // A literal placeholder reaching a recipient is a visible defect that no
  // other check in this lane catches, and the substitution above is the only
  // thing standing between the stored bytes and the wire.
  for (const [field, value] of [
    ['subject', input.subject],
    ['bodyText', bodyText],
    ['bodyHtml', bodyHtml],
  ] as const) {
    if (value.includes(UNSUBSCRIBE_URL_PLACEHOLDER) || value.includes(REVIEW_LINK_PLACEHOLDER)) {
      throw new Error(
        `solicitation send: outreach ${input.outreachId} would ship an unsubstituted `
          + `placeholder in ${field}`,
      );
    }
  }

  return {
    outreachId: input.outreachId,
    accountId: input.accountId,
    businessId: input.businessId,
    batchId: input.batchId,
    businessName: input.businessName,
    ownerEmail: input.ownerEmail,
    recipient: input.recipient,
    subject: input.subject,
    bodyHtml,
    bodyText,
    // The same URL the footer carries, handed over separately because the
    // adapter also feeds it to the RFC 8058 List-Unsubscribe header. Two
    // consumers, one mint.
    unsubscribeUrl: input.unsubscribeUrl,
  };
}

// ── The provider call: bounded in-process retry (decision 9a) ────────────────

/**
 * Three attempts, and the ceiling is deliberately low. A retry here is only
 * ever worth taking while the raw token is in scope, so the whole budget has to
 * fit inside ONE handler invocation — a longer ladder just holds a worker slot
 * open against a provider that has already said no twice.
 */
const SEND_MAX_ATTEMPTS = 3;
const SEND_RETRY_BASE_DELAY_MS = 200;
const SEND_RETRY_MAX_DELAY_MS = 2_000;

/**
 * Equal jitter: half the window is fixed so a retry is never immediate, half is
 * random so a batch's concurrent retries do not re-collide in lockstep against
 * a provider whose 10 req/s limit is per TEAM. `randomInt` is node's own
 * (invariant #10).
 */
function sendRetryDelayMs(attempt: number): number {
  const ceiling = Math.min(
    SEND_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    SEND_RETRY_MAX_DELAY_MS,
  );
  const fixed = Math.floor(ceiling / 2);
  return fixed + randomInt(0, fixed + 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What the provider did, as tx2 needs to record it. */
type SendResult =
  | { kind: 'sent'; providerMessageId: string; attempts: number }
  | { kind: 'failed'; failure: SendFailureClass; attempts: number };

/**
 * Puts ONE assembled message on the wire, absorbing `retryable` failures in
 * process (decision 9a).
 *
 * The SAME `message` object is handed to every attempt — never a rebuilt one.
 * `EmailAdapter` derives the provider idempotency key from `message.outreachId`
 * (email-adapter.ts), so a retry that rebuilt the body would re-issue DIFFERENT
 * content under the same key, which is worse than sending twice.
 *
 * Only `retryable` is retried; `terminal_bounce` and `terminal_other` return on
 * the first attempt with zero delay, and an exhausted budget returns
 * `retryable` — tx2 terminalizes that arm exactly as it terminalizes
 * `terminal_other`, so no class is left without one.
 *
 * NOTHING FROM THE FAILURE IS LOGGED but its CLASS and the attempt number.
 * Resend's error text quotes the offending field, so it can carry the recipient
 * address (`email-adapter.ts` says so where it puts that text on `cause`); the
 * classification is the whole of what an operator needs here.
 */
async function sendWithBoundedRetry(
  message: OutboundMessage,
  logger: ReturnType<typeof createWorkerLogger>,
  context: Record<string, unknown>,
): Promise<SendResult> {
  for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { providerMessageId } = await getMessagingAdapter().send(message);
      return { kind: 'sent', providerMessageId, attempts: attempt };
    } catch (err) {
      const failure = classifySendFailure(err);
      if (failure !== 'retryable' || attempt === SEND_MAX_ATTEMPTS) {
        return { kind: 'failed', failure, attempts: attempt };
      }
      logger.warn('solicitation send: retryable provider failure — retrying in process', {
        ...context,
        failure_class: failure,
        provider_attempt: attempt,
      });
      await sleep(sendRetryDelayMs(attempt));
    }
  }
  // Unreachable: the loop either returns or exhausts on its last iteration,
  // where `attempt === SEND_MAX_ATTEMPTS` takes the return above. Kept so the
  // function is total for a reader as well as for the type checker.
  return { kind: 'failed', failure: 'retryable', attempts: SEND_MAX_ATTEMPTS };
}

// ── tx2: the five terminal facts, in ONE transaction ─────────────────────────

/**
 * The one reason a dispatch that reached the provider can carry. 091's
 * status/reason CHECK pairs `failed` with exactly `send_failed` and
 * `send_exhausted`; the latter belongs to the `'failed'` exhaustion hook, which
 * is the only writer that knows a BullMQ attempt ladder ran out.
 */
const SEND_FAILED_REASON = 'send_failed';

interface TerminalCommitInput {
  childRunId: string;
  outboxId: string;
  attempt: number;
  result: SendResult;
}

/** `NOW()` or NULL, so one UPDATE can express both terminal shapes without a
 *  second near-identical statement. */
function nowIf(tx: TransactionSql, condition: boolean): PendingQuery<Row[]> | null {
  return condition ? tx`NOW()` : null;
}

/**
 * D12a's all-or-nothing terminal: the `sending → sent | failed` CAS, the
 * **Lazy child**'s terminal, the `solicitation_sent` outcome, the outbox
 * completion and the `closeBatchIfSettled` join, in the caller's tx2.
 *
 * THE ADVISORY LOCK IS THE FIRST STATEMENT, for the same reason it is in tx1:
 * the offboarding purge takes this key and THEN row-locks (cascades into)
 * `solicitation_outreach`, so a transaction that row-locked the Outreach row
 * first and then waited for the batch row would be an ABBA deadlock against it
 * (`acquireSolicitationBatchLock`'s docstring owns that contract).
 *
 * `bounced_at` is stamped for `terminal_bounce` and NOTHING ELSE — it feeds the
 * Suppression ledger and the **Send breaker**'s hard-bounce numerator, and a
 * 5xx recorded as a bounce would suppress a contact who never bounced.
 * `bounce_kind` is deliberately left NULL: `send-breaker.ts` counts an
 * unclassified bounce WITH the hard ones precisely so this lane never has to
 * assert a kind the provider did not give it.
 *
 * `provider_message_id` is not optional on the sent arm. It is the join key
 * every later bounce, complaint and opt-out webhook resolves against, so a
 * `sent` row without one makes all three unattributable.
 *
 * WHICH IS WHY EVERYTHING ABOUT THE SEND HANGS OFF THE CAS. When the CAS
 * matches no row another writer already terminalized it, and this transaction
 * therefore CANNOT persist `provider_message_id` — the column belongs to a row
 * whose final status it does not own. Recording `solicitation_sent` and
 * completing the child anyway would publish a send the lane can never attribute
 * a bounce, complaint or opt-out to, and would close the 503-retry window on a
 * message nothing in Postgres links back to the provider. So the outcome, the
 * `ask_sent` step and the child's terminal are all conditional on the CAS, and
 * `closeBatchIfSettled` with them — the writer that DID terminalize the row
 * joined the batch in its own transaction, and a **Settled batch** joined twice
 * is a duplicate receipt step (the exhaustion hook makes the identical call for
 * the identical reason).
 *
 * The outbox attempt is the ONE thing still owed on that branch. It is spent
 * either way: this invocation reached the provider and can make no further
 * progress on the row, so leaving the attempt in flight would only have the
 * watchdog re-dispatch a job whose sole remaining act is to observe that the
 * row is no longer `queued`.
 */
async function commitSendTerminal(
  tx: TransactionSql,
  scope: DispatchScope,
  input: TerminalCommitInput,
  logger: ReturnType<typeof createWorkerLogger>,
  context: Record<string, unknown>,
): Promise<void> {
  await acquireSolicitationBatchLock(tx, scope.businessId);

  const sent = input.result.kind === 'sent';
  const bounced = input.result.kind === 'failed' && input.result.failure === 'terminal_bounce';

  const terminalized = await tx<{ id: string }[]>`
    UPDATE solicitation_outreach
    SET delivery_status = ${sent ? 'sent' : 'failed'},
        disposition_reason = ${sent ? null : SEND_FAILED_REASON},
        sent_at = ${nowIf(tx, sent)},
        provider_message_id = ${input.result.kind === 'sent' ? input.result.providerMessageId : null},
        bounced_at = ${nowIf(tx, bounced)},
        updated_at = NOW()
    WHERE id = ${scope.outreachId}::uuid
      AND account_id = ${scope.accountId}::uuid
      AND business_id = ${scope.businessId}::uuid
      AND delivery_status = 'sending'
    RETURNING id
  `;
  if (terminalized.count === 0) {
    // Another writer terminalized the row between tx1 and here — #900's D12d
    // sweep is the only candidate today. Its verdict STANDS (the CAS is what
    // makes that true), and NOTHING about the send may be committed on top of
    // it: `provider_message_id` did not persist, so a `solicitation_sent`
    // outcome here would be a value-ledger row with no join key behind it, and
    // a `completed` child would claim a delivery this transaction failed to
    // record. Only the outbox attempt is settled — see the docstring.
    logger.warn('solicitation send: terminal CAS found no sending row — another writer owns it', {
      ...context,
      outreach_id: scope.outreachId,
      provider_result: input.result.kind,
      // The id that DID come back from the provider, so the send is at least
      // recoverable from the log even though the row could not take it.
      provider_message_id: input.result.kind === 'sent' ? input.result.providerMessageId : null,
    });
    await markOutboxCompletedIfOwned(tx, input.outboxId, input.attempt);
    return;
  }

  if (sent) {
    await recordStep(tx, {
      runId: input.childRunId,
      stepKey: 'ask_sent',
      detail: {
        outreach_id: scope.outreachId,
        provider_attempts: input.result.attempts,
      },
    });
    // On the CHILD, never the **Send batch parent**:
    // `agent_outcomes_once_per_run_kind` is UNIQUE (agent_run_id, outcome_kind),
    // so 25 sends attributed to the parent would collapse into one row and every
    // downstream count would under-report the batch by 24.
    await recordOutcome(tx, {
      runId: input.childRunId,
      accountId: scope.accountId,
      businessId: scope.businessId,
      attributedAgent: 'solicitation',
      outcomeKind: 'solicitation_sent',
      unitCount: 1,
    });
  }

  // Decision 8: `completed` for a send, `failed` for every terminal provider
  // outcome — including an exhausted retry budget, which is a failure to send
  // and not a refusal to. The failure arm records the CLASS and the attempt
  // count and nothing else; the provider's own text is never persisted here
  // (see `sendWithBoundedRetry`).
  if (input.result.kind === 'sent') {
    await completeRun(tx, input.childRunId, 'completed');
  } else {
    await completeRun(tx, input.childRunId, 'failed', {
      failure_class: input.result.failure,
      provider_attempts: input.result.attempts,
    });
  }

  await markOutboxCompletedIfOwned(tx, input.outboxId, input.attempt);
  await closeBatchIfSettled(tx, {
    batchId: scope.batchId,
    accountId: scope.accountId,
    businessId: scope.businessId,
  });
}

/**
 * The **Lazy child** for one dispatch attempt — decision 7, and the ONE owner of
 * that creation for both of this lane's outcomes (a withhold and a send create
 * exactly the same child).
 *
 * Created at RELEASE and never at build: the spine records work performed, never
 * work planned. The parent is looked up, never minted — a missing **Send batch
 * parent** means generation never ran, and asserting that impossible state beats
 * inventing a parent the generation lane owns.
 */
async function startLazyChild(
  tx: TransactionSql,
  scope: DispatchScope,
  askId: string,
): Promise<{ runId: string }> {
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
  return startOrGetSolicitationAskRun(tx, {
    askId,
    accountId: scope.accountId,
    businessId: scope.businessId,
    parentRunId: parent.runId,
  });
}

interface DeferStepDetail {
  gateItem: DispatchGateItem;
  askId?: string;
  batchState?: BatchState;
}

/**
 * The spine step a DEFER owes — the intake contract's edge case 2, which
 * promises a flag-off defer "records a spine step", and the observability
 * entry that depends on it.
 *
 * ON THE **Send batch parent**, never the **Lazy child**. The child is
 * per-dispatch-ATTEMPT and is created at the moment a dispatch actually happens
 * (decision 7); a defer never dispatches, so minting one for it would put a run
 * on the spine for work that was declined before it started — and #900 re-drips
 * the same row, so that run would then need reconciling against the real
 * attempt's child. The parent already exists, `findActiveSolicitationSendBatchRun`
 * already reads it, and a defer is a fact about the batch's progress rather than
 * about one contact's dispatch.
 *
 * BEST-EFFORT, and that asymmetry with `startLazyChild` is deliberate. That
 * function THROWS on a missing parent, because a real dispatch the spine cannot
 * account for is a bug to surface. Here a throw would convert a quiet
 * no-decision into a BullMQ failure ladder whose last rung is the exhaustion
 * hook terminalizing a row nobody decided anything about — strictly worse than
 * a defer with no step. The caller reports which happened.
 *
 * ids and closed enum values only — never the handle, the subject or the body.
 */
async function recordDeferStepOnParent(
  tx: TransactionSql,
  scope: DispatchScope,
  detail: DeferStepDetail,
): Promise<boolean> {
  const parent = await findActiveSolicitationSendBatchRun(tx, {
    batchId: scope.batchId,
    accountId: scope.accountId,
    businessId: scope.businessId,
  });
  if (parent === null) return false;

  await recordStep(tx, {
    runId: parent.runId,
    stepKey: 'dispatch_gate_evaluated',
    detail: {
      outreach_id: scope.outreachId,
      ...(detail.askId === undefined ? {} : { ask_id: detail.askId }),
      gate_item: detail.gateItem,
      outcome: 'defer',
      ...(detail.batchState === undefined ? {} : { batch_state: detail.batchState }),
    },
  });
  return true;
}

/**
 * The flag-off defer, as its own minimal transaction — decision 5 reached
 * ABOVE tx1, so it has no transaction to join.
 *
 * The opening order is tx1's: the stale-attempt guard is the ownership CAS
 * itself (`markOutboxCompletedIfOwned` matches on the exact attempt), so
 * attempt N-1 arriving after attempt N was dispatched writes NOTHING — neither
 * the completion nor the step. The advisory lock follows for the same global
 * lock-order reason it does everywhere else in this lane.
 */
async function commitFlagOffDefer(
  sql: Sql,
  scope: DispatchScope,
  handle: { outboxId: string; attempt: number },
): Promise<{ ownsAttempt: boolean; stepRecorded: boolean }> {
  const result = { ownsAttempt: false, stepRecorded: false };

  await sql.begin(async (tx: TransactionSql) => {
    result.ownsAttempt = await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    if (!result.ownsAttempt) return;

    await acquireSolicitationBatchLock(tx, scope.businessId);
    result.stepRecorded = await recordDeferStepOnParent(tx, scope, { gateItem: 'send_flag' });
  });

  return result;
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
 * The child terminalizes `completed` (decision 8): a correct refusal is
 * completed work, not a failure. `moderation_status` and `moderation_detail`
 * are NOT touched; they are render provenance (decision 6).
 */
async function commitWithhold(
  tx: TransactionSql,
  scope: DispatchScope,
  input: WithholdCommitInput,
): Promise<void> {
  const child = await startLazyChild(tx, scope, input.askId);

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

/** What tx1 decided, for the caller to act on. */
type DispatchTxOutcome =
  | { kind: 'stale' }
  | { kind: 'vanished' }
  | { kind: 'cancelled' }
  /** `stepRecorded` is false only when the **Send batch parent** run is gone or
   *  already terminal — see `recordDeferStepOnParent` on why that is reported
   *  rather than thrown. */
  | { kind: 'deferred'; item: DispatchGateItem; batchState: BatchState; stepRecorded: boolean }
  | { kind: 'withheld'; item: DispatchGateItem; reason: OutreachWithheldReason }
  /** Decision 9, the ONE resume outcome. Some prior invocation owns this
   *  dispatch: the row is already `sending`, or — defensively — its token row
   *  is already there, and either way the raw token is gone with it, so no
   *  correct body can be rebuilt. Nothing more may happen to the row here. */
  | { kind: 'in_flight_elsewhere'; detector: 'sending_row' | 'token_conflict' | 'cas_lost' }
  /** The stored bytes changed between the unlocked slow-item gather and the
   *  lock, so the lint and moderation verdicts in hand describe an artifact this
   *  row no longer holds. Nothing is wrong with the ask — we raced a writer — so
   *  the row is left alone for a later attempt to re-gather and decide honestly.
   *  Round-1 adversarial review, finding A4. */
  | { kind: 'bytes_changed_under_gate' }
  /** The row is not `queued`, so it was never released for this attempt. No
   *  gate, no writes, nothing to terminalize — the row belongs to another point
   *  in its lifecycle. Round-1 standards review. */
  | { kind: 'not_dispatchable'; status: string }
  /** The gate passed, the child exists, the row is CAS'd to `sending` and the
   *  envelope is built. The caller puts `message` on the wire OUTSIDE tx1 (no
   *  lock across a remote call) and commits the terminal facts in tx2. */
  | {
    kind: 'assembled';
    message: OutboundMessage;
    tokenLogPrefix: string;
    childRunId: string;
  };

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
  slow: SlowGateResult,
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
    SELECT ask_id, contact_id, delivery_status, rendered_subject, rendered_body
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

  if (outreach.delivery_status === 'sending') {
    // Decision 9b under the LOCK. The orchestrator already short-circuits on
    // this from its unlocked read; this is the race-tight repeat, because a
    // concurrent worker can CAS the row between that read and this one. The
    // gate is skipped ENTIRELY — re-gating a row whose message may already have
    // reached a real person could record `withheld` about a delivered ask.
    await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    return { kind: 'in_flight_elsewhere', detector: 'sending_row' };
  }

  // ONLY a `queued` row is dispatchable, and this guard must stand BEFORE any
  // write — round-1 standards review, and the root cause of three HIGH findings.
  //
  // `queued` is the release's own CAS (#900), so a row arriving in any other
  // status was never released for THIS attempt. Without this guard the two
  // branches above were the only short-circuits, and a `rendered`, `sent`,
  // `withheld`, `failed` or `unknown` row would walk the whole gate before the
  // `queued` predicate on the CAS below finally rejected it — by which point
  // tx1 has already committed real damage:
  //
  //   * `commitWithhold` carries no status predicate, so a gate failure would
  //     terminalize a never-released `rendered` row as `withheld` (091's CHECKs
  //     accept that transition, so nothing downstream catches it);
  //   * on a gate PASS the unsubscribe token row commits before the CAS fails,
  //     and because a hash cannot yield its raw token, #900's later legitimate
  //     release then hits `token_conflict` and refuses that contact FOREVER.
  //
  // Both are latent today only because #900 does not exist to enqueue this
  // topic. Completing the attempt is the whole of what is owed: the row belongs
  // to another lifecycle point, and this attempt has nothing to say about it.
  if (outreach.delivery_status !== 'queued') {
    await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    return { kind: 'not_dispatchable', status: outreach.delivery_status };
  }

  // A4: PROVE the locked bytes are the ones the slow items were computed over.
  //
  // `slow` was gathered from an unlocked read, and its safety rests on stored
  // bytes being immutable after approval — which ADR 0020 enforces in a DOMAIN
  // MODULE, not in the schema. Nothing in Postgres stops a repair script, a new
  // lane, or a future writer from editing `rendered_body` in between. Without
  // this comparison the worker would moderate one artifact and send another,
  // silently, and the **Owner approval** byte-for-byte contract would be a
  // convention rather than a check.
  //
  // Treated as a DEFER, not a withhold: nothing about the ask is wrong, we
  // simply raced a writer, and the next attempt re-gathers against the new bytes
  // and decides honestly. Withholding here would terminalize a row over a race.
  if (
    slow.evaluatedBytesDigest !== null
    && outreach.rendered_subject !== null
    && outreach.rendered_body !== null
    && digestEvaluatedBytes(outreach.rendered_subject, outreach.rendered_body)
      !== slow.evaluatedBytesDigest
  ) {
    await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    return { kind: 'bytes_changed_under_gate' };
  }

  const now = new Date();
  const { evidence, suppression, handle: recipient } = await gatherFastGateEvidence(
    tx,
    scope,
    batchRow,
    outreach,
    now,
  );

  // The two SLOW items arrive already decided, from above tx1 (decision 3).
  // `applyDispatchGate` is the only place the two records meet, so the gate's
  // B6 order survives the split gathering.
  const verdict = applyDispatchGate(slow.evidence, evidence);

  if (!verdict.pass && verdict.outcome === 'defer') {
    // No DOMAIN state is written, not even the consent snapshot: a defer is a
    // no-decision and the row is one #900's producer re-drips. The attempt is
    // still completed — the watchdog reclaims every in-flight status, so a
    // defer left `dispatched` is re-dispatched every stale window forever.
    //
    // The SPINE step is not domain state: without it a deferred attempt leaves
    // no trace anywhere but a log line, and the batch's own run cannot account
    // for why a contact it planned to reach was not reached.
    const batchState = deriveBatchState(batchRow, now);
    const stepRecorded = await recordDeferStepOnParent(tx, scope, {
      gateItem: verdict.item,
      askId: outreach.ask_id,
      batchState,
    });
    await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    return {
      kind: 'deferred',
      item: verdict.item,
      batchState,
      stepRecorded,
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

  // Every impossible state below is ASSERTED, not branched around. Each one is
  // unreachable through the gate that just passed — a null handle makes the
  // consent lookup miss and withholds `no_consent`; a null subject or body
  // makes the re-lint unevaluable and withholds `lint_failed` — so reaching one
  // means the gate and this path disagree about what "passed" means, which is a
  // bug to surface rather than a contact to quietly drop.
  // Truthiness, not `!== null`: an empty string is as unsendable as a NULL —
  // `EmailAdapter` refuses a blank recipient and a blank text part outright —
  // and collapsing both into one assertion beats two arms that differ only in
  // which impossible state they name.
  if (!recipient) {
    throw new Error(
      `solicitation send: outreach ${scope.outreachId} passed the Dispatch gate with no `
        + `recipient handle`,
    );
  }
  if (!outreach.rendered_subject || !outreach.rendered_body) {
    throw new Error(
      `solicitation send: outreach ${scope.outreachId} passed the Dispatch gate with no `
        + `stored artifact`,
    );
  }

  const business = await readBusinessIdentity(tx, scope);
  // BEFORE the mint: a business whose call to action cannot be built has no
  // business burning a token row it could never use.
  const reviewLink = buildReviewLink(business.google_place_id, scope.outreachId);

  const minted = await mintUnsubscribeToken(tx, scope, {
    askId: outreach.ask_id,
    handle: recipient,
  });
  if (minted === null) {
    // The SAME refusal as the `sending` arm above, reached by a different
    // detector. Since the CAS below shares this transaction, a committed token
    // row implies a `sending` row and this branch is normally unreachable — it
    // survives for the row a later writer moved OUT of `sending` (D12d's
    // `unknown`, the exhaustion hook's `failed`) and #900 then re-dripped. The
    // hash cannot give the raw token back either way, so the answer is
    // identical: complete the attempt, write NOTHING else, return.
    //
    // The mint therefore runs BEFORE the child is created deliberately. A
    // conflict here must leave no run behind — creating one, stamping
    // `agent_run_id` over a terminal row's and recording a step would be three
    // writes about work this invocation is refusing to do.
    await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    return { kind: 'in_flight_elsewhere', detector: 'token_conflict' };
  }

  const child = await startLazyChild(tx, scope, outreach.ask_id);

  await tx`
    UPDATE solicitation_outreach
    SET agent_run_id = ${child.runId}::uuid,
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
      ask_id: outreach.ask_id,
      outcome: 'send',
    },
  });

  // The claim, and the last write tx1 makes. `sending_at` is the OUTREACH row's
  // stamp; `solicitation_batches.sending_started_at` is a different column with
  // a different owner (#900's first successful release, in the release
  // transaction) and is deliberately NOT written here — which is why
  // `isBatchOpenForSend` admits `approved` as well as `sending`.
  //
  // Zero rows means another writer owns this dispatch. Unreachable while this
  // transaction holds the row's `FOR UPDATE` — the status was read under it a
  // few statements ago — so the guard is belt and braces, and it is what makes
  // the stamp and the status move as one act rather than as two.
  const claimed = await tx<{ id: string }[]>`
    UPDATE solicitation_outreach
    SET delivery_status = 'sending',
        sending_at = NOW(),
        updated_at = NOW()
    WHERE id = ${scope.outreachId}::uuid
      AND account_id = ${scope.accountId}::uuid
      AND business_id = ${scope.businessId}::uuid
      AND delivery_status = 'queued'
    RETURNING id
  `;
  if (claimed.count === 0) {
    // Its own detector rather than the `sending` one: all this observed is
    // "the row was no longer `queued`", and claiming it was `sending`
    // specifically would put a fact in the log nothing here established.
    await markOutboxCompletedIfOwned(tx, handle.outboxId, handle.attempt);
    return { kind: 'in_flight_elsewhere', detector: 'cas_lost' };
  }

  const message = assembleOutboundMessage({
    outreachId: scope.outreachId,
    accountId: scope.accountId,
    businessId: scope.businessId,
    batchId: scope.batchId,
    businessName: business.name,
    ownerEmail: business.owner_email,
    recipient,
    subject: outreach.rendered_subject,
    storedBody: outreach.rendered_body,
    unsubscribeUrl: buildUnsubscribeUrl(minted.rawToken),
    reviewLink,
  });

  return {
    kind: 'assembled',
    message,
    tokenLogPrefix: unsubscribeTokenLogPrefix(minted.rawToken),
    childRunId: child.runId,
  };
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

  // Decision 9b, and the FIRST thing decided about a row that exists: a
  // `sending` row belongs to an invocation that already put (or may already
  // have put) this ask on the wire. The Dispatch gate is skipped entirely and
  // the adapter is never reached — the raw unsubscribe token died with that
  // process, so no correct message can be built and no honest verdict can be
  // recorded. The attempt is completed so the watchdog stops re-pending work
  // that can never progress, and #900's D12d sweep terminalizes the row
  // `unknown` / `send_indeterminate` after `UNKNOWN_GRACE_MINUTES`.
  //
  // NO TOKEN PREFIX ON THIS LINE. `unsubscribeTokenLogPrefix` takes the RAW
  // token, which is exactly what this process does not have; the stored hash is
  // not a value this lane logs to identify a row by (invariant #5, §9.5).
  if (row.delivery_status === 'sending') {
    await completeOutboxNoop(sql, outboxId, attempt);
    logger.warn('solicitation send: outreach row already sending — not re-sending', {
      batch_id: input.batchId,
      outreach_id: input.outreachId,
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

  // Decision 5: the flag flipped between enqueue and run ⇒ DEFER. The row keeps
  // its current status — most often `queued` — and #900's producer re-drips it
  // once the lane is switched back on. Never a withhold: there is no `flag_off`
  // reason in 091/110 and terminalizing here would end an attempt the owner
  // still owns.
  //
  // `send_flag` is the gate's OWN item 2, evaluated early rather than replaced,
  // which is why the step this writes is indistinguishable from the one tx1's
  // gate-defer writes. The two paths differ in WHERE the flag was read, never in
  // what they claim happened.
  if (!solicitationSendEnabled()) {
    const defer = await commitFlagOffDefer(sql, scope, { outboxId, attempt });
    if (!defer.ownsAttempt) {
      logger.warn('solicitation send: stale outbox attempt on a flag-off defer — nothing done', {
        ...context,
        outbox_id: outboxId,
        outbox_attempt: attempt,
      });
      return;
    }
    logger.log('solicitation send deferred: send flag disabled', {
      ...context,
      delivery_status: row.delivery_status,
      spine_step_recorded: defer.stepRecorded,
    });
    return;
  }

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
  if (outcome.kind === 'not_dispatchable') {
    // Only `queued` is dispatchable. Anything else means this attempt is not the
    // one that owns the row — warn rather than log, because with #900 releasing
    // correctly it should never happen, and a run of these is the signal that
    // something is enqueueing outside the release CAS.
    logger.warn('solicitation send no-op: outreach row is not queued', {
      ...context,
      delivery_status: outcome.status,
    });
    return;
  }
  if (outcome.kind === 'bytes_changed_under_gate') {
    // The lint/moderation verdicts in hand describe bytes this row no longer
    // holds, so they cannot authorise this send. Nothing is wrong with the ask —
    // a later attempt re-gathers against the current bytes and decides honestly.
    logger.warn(
      'solicitation send no-op: stored bytes changed between the gate and the lock',
      context,
    );
    return;
  }
  if (outcome.kind === 'deferred') {
    logger.log('solicitation send deferred by the dispatch gate', {
      ...context,
      gate_item: outcome.item,
      batch_state: outcome.batchState,
      spine_step_recorded: outcome.stepRecorded,
    });
    return;
  }
  if (outcome.kind === 'withheld') {
    logger.log('solicitation send withheld by the dispatch gate', {
      ...context,
      gate_item: outcome.item,
      disposition_reason: outcome.reason,
    });
    return;
  }
  if (outcome.kind === 'in_flight_elsewhere') {
    // Decision 9's cost, stated where an operator will read it — one line for
    // one refusal, with the detector that reached it. No token prefix: this
    // process never held the raw token.
    logger.warn(
      'solicitation send: dispatch already in flight elsewhere — not re-sending',
      { ...context, detector: outcome.detector },
    );
    return;
  }

  // The token prefix is the ONLY form of the token that may be logged
  // (invariant #5, §9.5) — enough to correlate this attempt with its retry,
  // worthless to whoever reads the log. The recipient, the subject and the body
  // are on `outcome.message` and none of them appears here.
  logger.log('solicitation send: unsubscribe token minted and message assembled', {
    ...context,
    unsubscribe_token: outcome.tokenLogPrefix,
  });

  // THE WIRE, with NO lock held: tx1 committed above, and the batch row it
  // locked is free again before this round trip starts. Retryable failures are
  // absorbed inside this call (decision 9a) while the raw token is in scope.
  const result = await sendWithBoundedRetry(outcome.message, logger, context);

  // tx2. A failure here commits NOTHING — not the terminal status, not the
  // child's terminal, not the outcome, and not the outbox completion — so the
  // watchdog still owns the work (D12a). That is precisely why this lane needs
  // no orphan sweeper, and why the throw is allowed to propagate.
  await sql.begin(async (tx) => {
    await commitSendTerminal(
      tx,
      scope,
      {
        childRunId: outcome.childRunId,
        outboxId,
        attempt,
        result,
      },
      logger,
      context,
    );
  });

  if (result.kind === 'sent') {
    logger.log('solicitation send: ask sent', {
      ...context,
      // The PROVIDER's id, which identifies the message and not the recipient —
      // and the join key every later bounce and complaint arrives on.
      provider_message_id: result.providerMessageId,
      provider_attempts: result.attempts,
    });
    return;
  }

  logger.warn('solicitation send: terminal provider failure', {
    ...context,
    failure_class: result.failure,
    provider_attempts: result.attempts,
  });
}
