import type { Fragment, Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
// NOT @/lib/analytics/events — that module owns the event-NAME allowlist, not
// the writer.
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';

/**
 * The Suppression ledger's domain core (#643; locked spec
 * docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §1–§3).
 *
 * Sole owner of three facts, so no call site re-derives them:
 *  1. The closed source/Suppression scope/channel enums (§3.1).
 *  2. The §1.2 lookup predicate — `global` OR this account's `account` row,
 *     global winning a double match (#643 grilling G3).
 *  3. The first-write-wins writer and its byte-for-byte ON CONFLICT predicates.
 *
 * DR2 — this ledger is solicitation-only. Transactional and notification email
 * must NEVER consult it: an owner who opted out as somebody else's customer
 * must still receive approval emails, or invariant #3 is reached sideways.
 */

type SqlExecutor = Sql | TransactionSql;

// Order is §3.1's table order, verbatim — the unit test asserts it.
export const SUPPRESSION_SOURCES = [
  'unsubscribe_one_click',
  'unsubscribe_link',
  'bounce_permanent',
  'complaint',
  'provider_suppressed',
  'admin_manual',
  'owner_manual',
] as const;
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];

export const SUPPRESSION_SCOPES = ['global', 'account'] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

export const SUPPRESSION_CHANNELS = ['email'] as const;
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number];

/**
 * §1.2's lookup, as a composable SQL fragment (the primaryTrackedKeywordSql
 * precedent) rather than a function that owns its own round trip. The batch
 * build embeds it in loadCandidateWindow's LATERAL join today; #630's dispatch
 * gate embeds the same fragment later. One owner of the predicate.
 *
 * `handleColumn` is a fragment naming the already-normalized handle column in
 * the OUTER query (e.g. sql`c.email`) — solicitation_contacts.email already
 * stores the output of normalizeEmail, so there is no re-normalization here.
 *
 * Global wins a double match (G3): reporting the account row would let an owner
 * clear it under §7.6, watch the contact stay suppressed, and have no idea why.
 *
 * Returns at most one row of { source, suppressed_at }, or none — an existence
 * check, never a comparison against suppressed_at (§2.1), which sidesteps the
 * postgres.js microsecond-truncation class entirely.
 *
 * `channel` is a PARAMETER rather than the literal 'email' this fragment used to
 * hardcode, because `recordSuppression` has always taken one: with the reader
 * pinned and the writer open, the day SUPPRESSION_CHANNELS gains a member the
 * writer would mint rows this lookup could never see, and an opt-out that the
 * ledger holds but the gate cannot find fails OPEN — the recipient gets
 * contacted. One owner for the channel dimension, on both sides. (#643 step-7
 * review.)
 */
export function suppressionMatchSql(
  db: SqlExecutor,
  handleColumn: Fragment,
  accountId: string,
  channel: SuppressionChannel,
) {
  return db`
    SELECT s.source, s.suppressed_at
    FROM solicitation_suppressions s
    WHERE s.channel = ${channel}
      AND s.normalized_handle = ${handleColumn}
      AND (
        s.scope = 'global'
        OR (s.scope = 'account' AND s.account_id = ${accountId}::uuid)
      )
    ORDER BY (s.scope = 'global') DESC, s.suppressed_at ASC
    LIMIT 1
  `;
}

/**
 * A discriminated union, not a bag of independent fields (G11). The DB CHECK is
 * the last line of defence; this makes the illegal combination unrepresentable
 * at the call site, so `owner_manual` + `global` cannot even be typed.
 */
export type RecordSuppressionInput =
  | {
      // G14: admin_manual is its own variant because §7.3 REQUIRES an actor and
      // a note; folding it in with the machine sources let a global row omit
      // both. NOTE the limit of what this proves: the actor is a plain string,
      // so the type CANNOT establish that it is an admin rather than an owner —
      // #645's caller owns that authorization. That gap is precisely why the
      // purge verifier's global owner-actor branch stays live.
      scope: 'global';
      channel: SuppressionChannel;
      normalizedHandle: string;
      accountId: string | null;
      source: 'admin_manual';
      createdByUserId: string;
      note: string;
    }
  | {
      // Machine-authored: no human actor exists, so `?: never` makes claiming
      // one a type error rather than a silently-accepted field.
      scope: 'global';
      channel: SuppressionChannel;
      normalizedHandle: string;
      /** Provenance only — which account's send produced this. Retained through purge (§6.3). */
      accountId: string | null;
      source: Exclude<SuppressionSource, 'owner_manual' | 'admin_manual'>;
      createdByUserId?: never;
      note?: never;
    }
  | {
      scope: 'account';
      channel: SuppressionChannel;
      normalizedHandle: string;
      /** The Suppression scope itself, not provenance — non-null by construction (§1.2). */
      accountId: string;
      source: 'owner_manual';
      createdByUserId: string;
      note?: string | null;
    };

/**
 * First-write-wins (§2.1). A complaint arriving after an unsubscribe does NOT
 * overwrite the earlier row — the state is already correct, and the history
 * lives where it belongs (the provider webhook records, and the audit trail for
 * manual entries). A second row would add nothing and would break the
 * uniqueness that makes the §1.2 lookup a plain equality.
 *
 * The ON CONFLICT predicates re-spell each partial index BYTE-FOR-BYTE. They
 * cannot be parameterized or collapsed — a mismatch means Postgres silently
 * fails to infer the constraint and the INSERT throws instead of no-op'ing.
 *
 * Returns the row id when a row was written, or null when an existing row won.
 * The §9.4 analytics event is a durable insert in the SAME transaction (§9.3 —
 * there is no follow-up work, so there is deliberately NO job_outbox row), and
 * is skipped entirely on the no-op path so a repeat never double-mints.
 *
 * Properties NEVER include the Normalized handle (§9.4/§9.5).
 */
// G6: this is the single owner of the byte-for-byte ON CONFLICT predicates for
// both partial unique indexes. It ships ahead of its production callers (#644
// redemption, #645 manual paths, #627 webhook sources) so the predicates are
// proven against the real indexes the moment they are created, not three
// tickets later. Its consumer today is suppression.integration.test.ts.
export async function recordSuppression(
  tx: TransactionSql,
  input: RecordSuppressionInput,
): Promise<string | null> {
  const id = uuidv7();

  const written =
    input.scope === 'global'
      ? await tx<{ id: string }[]>`
          INSERT INTO solicitation_suppressions
            (id, channel, normalized_handle, scope, account_id, source,
             created_by_user_id, note)
          VALUES
            (${id}, ${input.channel}, ${input.normalizedHandle}, 'global',
             ${input.accountId}, ${input.source},
             ${input.createdByUserId ?? null}, ${input.note ?? null})
          ON CONFLICT (channel, normalized_handle) WHERE scope = 'global'
          DO NOTHING
          RETURNING id
        `
      : await tx<{ id: string }[]>`
          INSERT INTO solicitation_suppressions
            (id, channel, normalized_handle, scope, account_id, source,
             created_by_user_id, note)
          VALUES
            (${id}, ${input.channel}, ${input.normalizedHandle}, 'account',
             ${input.accountId}, ${input.source},
             ${input.createdByUserId ?? null}, ${input.note ?? null})
          ON CONFLICT (channel, normalized_handle, account_id) WHERE scope = 'account'
          DO NOTHING
          RETURNING id
        `;

  const row = written[0];
  if (row === undefined) return null;

  await enqueueAnalyticsEvent(tx, {
    eventName: 'solicitation_suppressed',
    eventKey: `solicitation_suppressed_${row.id}`,
    distinctId: input.accountId ?? row.id,
    accountId: input.accountId,
    properties: {
      source: input.source,
      scope: input.scope,
      channel: input.channel,
    },
  });

  return row.id;
}
