// src/hooks/settings-form-patch.ts
//
// The dirty-field vocabulary shared by the two settings form hooks —
// `useSettingsForm` (the account settings page) and `useLocationVoiceForm` (the
// per-location Voice tab). Both spelled the same four voice-field comparisons
// and the same key-by-key dirty count; this module is the one owner of both.
//
// Deliberately a small module rather than one hook importing the other:
// `useSettingsForm` has five importers and `useLocationVoiceForm` one, so a
// hook-to-hook import would pull the whole per-location fetch/save machine into
// every account-settings page for two pure functions.
//
// Not a hook (no `use` prefix, no React import): pure functions over form
// snapshots, which is what makes them table-testable outside a render.

/** The four voice fields both settings forms edit. */
export interface VoiceFormFields {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

/** Trim each line and drop the blank ones — how both hooks persist list fields. */
function normalizeLines(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const trimmed = line.trim();
    return trimmed ? [trimmed] : [];
  });
}

/**
 * The changed voice fields, as a PUT patch body. Returns a possibly-empty
 * object so a caller with extra fields (useSettingsForm's phone + digest
 * toggles) can add to it before deciding whether anything changed at all —
 * see `patchOrNull`.
 *
 * Empty-string semantics are load-bearing and preserved verbatim: `tone` sends
 * `''` as-is, `productsServices` sends `null` when cleared.
 */
export function buildVoiceFieldsPatch(
  initial: VoiceFormFields,
  current: VoiceFormFields,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (current.tone !== initial.tone) patch.tone = current.tone;
  if (current.productsServices !== initial.productsServices) {
    patch.productsServices = current.productsServices || null;
  }
  if (JSON.stringify(current.avoidFacts) !== JSON.stringify(initial.avoidFacts)) {
    patch.avoidFacts = normalizeLines(current.avoidFacts);
  }
  if (JSON.stringify(current.sampleResponses) !== JSON.stringify(initial.sampleResponses)) {
    patch.sampleResponses = normalizeLines(current.sampleResponses);
  }
  return patch;
}

/** `null` for "nothing changed" — the signal both hooks use to skip the PUT. */
export function patchOrNull(
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * How many of `current`'s fields differ from `initial` — the number the save bar
 * shows. Keyed off `current`'s own keys (not `initial`'s), matching what both
 * hooks did before, and compared by JSON so array fields count as one field.
 */
export function countDirtyFields<T extends object>(initial: T, current: T): number {
  let dirty = 0;
  for (const key of Object.keys(current) as (keyof T)[]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(initial[key])) dirty++;
  }
  return dirty;
}
