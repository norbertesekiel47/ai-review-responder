/**
 * The landing page's scroll chapters.
 *
 * Single owner of the id + label pair for every snappable section. Both the
 * chapter rail and the section wrappers read from here, so a section cannot
 * appear in the rail without also being a scroll target (or vice versa) — the
 * two drifting apart is the obvious failure mode of a hand-maintained rail.
 *
 * ORDER IS THE PAGE ORDER. The rail renders top-to-bottom in this order and
 * assumes it matches the DOM; if a section moves in LandingExperience.tsx, it
 * moves here too.
 *
 * The footer is deliberately absent. It is chrome rather than a chapter, it is
 * shorter than a viewport, and giving it a snap point makes the last scroll of
 * the page fight the user.
 */

export interface ScrollChapter {
  /** DOM id, applied to the section's scroll wrapper. */
  id: string;
  /** Rail label, shown on hover and as the button's accessible name. */
  label: string;
}

export const SCROLL_CHAPTERS: readonly ScrollChapter[] = [
  { id: 'top', label: 'Top' },
  { id: 'fleet', label: 'The fleet' },
  { id: 'agents-that-act', label: 'Agents that act' },
  { id: 'agents-that-watch', label: 'Agents that watch' },
  { id: 'where-this-is-going', label: 'Where this is going' },
  { id: 'early-access', label: 'Early access' },
];
