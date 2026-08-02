/**
 * Ask render: placeholders + footer assembly for solicitation ask bodies.
 *
 * The returned string is BYTE-FOR-BYTE what is stored on the render row and,
 * after approval, what sends — the byte-for-byte approval contract is over
 * these stored bytes (ask-generation design §5, map decision 4). The two
 * placeholder constants are the deterministic tokens #630 substitutes with
 * real URLs at dispatch time; substitution is mechanical and explicitly
 * excluded from the approval contract (send-mode cross-spec amendments,
 * AMEND B4).
 *
 * Footer content follows #622 (sender-deliverability design §7.2): sender
 * identification line, owner-attested postal address baked in VERBATIM
 * (§7.6 dispatch-time byte-match depends on it), and the unsubscribe line.
 * The review-link CTA line precedes the separator; the CAN-SPAM trio follows.
 *
 * Pure module: no DB, no clock, no IO — identical inputs produce identical
 * bytes (restraint-policy.ts pattern).
 */

/** Replaced by #630 at dispatch with the tokenized unsubscribe URL (AMEND B4). */
export const UNSUBSCRIBE_URL_PLACEHOLDER = '{{unsubscribe_url}}';

/** Replaced by #630 at dispatch with the business's Google review link (AMEND B4). */
export const REVIEW_LINK_PLACEHOLDER = '{{review_link}}';

// Footer byte facts, exported so lint class 7 (`missing_required_element`,
// ask-compliance-lint.ts) can assert the footer's presence against the SAME
// bytes this module emits — one authoritative owner of the footer shape.

/** The line separating the ask copy from the CAN-SPAM footer trio. */
export const FOOTER_SEPARATOR = '---';

/** Prefix of the sender-identification line (#622 §7.2 block 1). */
export const SENDER_IDENTIFICATION_PREFIX = 'Sent by RepWorth on behalf of ';

/** Prefix of the unsubscribe line (#622 §7.2 block 3). */
export const UNSUBSCRIBE_LINE_PREFIX = 'Unsubscribe: ';

export interface AskFooterInput {
  businessName: string;
  /** Owner-attested `businesses.solicitation_postal_address` (#627); null until attested. */
  postalAddress: string | null;
}

/**
 * Append the compliance footer to an LLM-generated ask body.
 *
 * Returns null when postalAddress is missing or blank (whitespace-only counts
 * as missing) — the caller withholds with `missing_required_element`: render
 * fails closed without a postal address, never a blank, partial, or
 * placeholder footer (#622 §7.6). The postal address is otherwise baked in
 * verbatim — untrimmed — so the dispatch-time byte-match against the column
 * holds. Only the LLM body's surrounding whitespace is normalized, keeping
 * footer spacing canonical regardless of the model's trailing newlines.
 */
export function assembleAskBody(llmBody: string, footer: AskFooterInput): string | null {
  if (footer.postalAddress === null || footer.postalAddress.trim().length === 0) {
    return null;
  }

  return [
    llmBody.trim(),
    '',
    `Leave a review: ${REVIEW_LINK_PLACEHOLDER}`,
    '',
    FOOTER_SEPARATOR,
    '',
    `${SENDER_IDENTIFICATION_PREFIX}${footer.businessName}.`,
    footer.postalAddress,
    `${UNSUBSCRIBE_LINE_PREFIX}${UNSUBSCRIBE_URL_PLACEHOLDER}`,
  ].join('\n');
}
