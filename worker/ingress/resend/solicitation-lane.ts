// The Solicitation lane (#657, spec §5). Selected by the echoed Resend tag
// BEFORE any DB lookup — chosen over a try-table-A-fall-back-to-B chain, which
// couples the two lanes and makes a genuinely-unknown email_id indistinguishable
// from a lane mismatch.
//
// WRITE SURFACE, deliberately narrow (owner decision 2026-08-16): this lane
// writes ONLY the async signal columns migration 091 calls "columns, NOT statuses
// (D13)" — bounced_at, complained_at, provider_error — plus the Suppression
// ledger. It NEVER writes delivery_status or sent_at (#630 owns the send
// lifecycle, and a webhook write would race 091's ladder CHECKs), and never
// unsubscribed_at (the RFC 8058 POST lands on worker/ingress/unsubscribe.ts).
// Spec §5.3's delivered_at effect is dropped: the column does not exist and this
// ticket carries no migration.
//
// UNMATCHED ATTRIBUTION splits by event (#967). A soft bounce and email.failed
// warn and ack. A permanent bounce, a complaint and email.suppressed write the
// recipient's GLOBAL opt-out from the SIGNED payload and ack, because our own
// contact row may be gone for good — an account purge deletes it, and a send
// whose terminal CAS lost never persisted a provider_message_id to match. This
// replaced a 503-and-retry; see suppressWithoutAttribution for what that trade
// costs and why it was taken.

import type { Sql, TransactionSql } from 'postgres';
import { LANE_TAG_NAME, SOLICITATION_LANE_TAG_VALUE } from '../../../src/lib/messaging/lane-tag';
import {
  recordSuppression,
  type SuppressionSource,
} from '../../../src/lib/solicitation/suppression';
import { normalizeEmail } from '../../../src/lib/solicitation/handles';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { classifyBounce, extractBounceType } from './bounce-classifier';

const logger = createWorkerLogger('ingress/resend/solicitation');

/**
 * True when this payload belongs to the Solicitation lane (§5.1).
 *
 * The tag name and value are IMPORTED, never spelled here: the adapter that
 * emits them (`src/lib/messaging/email-adapter.ts`) is on the other side of a
 * cross-module contract that `src/lib/messaging/lane-tag.ts` owns — a leaf
 * module with no imports, so this ingress does not reach the Resend SDK just to
 * read two strings. A re-spelling here is exactly how the two halves drift apart
 * and every solicitation webhook silently falls through to the notification lane.
 */
export function isSolicitationLane(data: unknown): boolean {
  return readTag(data, LANE_TAG_NAME) === SOLICITATION_LANE_TAG_VALUE;
}

function readTag(data: unknown, name: string): string | null {
  if (!isRecord(data)) return null;
  const tags = data.tags;
  if (isRecord(tags) && typeof tags[name] === 'string') return tags[name];
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (isRecord(tag) && tag.name === name && typeof tag.value === 'string') return tag.value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

interface OutreachAttribution {
  id: string;
  account_id: string;
  business_id: string;
  /** solicitation_contacts.email — this column IS the Normalized handle (086). */
  normalized_handle: string;
}

/**
 * Cross-account by construction — a webhook arrives with a provider message id and
 * no tenant context, so this is allowlisted in the tenant-scope audit. The row it
 * finds supplies the account scope every later write uses.
 *
 * MUST be called inside sql.begin(): the FOR UPDATE lock is what stops the row
 * being deleted between this read and the UPDATE that follows it.
 */
async function loadAttribution(
  tx: TransactionSql,
  emailId: string,
): Promise<OutreachAttribution | null> {
  const rows = await tx<{ id: string; account_id: string; business_id: string; email: string | null }[]>`
    SELECT o.id, o.account_id, o.business_id, c.email
      FROM solicitation_outreach o
      JOIN solicitation_contacts c ON c.id = o.contact_id
     WHERE o.provider_message_id = ${emailId}
     LIMIT 2
     FOR UPDATE OF o
  `;

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    // Impossible: #630 writes one provider_message_id per attempt. Refuse rather
    // than mutate whichever row the planner happened to return first.
    throw new Error(
      `ambiguous provider_message_id matched multiple outreach rows: ${emailId}`,
    );
  }

  const row = rows[0]!;
  if (!row.email) {
    // Impossible: a phone-only contact cannot have received an email ask.
    throw new Error(`outreach ${row.id} has an email provider event but no contact email`);
  }

  return {
    id: row.id,
    account_id: row.account_id,
    business_id: row.business_id,
    normalized_handle: row.email,
  };
}

/** Observability-only events: §5.1's warn-and-ack, unchanged. */
function warnUnmatched(emailId: string, event: string): void {
  // Never logs the recipient address. A sustained rate here means the lane tag is
  // being emitted for sends we are not recording.
  logger.warn({
    msg: 'solicitation webhook matched no outreach row — nothing written',
    event,
    provider_message_id: emailId,
  });
}

/**
 * What an unmatched `provider_message_id` MEANS for a given event (#967).
 *
 * `ignore` — soft bounce and `email.failed`: nothing is lost that a later event
 * cannot re-establish, so warn and ack.
 *
 * `suppress` — permanent bounce, complaint, `email.suppressed`: the recipient's
 * opt-out is the one fact that MUST survive, so write it from the signed
 * payload and ack.
 */
type UnmatchedPolicy =
  | { kind: 'ignore' }
  | { kind: 'suppress'; source: SuppressionSourceToRecord };

/** `to` as Resend sends it (array) and as older shapes send it (string) — the
 *  same defensive read `extractBounceType` uses. A blank entry is not an
 *  address. */
function readRecipients(data: unknown): string[] {
  if (!isRecord(data)) return [];
  const to = data.to;
  if (typeof to === 'string') return to.trim().length > 0 ? [to] : [];
  if (!Array.isArray(to)) return [];
  return to.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

/**
 * The signed payload's recipient, normalized — the ONLY input the fallback has
 * once our own contact row is gone.
 *
 * EXACTLY ONE ADDRESS, OR THROW. This lane sends one ask to one contact, so any
 * other cardinality means the payload is not ours, and a global ledger row
 * blocks that person for EVERY tenant. Guessing is a real harm, not a tidy
 * default: assert the impossible state rather than suppressing whatever `to`
 * happened to hold.
 *
 * NORMALIZED, and normalized HERE only because attribution is gone. When the
 * contact row exists its stored `email` wins and this function is never reached
 * — that column IS the Normalized handle (migration 086). Storing the raw echo
 * instead would be worse than the gap it closes: the §1.2 lookup compares
 * against normalized handles, so the opt-out would be written and then honoured
 * nowhere. `normalizeEmail` is IMPORTED because
 * `src/lib/solicitation/handles.ts` is its single owner and CSV ingest derives
 * its handles from that same function; a second normalizer here is how the two
 * halves silently diverge.
 *
 * NO ADDRESS EVER REACHES AN ERROR MESSAGE. These strings land in
 * `inbound_events.error_message` and in the logs; the count diagnoses the
 * payload shape without carrying the recipient.
 */
function extractSoleRecipient(data: unknown, emailId: string, event: string): string {
  const recipients = readRecipients(data);
  if (recipients.length !== 1) {
    throw new Error(
      `unattributed ${event} carried ${recipients.length} recipient addresses, expected exactly 1: ${emailId}`,
    );
  }
  const handle = normalizeEmail(recipients[0]!);
  if (handle === null) {
    throw new Error(`unattributed ${event} carried an unparseable recipient address: ${emailId}`);
  }
  return handle;
}

/**
 * The unmatched branch for a suppression-bearing event, run INSIDE
 * `withAttribution`'s transaction (#967).
 *
 * WHY A FALLBACK EXISTS AT ALL. `loadAttribution` resolves the recipient by
 * joining our own `solicitation_contacts` row, and an account purge deletes it
 * (`purge-stages.ts` cascades `contact_csv_uploads` → contacts → asks →
 * outreach). Without this branch, a bounce arriving after the purge could not
 * write the recipient's GLOBAL opt-out — the one thing the purge's suppression
 * contract promises to preserve. A send whose terminal CAS lost
 * (`dispatch.ts` `commitSendTerminal`) never persists `provider_message_id` at
 * all, and is unattributable for the same reason.
 *
 * `accountId: null` is FORCED, not chosen. The fallback has no account context,
 * and the purge contract requires exactly this: a global row written after the
 * purge boundary must not re-introduce the account provenance the purge just
 * removed.
 *
 * THIS REPLACES A 503-AND-RETRY, and the trade was made deliberately (owner
 * decision, #967). The retry recovered a seconds-wide race — the window where
 * #630 has committed the send but not yet its `provider_message_id`. In that
 * race the ledger row is still correct, but the outreach `bounced_at` /
 * `complained_at` stamp is now lost, so the **Send breaker** undercounts one
 * bounce. Accepted: the opt-out is irreversible and the stamp is not. Acking
 * also lands the event at `status='processed'`, which is what brings the stored
 * raw payload under `ArchivalPoller`'s existing 30-day sweep — a `failed` row
 * is never swept, so the old path retained a recipient address forever.
 *
 * WARN, not log: a sustained rate here means outreach rows are disappearing
 * under live sends, which is #965's still-unexplained loss.
 */
async function suppressWithoutAttribution(
  tx: TransactionSql,
  emailId: string,
  event: string,
  data: unknown,
  source: SuppressionSourceToRecord,
): Promise<void> {
  const handle = extractSoleRecipient(data, emailId, event);
  const written = await recordSuppression(tx, {
    scope: 'global',
    channel: 'email',
    normalizedHandle: handle,
    accountId: null,
    source,
  });

  logger.warn({
    msg: 'solicitation webhook matched no outreach row — global opt-out written from the signed payload',
    event,
    provider_message_id: emailId,
    source,
    // Never the handle. `false` means an equal-or-earlier opt-out already won
    // first-write-wins, which is the ledger agreeing with itself.
    ledger_row_written: written !== null,
  });
}

export async function handleSolicitationResendEvent(
  sql: Sql,
  eventType: string,
  emailId: string,
  data: Record<string, unknown>,
): Promise<void> {
  switch (eventType) {
    case 'email.bounced':
      return recordBounce(sql, emailId, data);
    case 'email.complained':
      return recordComplaint(sql, emailId, data);
    case 'email.suppressed':
      return recordProviderSuppressed(sql, emailId, data);
    case 'email.failed':
      return recordFailure(sql, emailId, data);
    case 'email.sent':
    case 'email.delivered':
    case 'email.delivery_delayed':
      // Observability only. #630 owns delivery_status and sent_at; there is no
      // delivered_at column; delivery_delayed NEVER suppresses.
      logger.log({ msg: 'solicitation webhook observed', event: eventType, provider_message_id: emailId });
      return;
    default:
      // Refused, not crashed on: opened/clicked/scheduled/received (§5.3).
      logger.warn({ msg: 'solicitation webhook refused unsupported event', event: eventType });
      return;
  }
}

/**
 * Every signal write runs through here so the transaction boundary has ONE owner:
 * attribution, its FOR UPDATE lock, the outreach UPDATE and the optional ledger
 * write are one commit or none.
 *
 * `onMissing` decides what an unmatched id means for THIS event.
 * `apply` returns the ledger source to record, or null to record none.
 *
 * RETURNS a Committed value only on a COMMITTED write, and null when the id was
 * unmatched. That return value is what makes post-commit logging possible.
 *
 * The value flows out as the callback's RETURN, never through a closure variable.
 * A `let committed` assigned only inside the callback does not build: TypeScript's
 * control-flow analysis cannot see that the callback ran, narrows the variable to
 * `null` after the await, and then narrows the guarded branch to `never`.
 *
 * `suppressionWritten` distinguishes "we wrote a ledger row" from
 * "recordSuppression first-write-wins no-op'd because one already existed". Only
 * one caller needs it, and it needs it badly — see recordProviderSuppressed.
 */
interface Committed {
  attribution: OutreachAttribution;
  suppressionWritten: boolean;
}

/**
 * The three ledger sources this lane can write, BOUND to the canonical union
 * rather than re-spelled. `src/lib/solicitation/suppression.ts` is the single
 * owner of the vocabulary (CONTEXT.md: "never string literals at call sites"), so
 * `Extract` makes a change to that union surface here instead of silently
 * leaving a second, unowned enumeration behind.
 */
type SuppressionSourceToRecord = Extract<
  SuppressionSource,
  'bounce_permanent' | 'complaint' | 'provider_suppressed'
>;

async function withAttribution(
  sql: Sql,
  emailId: string,
  event: string,
  data: unknown,
  unmatched: UnmatchedPolicy,
  apply: (
    tx: TransactionSql,
    attribution: OutreachAttribution,
  ) => Promise<SuppressionSourceToRecord | null>,
): Promise<Committed | null> {
  // postgres.js resolves sql.begin with the callback's return value. The callback's
  // return type is annotated explicitly because UnwrapPromiseArray makes the
  // inference awkward — annotate, never cast.
  return await sql.begin(async (tx): Promise<Committed | null> => {
    const attribution = await loadAttribution(tx, emailId);
    if (!attribution) {
      // `null` still means "no attribution; the policy has already handled it"
      // — warned, or written the global row from the payload (#967). Only a
      // malformed payload throws now, rolling this back into a 503.
      if (unmatched.kind === 'ignore') warnUnmatched(emailId, event);
      else await suppressWithoutAttribution(tx, emailId, event, data, unmatched.source);
      return null;
    }

    const source = await apply(tx, attribution);
    if (!source) return { attribution, suppressionWritten: false };

    // Returns the new row id, or null when an existing row won (first-write-wins).
    const written = await recordSuppression(tx, {
      scope: 'global',
      channel: 'email',
      normalizedHandle: attribution.normalized_handle,
      accountId: attribution.account_id,
      source,
    });

    return { attribution, suppressionWritten: written !== null };
  });
}

/**
 * The UPDATE must hit the row the lock protects. Zero rows is a bug, not a no-op.
 *
 * SYNCHRONOUS on purpose. Declared `async`, a call site that forgot the `await`
 * would turn this hard assertion — which runs inside `sql.begin` — into an
 * unhandled rejection, letting the transaction commit the very state it exists to
 * forbid. A synchronous throw cannot be missed that way.
 */
function assertUpdatedOne(count: number, outreachId: string): void {
  if (count !== 1) {
    throw new Error(`expected to update exactly 1 outreach row, updated ${count}: ${outreachId}`);
  }
}

/**
 * The soft bounce types this codebase actually RECOGNISES.
 *
 * NOT a second owner of "what counts as permanent" — `classifyBounce` keeps
 * that, and no hard form is ever a member here. This set answers a different
 * question, one only #898 made load-bearing: did the provider hand us a type we
 * understand *at all*?
 *
 * `classifyBounce` answers "hard?", and defaults an unrecognised or missing type
 * to soft deliberately, so an ambiguous payload cannot flag a business
 * (`bounce-classifier.ts`). That default is fail-SAFE for flagging and
 * fail-OPEN for the **Send breaker**, whose numerator filters on
 * `bounce_kind = 'hard'`: a Resend payload-shape change — or a new permanent
 * type whose name does not contain "permanent" — would stamp every bounce
 * `soft`, and the breaker would never trip however bad deliverability got. Two
 * questions, two answers; only a recognised type earns a stored kind.
 */
const RECOGNISED_SOFT_BOUNCE_TYPES = new Set([
  'transient',
  'soft',
  'softbounce',
  'soft_bounce',
  'temporary',
  'temporary_failure',
]);

/**
 * `hard` | `soft` | NULL — the **Send breaker**'s discriminator (#898).
 *
 * NULL means "we could not classify this", never "not a hard bounce". 110's
 * `bounce_kind_pairing` CHECK admits `bounced_at` set with `bounce_kind` NULL
 * precisely so that state is representable, and the breaker counts
 * `bounced_at IS NOT NULL AND bounce_kind IS NULL` WITH the hard bounces — the
 * fail-CLOSED direction on a governor specified to fail closed. An unrecognised
 * type therefore makes the breaker trip sooner, never later.
 *
 * Suppression is UNCHANGED: `isHard` still decides the ledger write and the
 * unmatched-attribution split, so an ambiguous bounce still never suppresses a
 * real customer. Only the stored kind moves.
 */
function resolveBounceKind(rawType: string, isHard: boolean): 'hard' | 'soft' | null {
  if (isHard) return 'hard';
  if (RECOGNISED_SOFT_BOUNCE_TYPES.has(rawType)) return 'soft';
  // Mirrors the classifier's `.includes('permanent')` arm on the other side:
  // provider vocabularies prefix and suffix these words (smtp_transient_failure).
  if (rawType.includes('transient') || rawType.includes('temporary')) return 'soft';
  return null;
}

async function recordBounce(sql: Sql, emailId: string, data: unknown): Promise<void> {
  // Classified from the PAYLOAD, before any lookup — so we know whether this event
  // is suppression-bearing and therefore whether an unmatched id may be acked.
  const rawType = extractBounceType(data);
  const { reason, isHard } = classifyBounce(rawType);
  const bounceKind = resolveBounceKind(rawType, isHard);

  const committed = await withAttribution(
    sql,
    emailId,
    'email.bounced',
    data,
    // A soft or unrecognised bounce NEVER suppresses (§3.2), so an unmatched
    // one stays warn-and-ack; only the permanent arm reaches the ledger.
    isHard ? { kind: 'suppress', source: 'bounce_permanent' } : { kind: 'ignore' },
    async (tx, attribution) => {
      const updated = await tx`
        UPDATE solicitation_outreach
           SET bounced_at = COALESCE(bounced_at, NOW()),
               -- The breaker's discriminator (#898). COALESCE for the same
               -- reason bounced_at does: a redelivered webhook must not
               -- reclassify a bounce we already recorded. Paired with
               -- bounced_at by 110's bounce_kind_pairing CHECK, so it is set
               -- in the SAME statement or the row is rejected. NULL when the
               -- provider type is unrecognised — see resolveBounceKind; the
               -- COALESCE then leaves the column exactly as it was.
               bounce_kind = COALESCE(bounce_kind, ${bounceKind}),
               provider_error = COALESCE(provider_error, ${reason}),
               updated_at = NOW()
         WHERE id = ${attribution.id}
      `;
      assertUpdatedOne(updated.count, attribution.id);
      // Permanent only. Soft and 'unknown' record the fact and never suppress.
      return isHard ? 'bounce_permanent' : null;
    },
  );

  if (!committed) return; // unmatched — onMissing already warned or threw
  logger.log({
    msg: 'solicitation bounce recorded',
    outreach_id: committed.attribution.id,
    account_id: committed.attribution.account_id,
    business_id: committed.attribution.business_id,
    // The KIND only — the one actually STORED, so a log line can never claim a
    // classification the breaker's numerator does not see. `reason` embeds
    // provider-controlled text that can carry a recipient address; it belongs in
    // provider_error (a column) not a log.
    bounce_kind: bounceKind ?? 'unrecognised',
  });
}

async function recordComplaint(sql: Sql, emailId: string, data: unknown): Promise<void> {
  const committed = await withAttribution(
    sql,
    emailId,
    'email.complained',
    data,
    { kind: 'suppress', source: 'complaint' },
    async (tx, attribution) => {
      const updated = await tx`
        UPDATE solicitation_outreach
           SET complained_at = COALESCE(complained_at, NOW()),
               updated_at = NOW()
         WHERE id = ${attribution.id}
      `;
      assertUpdatedOne(updated.count, attribution.id);
      return 'complaint';
    },
  );

  if (!committed) return;
  logger.log({
    msg: 'solicitation complaint recorded',
    outreach_id: committed.attribution.id,
    account_id: committed.attribution.account_id,
    business_id: committed.attribution.business_id,
  });
}

async function recordProviderSuppressed(sql: Sql, emailId: string, data: unknown): Promise<void> {
  // No Outreach column exists for this — the ledger IS the record.
  const committed = await withAttribution(
    sql,
    emailId,
    'email.suppressed',
    data,
    { kind: 'suppress', source: 'provider_suppressed' },
    async () => 'provider_suppressed',
  );

  if (!committed) return;

  // The loud warn is CONDITIONAL on having actually written a ledger row.
  //
  // §6.2's warning claims a specific fact: Resend's team-wide list has diverged
  // from ours. If recordSuppression first-write-wins no-op'd, this handle was
  // ALREADY suppressed here — the two lists AGREE, and that is precisely the case
  // where the divergence claim is false. Warning anyway pages an admin about the
  // healthy state and trains them to ignore the signal.
  if (!committed.suppressionWritten) {
    logger.log({
      msg: 'Resend suppressed a solicitation recipient we had already suppressed — lists agree',
      outreach_id: committed.attribution.id,
      account_id: committed.attribution.account_id,
      business_id: committed.attribution.business_id,
    });
    return;
  }

  // Loud by design (§6.2): Resend's suppression list is team-wide across every
  // domain and API key INCLUDING transactional, so a real divergence between their
  // list and ours is an admin-attention condition, not routine traffic.
  logger.warn({
    msg: 'Resend independently suppressed a solicitation recipient — team-wide list diverging from our ledger (§6.2)',
    outreach_id: committed.attribution.id,
    account_id: committed.attribution.account_id,
    business_id: committed.attribution.business_id,
  });
}

async function recordFailure(sql: Sql, emailId: string, data: unknown): Promise<void> {
  const reason = readFailureReason(data);

  // Send-side failure. NEVER suppresses, never touches bounced_at, and an unmatched
  // id is genuinely ack-able: nothing is lost that a later event cannot re-establish.
  const committed = await withAttribution(
    sql,
    emailId,
    'email.failed',
    data,
    { kind: 'ignore' },
    async (tx, attribution) => {
      const updated = await tx`
        UPDATE solicitation_outreach
           SET provider_error = COALESCE(provider_error, ${`failed:${reason}`}),
               updated_at = NOW()
         WHERE id = ${attribution.id}
      `;
      assertUpdatedOne(updated.count, attribution.id);
      return null;
    },
  );

  if (!committed) return;
  logger.log({
    msg: 'solicitation send failure recorded',
    outreach_id: committed.attribution.id,
    account_id: committed.attribution.account_id,
    business_id: committed.attribution.business_id,
    // Reason is provider-controlled text — stored, never logged.
    has_reason: reason !== 'unknown',
  });
}

function readFailureReason(data: unknown): string {
  if (!isRecord(data)) return 'unknown';
  const failed = data.failed;
  if (isRecord(failed) && typeof failed.reason === 'string' && failed.reason.length > 0) {
    return failed.reason.toLowerCase();
  }
  return 'unknown';
}
