'use client';

import { useRef, useState } from 'react';
import type { UseFormGetValues, UseFormSetValue, UseFormGetFieldState } from 'react-hook-form';
import type { FormData } from '../schema';

/**
 * Shape returned by GET /api/admin/businesses/prefill. Keep in sync with
 * the route handler's response.
 */
interface BusinessPrefillResponse {
  category: string | null;
  phone: string | null;
  website: string | null;
  hours: string | null;
  fullAddress: string | null;
}

/**
 * Encapsulates the SerpAPI prefill race-condition handling for the
 * "Onboard New Business" admin form.
 *
 * The form auto-fills `category`, `ownerPhone`, and `website` from
 * `/api/admin/businesses/prefill` after the user picks a place via
 * PlaceAutocomplete. The race we defend against:
 *
 *   - User selects Place A → prefill request A starts
 *   - User selects Place B before A resolves → prefill request B starts
 *   - Without guards, A's response can arrive after B and overwrite
 *     B's empty fields with stale Place A data.
 *
 * Defenses (in order of strength):
 *   1. Primary: `AbortController` cancels any in-flight request when a
 *      new one starts or the user clears/switches input mode.
 *   2. Secondary: a `latestPlaceIdRef` guard — even if a stale response
 *      somehow makes it past the abort, we discard responses whose
 *      placeId no longer matches the latest selection (checked twice:
 *      once after fetch headers and again after body parse).
 *   3. Tertiary: `getFieldState(name).isDirty` (live read at fill time,
 *      not snapshotted via destructured `dirtyFields`) — prevents
 *      overwriting a field the user typed into WHILE the request was
 *      in flight.
 */
export function useBusinessPrefill(args: {
  setValue: UseFormSetValue<FormData>;
  getValues: UseFormGetValues<FormData>;
  getFieldState: UseFormGetFieldState<FormData>;
}) {
  const { setValue, getValues, getFieldState } = args;
  const [prefilling, setPrefilling] = useState(false);
  // Guards against the stale-response race: user selects Place A, then quickly
  // selects Place B before A's request resolves. Without guards, A's response
  // can overwrite B's empty fields with A's data. We track the latest
  // AbortController so we can cancel in-flight requests, AND the latest
  // selected placeId so we can reject stale responses that somehow still arrive.
  const prefillAbortRef = useRef<AbortController | null>(null);
  const latestPlaceIdRef = useRef<string | null>(null);

  /**
   * Cancels any in-flight prefill and clears the "latest place" guard.
   * Called when the user:
   *   - clears the PlaceAutocomplete selection
   *   - switches from autocomplete mode to URL-paste mode
   * Without this, a Place A request that was launched before the clear/switch
   * can resolve AFTER the user abandoned that place and still auto-fill
   * stale data into empty fields.
   */
  function cancelPrefill() {
    latestPlaceIdRef.current = null;
    if (prefillAbortRef.current) {
      prefillAbortRef.current.abort();
      prefillAbortRef.current = null;
    }
    setPrefilling(false);
  }

  async function triggerPrefill(placeId: string) {
    // Cancel any in-flight request — this is the primary defense.
    if (prefillAbortRef.current) {
      prefillAbortRef.current.abort();
    }
    const controller = new AbortController();
    prefillAbortRef.current = controller;
    latestPlaceIdRef.current = placeId;

    setPrefilling(true);
    try {
      const res = await fetch(
        `/api/admin/businesses/prefill?place_id=${encodeURIComponent(placeId)}`,
        { signal: controller.signal },
      );
      // Secondary defense: if a newer selection happened, discard this response.
      if (latestPlaceIdRef.current !== placeId) return;
      if (!res.ok) return; // Silent failure — fields remain empty for manual entry
      const prefill = (await res.json()) as BusinessPrefillResponse;
      // Check AGAIN after awaiting body parse — the user could have selected
      // a different place between headers arriving and body parsing.
      if (latestPlaceIdRef.current !== placeId) return;

      // Only fill fields that are (1) currently empty AND (2) have never been
      // touched by the user. We use `getFieldState(name).isDirty` instead of
      // a destructured `dirtyFields` object because the destructured value is
      // captured at render time — the user could have typed (and cleared) a
      // field WHILE the prefill request was in flight, and a captured
      // `dirtyFields.category === false` snapshot would overwrite their work.
      // `getFieldState` reads the live form state at call time.
      const current = getValues();
      if (
        prefill.category &&
        !current.category &&
        !getFieldState('category').isDirty
      ) {
        setValue('category', prefill.category, { shouldDirty: false });
      }
      if (
        prefill.phone &&
        !current.ownerPhone &&
        !getFieldState('ownerPhone').isDirty
      ) {
        setValue('ownerPhone', prefill.phone, { shouldDirty: false });
      }
      if (
        prefill.website &&
        !current.website &&
        !getFieldState('website').isDirty
      ) {
        setValue('website', prefill.website, { shouldDirty: false });
      }
    } catch (err) {
      // AbortError is expected when the user quickly selects a different place.
      // Any other error (network, parse) silently degrades to manual entry.
      if (err instanceof DOMException && err.name === 'AbortError') return;
    } finally {
      // Only clear the UI spinner if this call is still the latest.
      // If a newer call is in flight, keep showing the spinner for it.
      if (prefillAbortRef.current === controller) {
        setPrefilling(false);
        prefillAbortRef.current = null;
      }
    }
  }

  return { prefilling, triggerPrefill, cancelPrefill };
}
