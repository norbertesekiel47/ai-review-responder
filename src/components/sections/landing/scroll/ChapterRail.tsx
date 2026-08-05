'use client';

import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { SCROLL_CHAPTERS } from './section-map';

/**
 * Fixed chapter rail — where am I, how much is left, jump anywhere.
 *
 * The page is seven full screens with no positional cue, which is the one real
 * usability cost of a scroll-snapped full-viewport layout: every screen looks
 * like it could be the last one.
 *
 * ── Active chapter ────────────────────────────────────────────────────────
 * An IntersectionObserver with a `-50% 0px -50% 0px` root margin collapses the
 * viewport to a single horizontal line at its centre, so exactly one section
 * can intersect at a time and "active" is whichever section that line is over.
 * A scroll listener comparing offsets would do the same job while running on
 * every scroll event; this runs only at crossings.
 *
 * ── Reduced motion ────────────────────────────────────────────────────────
 * The rail stays VISIBLE. It is wayfinding, not decoration, and hiding it
 * would take navigation away from the users most likely to want it. What the
 * preference changes is the jump: `auto` instead of `smooth`, and no dot
 * transitions. (I proposed hiding it when we scoped this — that was wrong, and
 * this is the correction.)
 */

export function ChapterRail() {
  const [activeId, setActiveId] = useState<string>(SCROLL_CHAPTERS[0]?.id ?? '');
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const sections = SCROLL_CHAPTERS.map((chapter) => document.getElementById(chapter.id)).filter(
      (element): element is HTMLElement => element !== null,
    );
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        }
      },
      // Zero-height band across the viewport's middle — see the note above.
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    );

    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  return (
    <nav className="rw-lp-rail" aria-label="Page sections">
      <ul className="rw-lp-rail-list">
        {SCROLL_CHAPTERS.map((chapter) => {
          const isActive = chapter.id === activeId;
          return (
            <li key={chapter.id}>
              <button
                type="button"
                className="rw-lp-rail-dot"
                data-active={isActive ? 'true' : 'false'}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => jumpTo(chapter.id)}
              >
                {/* The label is the button's accessible name and its hover
                    affordance — not a `title`, which never reaches keyboard or
                    screen-reader users. */}
                <span className="rw-lp-rail-label">{chapter.label}</span>
                <span className="rw-lp-rail-mark" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
