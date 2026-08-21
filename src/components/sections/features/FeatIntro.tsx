'use client';

import type { ReactNode } from 'react';
import { useReveal } from './useReveal';

/**
 * Shared centred section intro for the nine feature chapters (Daylight
 * Gallery II): a small kicker with the chapter's bar-accent tick, the h2,
 * and an optional lede — the demo's `.intro` pattern.
 */
export function FeatIntro({
  n,
  kicker,
  bar,
  title,
  lede,
}: {
  n: string;
  kicker: string;
  bar: string;
  title: ReactNode;
  lede?: ReactNode;
}) {
  const [ref, seen] = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`rw-dl-rv ${seen ? 'is-in' : ''}`}>
      <div className="rw-dl-intro feat-intro">
        <p className="feat-intro-k">
          <span className="feat-intro-tick" style={{ ['--bar' as string]: bar }} aria-hidden="true" />
          {n} · {kicker}
        </p>
        <h2 className="rw-dl-h2">{title}</h2>
        {lede && <p>{lede}</p>}
      </div>
    </div>
  );
}
