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
  /**
   * Vertical chapter marker on the section's left edge (SectionTransition
   * renders it; scroll-experience.css styles it). Only the four narrative
   * sections carry one — the hero and CTA are full-bleed film bookends, and a
   * chapter stamp over either would caption the shot instead of opening it.
   *
   * The index is stated, not derived from array position, because it counts
   * PAGE sections (hero = 01) and must survive the unbuilt sections 6–8
   * landing between future and the CTA without every number shifting.
   *
   * Tone mirrors the page's load-bearing temperature split: gold for the
   * acting layer, teal only for the watchdogs.
   */
  marker?: { index: string; tone: 'gold' | 'teal' };
}

export const SCROLL_CHAPTERS: readonly ScrollChapter[] = [
  { id: 'top', label: 'Top' },
  { id: 'fleet', label: 'The fleet', marker: { index: '02', tone: 'gold' } },
  { id: 'agents-that-act', label: 'Agents that act', marker: { index: '03', tone: 'gold' } },
  { id: 'agents-that-watch', label: 'Agents that watch', marker: { index: '04', tone: 'teal' } },
  { id: 'where-this-is-going', label: 'Where this is going', marker: { index: '05', tone: 'gold' } },
  { id: 'early-access', label: 'Early access' },
];
