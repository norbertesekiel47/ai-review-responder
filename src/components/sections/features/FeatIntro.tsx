'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/ui/cn';
import { useReveal } from '@/hooks/useReveal';

/**
 * Chapter header for the nine feature chapters (Daylight Gallery II, premium
 * pass): the /how-it-works dossier header row — number · kicker with the
 * chapter's bar tick · group on the right, between two hairlines — followed by
 * the left-aligned h2 and lede. Renders two grid items (header row + text
 * column) so the chapter grid (`.feat-ch`) can place the text beside, or
 * above, the artifact without a wrapper.
 */
export function FeatIntro({
  n,
  kicker,
  bar,
  group,
  title,
  lede,
  children,
}: {
  /** Dossier number; omitted on the roadmap band. */
  n?: string;
  kicker: string;
  bar: string;
  /** The index group the chapter belongs to, shown on the header row's tail. */
  group: string;
  title: ReactNode;
  lede?: ReactNode;
  /** Extra text-column content (bullets, chips) under the lede. */
  children?: ReactNode;
}) {
  const [ref, seen] = useReveal<HTMLDivElement>();
  return (
    <>
      <div ref={ref} className={cn('feat-ch-hd rw-dl-rv', seen && 'is-in')}>
        <span className="feat-intro-tick" style={{ ['--bar' as string]: bar }} aria-hidden="true" />
        {n && <b>{n}</b>}
        <span>{kicker}</span>
        <span className="feat-ch-grp">{group}</span>
      </div>
      <div className={cn('feat-ch-tx rw-dl-rv', seen && 'is-in')}>
        <h2 className="rw-dl-h2">{title}</h2>
        {lede && <p className="feat-ch-lede">{lede}</p>}
        {children}
      </div>
    </>
  );
}
