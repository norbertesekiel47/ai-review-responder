// Bidi overrides/isolates, zero-width chars, and BOM that can spoof how text
// renders in dashboards/CSV/PDF. Preserves U+200C/U+200D (emoji shaping/joins).
const FORMATTING_CONTROL_RE = /[\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * Sanitizes user-supplied text before it reaches the LLM prompt.
 *
 * Strips:
 * - Null bytes (\x00)
 * - ASCII control characters U+0000\u2013U+001F EXCEPT \n (0x0A), \r (0x0D), \t (0x09)
 * - DEL and C1 control characters U+007F\u2013U+009F
 *
 * Then collapses runs of whitespace to a single space and trims.
 */
export function sanitizeText(input: string): string {
  return input
    // Strip null bytes
    .replace(/\0/g, '')
    // Strip ASCII control chars except \t \n \r
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '')
    // Strip DEL + C1 control block
    .replace(/[\x7F-\x9F]/g, '')
    // Collapse any run of whitespace (space, tab, newline, etc.) into a single space
    .replace(/\s+/g, ' ')
    // Trim leading/trailing
    .trim();
}

/**
 * Sanitizes a reviewer display name at the ingestion boundary. Names are never
 * multi-line: drop bidi/zero-width format chars, then strip controls + collapse
 * whitespace via sanitizeText.
 */
export function sanitizeReviewerName(input: string): string {
  return sanitizeText(input.replace(FORMATTING_CONTROL_RE, ''));
}

/**
 * Sanitizes multi-line human-authored text (owner responses, review bodies)
 * before persistence/rendering. Preserves intentional line + paragraph breaks
 * while stripping non-printing controls and render-spoofing format chars.
 */
export function sanitizeMultilineText(input: string): string {
  return input
    // Normalize line endings before stripping the remaining controls.
    .replace(/\r\n?/g, '\n')
    // Normalize Unicode line/paragraph separators into ordinary LF breaks.
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n\n')
    // Strip ASCII control chars except tab and line feed; tabs become spaces below.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Strip C1 controls.
    .replace(/[\x80-\x9F]/g, '')
    // Strip common zero-width, bidi formatting/isolate controls, and BOM.
    // Preserve U+200C/U+200D because they affect visible shaping and emoji joins.
    .replace(FORMATTING_CONTROL_RE, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    // Keep at most one blank line between paragraphs.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Sanitizes owner-edited public response text before persistence.
 *
 * Unlike sanitizeText(), this preserves intentional line and paragraph breaks
 * for customer-visible replies while removing non-printing controls.
 */
export function sanitizePublicResponseText(input: string): string {
  return sanitizeMultilineText(input);
}
