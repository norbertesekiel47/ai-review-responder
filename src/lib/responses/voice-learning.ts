import type { Sql } from 'postgres';
import type { VoiceExample } from './types';

const MIN_EXAMPLES_FOR_ACTIVATION = 5;

/**
 * Fetches recent owner-edited responses as few-shot voice examples.
 *
 * Returns [] until the business has at least 5 posted responses where
 * the owner made edits. This prevents low-quality prompts from
 * insufficient data — the hook activates naturally as customers use
 * the product.
 *
 * Uses the idx_responses_voice partial index:
 *   WHERE status = 'posted' AND edited_text IS NOT NULL
 */
export async function getApprovedResponsePairs(
  sql: Sql,
  businessId: string,
): Promise<VoiceExample[]> {
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

  // Not enough edited responses yet — voice learning hasn't activated
  if (rows.length < MIN_EXAMPLES_FOR_ACTIVATION) {
    return [];
  }

  // Return at most 5 examples for the prompt
  return rows.slice(0, 5).map((row) => ({
    originalDraft: row.original_draft_text,
    editedVersion: row.edited_text,
    reviewStarRating: row.star_rating,
  }));
}
