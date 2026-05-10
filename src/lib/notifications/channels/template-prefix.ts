// src/lib/notifications/channels/template-prefix.ts
//
// Sanitization for location labels used in notification template prefixes.
// The prefix format is [{locationLabel}] — when the label itself contains
// brackets, colons, or is very long, the template can break or become
// visually ambiguous.
//
// VAL-NOTIF-019: Template prefix escapes or safely handles brackets,
//   colons, and long display_labels.

/** Maximum length for a location label inside a bracket prefix. */
const MAX_LABEL_LENGTH = 30;

/**
 * Sanitizes a location label for safe use inside a bracket-enclosed prefix.
 *
 * Rules:
 * 1. Replace `[` with `(` and `]` with `)` to prevent bracket nesting
 *    ambiguity (e.g. "[Downtown [Main]]" → "[Downtown (Main)]").
 * 2. Truncate to 30 characters with ellipsis if longer (prevents SMS
 *    segment overflow and overly long Telegram/email subjects).
 * 3. Colons are preserved — they don't break the template structure.
 *
 * @param label - The resolved location label (display_label ?? name).
 * @returns Sanitized label safe for use in `[{label}]` prefix.
 */
export function sanitizeLocationLabelForPrefix(label: string): string {
  if (!label) return label;

  // Step 1: Replace brackets with parentheses
  let sanitized = label.replace(/\[/g, '(').replace(/\]/g, ')');

  // Step 2: Truncate to MAX_LABEL_LENGTH
  if (sanitized.length > MAX_LABEL_LENGTH) {
    sanitized = sanitized.slice(0, MAX_LABEL_LENGTH - 1) + '…';
  }

  return sanitized;
}
