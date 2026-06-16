import { sql } from '../../../src/lib/db/server';
import { hasOpenFlag } from '../../../src/lib/moderation/held-draft';

/**
 * Belt-and-suspenders publish gate (F-5). Returns true when an OPEN moderation
 * flag exists for the response, meaning the publish path must NOT post it.
 *
 * Non-exploitable today: a high-severity moderation flag leaves the draft at
 * `pending_approval`, which the publishable-state gate already excludes, and
 * such a draft never gets a publish outbox row. This makes the moderation veto
 * binding on the publish path too (not just the owner UI), so a flagged row that
 * was somehow advanced to an approved status can never be posted to Google.
 *
 * Takes a FOR UPDATE lock on the (business-scoped) response row before the
 * hasOpenFlag check, per hasOpenFlag's documented contract. Note the lock topology:
 * the admin `requires_regeneration` disposition locks the response row too (so this
 * serializes against it), but the `approved_for_owner_review` / `dismissed_false_positive`
 * dispositions lock only the `flagged_responses` row — so against those, the
 * open-flag read is a last-committed-wins snapshot, NOT strictly serialized. That is
 * fine here: the failure mode is always fail-safe. If the read sees `open` we don't
 * post; once a flag is closed the draft is genuinely safe to post, and a flag is
 * never re-opened on an already-approved draft. The business-scope on the lock is
 * defense-in-depth (only act on a response belonging to this job's business).
 */
export async function isHeldForModerationReview(
  responseId: string,
  businessId: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`
      SELECT id FROM responses
      WHERE id = ${responseId}::uuid AND business_id = ${businessId}::uuid
      FOR UPDATE
    `;
    return hasOpenFlag(tx, responseId);
  });
}
