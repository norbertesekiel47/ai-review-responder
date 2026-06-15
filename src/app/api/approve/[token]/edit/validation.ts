import { z } from 'zod';
import { sanitizePublicResponseText } from '@/lib/shared/sanitize';

export const MAX_EDIT_LENGTH = 2000;

const editSchema = z.object({
  editedText: z
    .string('editedText is required')
    // .max runs on the RAW string (before sanitize) — reject oversize input up front.
    .max(MAX_EDIT_LENGTH, `editedText exceeds ${MAX_EDIT_LENGTH} characters`)
    .transform((value) => sanitizePublicResponseText(value))
    .refine((value) => value.length > 0, 'editedText is required'),
});

export type ApproveEditResult =
  | { ok: true; editedText: string }
  | { ok: false; error: string };

export function validateApproveEdit(body: unknown): ApproveEditResult {
  const parsed = editSchema.safeParse(body);
  if (!parsed.success) {
    // Surface the editedText field message; fall back to the legacy required
    // message for root-level type errors (body is null / array / bare string).
    const fieldIssue = parsed.error.issues.find((issue) => issue.path[0] === 'editedText');
    return { ok: false, error: fieldIssue?.message ?? 'editedText is required' };
  }
  return { ok: true, editedText: parsed.data.editedText };
}
