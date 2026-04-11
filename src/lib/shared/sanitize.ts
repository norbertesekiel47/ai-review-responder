/**
 * Sanitizes user-supplied text before it reaches the LLM prompt.
 *
 * Strips:
 * - Null bytes (\x00)
 * - ASCII control characters U+0000–U+001F EXCEPT \n (0x0A), \r (0x0D), \t (0x09)
 * - DEL and C1 control characters U+007F–U+009F
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
