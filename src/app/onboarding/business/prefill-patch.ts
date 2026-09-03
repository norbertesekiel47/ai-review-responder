import type { WizardFormData } from './BusinessWizardClient';
import {
  matchSubcategory,
  type BusinessSubcategory,
} from '@/lib/shared/business-categories';

/**
 * The Google Maps prefill rule for the wizard's Profile fields, as a pure
 * function.
 *
 * Extracted from `StepLocation.triggerPrefill` (#1093), which was already the
 * densest function in the funnel and breached the complexity gate once the
 * category vocabulary landed. Pulling it out is not only budget relief: this
 * rule is the most breakable thing in the step, and as a closure inside an
 * async fetch handler it could only ever be tested through the component.
 *
 * ## The three modes, per field
 *
 * - **(a) present + first pick** (`data.X` empty) → set it.
 * - **(b) present + re-pick of a DIFFERENT place** (differs from the last
 *   prefill) → overwrite.
 * - **(c) EXPLICITLY absent + the previous prefill DID set the field** → clear
 *   it. Without (c), picking place A (category 'Cafes & Coffee Shops') then
 *   place B (no category) leaves the form showing A's answer while claiming to
 *   describe B — stale data masquerading as the new place's.
 *
 * The dirty flag wins in all three: a value the owner typed or chose is never
 * overwritten and never cleared.
 *
 * ## Why the category is normalized before it arrives
 *
 * Category is a closed 92-item vocabulary. SerpAPI answers free text
 * ('Mexican restaurant'), so a non-matching value is not "a category we could
 * show but chose not to" — it is **absent**, and therefore mode (c). Owner
 * decision 2026-09-03: drop it, do not pre-select a guess.
 */
export interface PrefillPatchInput {
  /** Raw prefill response. `category` is normalized here, not by the caller. */
  prefill: { category: string | null; website: string | null };
  /** Current form values for the two prefillable fields. */
  data: { category: string; website: string };
  /** Which of the two the owner has edited. */
  dirty: { category: boolean; website: boolean } | null;
  /** What the PREVIOUS prefill offered — category already normalized. */
  lastPrefill: { category: BusinessSubcategory | null; website: string | null };
}

export interface PrefillPatchResult {
  /** Fields to write. Empty when nothing changes. */
  patch: Partial<WizardFormData>;
  /**
   * The snapshot to store for the next comparison. Always returned, even when
   * `patch` is empty, so a re-pick compares against the latest known prefill.
   * It is the PREFILL's values, not the patch's: `data.X` may have been kept by
   * the dirty flag, but the prefill still represents what THIS place offered.
   */
  nextLastPrefill: { category: BusinessSubcategory | null; website: string | null };
}

/** One field's three modes. `null` means "leave this field alone". */
function resolveField(
  offered: string | null,
  current: string,
  lastOffered: string | null,
  isDirty: boolean,
): string | null {
  if (isDirty) return null;
  if (offered && (!current || offered !== lastOffered)) return offered;
  // Empty string, not null/undefined: `WizardFormData` holds strings, and a
  // controlled input warns on a null value.
  if (offered === null && lastOffered !== null && current) return '';
  return null;
}

export function computePrefillPatch(input: PrefillPatchInput): PrefillPatchResult {
  const { prefill, data, dirty, lastPrefill } = input;
  const offeredCategory = matchSubcategory(prefill.category);

  const patch: Partial<WizardFormData> = {};

  const category = resolveField(
    offeredCategory,
    data.category,
    lastPrefill.category,
    dirty?.category === true,
  );
  if (category !== null) patch.category = category;

  const website = resolveField(
    prefill.website,
    data.website,
    lastPrefill.website,
    dirty?.website === true,
  );
  if (website !== null) patch.website = website;

  return {
    patch,
    nextLastPrefill: { category: offeredCategory, website: prefill.website },
  };
}
