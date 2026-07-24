import type { Sql } from 'postgres';
import type { VoiceExample } from './types';

const MIN_EXAMPLES_FOR_ACTIVATION = 5;

export interface VoiceCorpusStatus {
  /** Posted, owner-edited replies visible in the LIMIT-10 corpus window. */
  editedCount: number;
  /** [] below activation; else exactly the 5 most-recent pairs the prompt path uses. */
  examples: VoiceExample[];
}

/**
 * Single owner of voice-corpus selection semantics.
 *
 * Returns the activation count plus the exact few-shot pairs the prompt
 * path consumes. examples stays [] until the business has at least 5
 * posted responses where the owner made edits — the voice hook activates
 * naturally as customers use the product.
 *
 * Uses the idx_responses_voice partial index:
 *   WHERE status = 'posted' AND edited_text IS NOT NULL
 */
export async function getVoiceCorpusStatus(
  sql: Sql,
  businessId: string,
): Promise<VoiceCorpusStatus> {
  const rows = await sql<{
    original_draft_text: string;
    edited_text: string;
    star_rating: number;
  }[]>`
    SELECT resp.original_draft_text, resp.edited_text, r.star_rating
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.business_id = ${businessId}
      AND resp.status = 'posted'
      AND resp.edited_text IS NOT NULL
    ORDER BY resp.posted_at DESC
    LIMIT 10
  `;

  if (rows.length < MIN_EXAMPLES_FOR_ACTIVATION) {
    return { editedCount: rows.length, examples: [] };
  }

  return {
    editedCount: rows.length,
    examples: rows.slice(0, 5).map((row) => ({
      originalDraft: row.original_draft_text,
      editedVersion: row.edited_text,
      reviewStarRating: row.star_rating,
    })),
  };
}

/** Few-shot voice examples for the prompt path. Delegates to getVoiceCorpusStatus. */
export async function getApprovedResponsePairs(
  sql: Sql,
  businessId: string,
): Promise<VoiceExample[]> {
  return (await getVoiceCorpusStatus(sql, businessId)).examples;
}
