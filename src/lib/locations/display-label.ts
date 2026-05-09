// src/lib/locations/display-label.ts
//
// Central helper for resolving the display label of a location.
// Every surface that shows a location name (switcher, notifications,
// approval chips, dashboard) must use `getDisplayLabel()` — never read
// `display_label` directly with an inline fallback.
//
// Canonical fallback: display_label ?? name
// VAL-DASH-004: display_label with name fallback is the canonical behavior.
//
// NOTE: This module is client-safe (no Node.js-only imports).
// The server-side updateDisplayLabel function lives in
// ./update-display-label.ts to avoid bundling postgres into client code.

// ── Interface for rows that have display_label and name ──────────────────

export interface HasDisplayLabel {
  display_label: string | null;
  name: string;
}

export interface HasDisplayLabelCamelCase {
  displayLabel: string | null;
  name: string;
}

// ── getDisplayLabel ──────────────────────────────────────────────────────

/**
 * Returns the display label for a location, falling back to `name` when
 * `display_label` is NULL. This is the canonical label resolution function
// used across all surfaces.
 *
 * VAL-DASH-004: Each location entry uses display_label with name fallback.
 * display_label=NULL falls back to businesses.name consistently across
 * all surfaces (switcher, notifications, approval chips).
 */
export function getDisplayLabel(location: HasDisplayLabel | HasDisplayLabelCamelCase): string {
  const label = 'display_label' in location
    ? (location as HasDisplayLabel).display_label
    : (location as HasDisplayLabelCamelCase).displayLabel;
  return label ?? location.name;
}


