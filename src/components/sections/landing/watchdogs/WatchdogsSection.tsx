'use client';

import Link from 'next/link';
import { MARKETING_LINKS } from '@/components/ui/marketing-links';
import { AgentFlipCard } from '../agent-flip-card';
import { Staged, StagedLine } from '../staged';
import {
  PIPELINE_LINK_LABEL,
  EYEBROW,
  HEADING_ACCENT,
  HEADING_LEAD,
  LEAD_IN,
  STATEMENT_ACCENT,
  STATEMENT_FOOTNOTE,
  STATEMENT_LEAD,
  TIER_LABEL,
  WATCHDOGS,
} from './watchdogs-copy';

/**
 * The supervising agents — the watchtower rows (2026-08-24 revamp).
 *
 * Deliberately cooler than the personas section — teal accent, wider spacing,
 * more air. The reference doc (§1.2) asks for the watchdogs to read as an
 * "oversight layer" rather than a "worker layer", and a temperature shift does
 * that without spending a sentence explaining it. If this section ever adopts
 * the gold accent, the two layers collapse into one.
 *
 * The ROW form stays (measurements.md §2 — it exists for real reasons: height
 * budget and a clipping bug), but the row now WORKS its width: a larger
 * avatar stage where the Judge's iris motion actually reads, and the
 * governing rule stamped as a plate in the space that used to be a void. The
 * statement panel enters as staged lines — it is the page's strongest trust
 * claim, and it now performs its own interruption instead of merely sitting
 * in one.
 */
export function WatchdogsSection() {
  return (
    <section className="rw-lp-watch" aria-labelledby="rw-lp-watch-heading">
      <div className="rw-lp-watch-inner">
        <Staged beat={0}>
          <header className="rw-lp-watch-intro">
            <p className="rw-lp-watch-eyebrow">{EYEBROW}</p>
            <h2 className="rw-lp-watch-heading" id="rw-lp-watch-heading">
              {HEADING_LEAD} <span className="rw-lp-watch-heading-accent">{HEADING_ACCENT}</span>
            </h2>
            <p className="rw-lp-watch-lead">{LEAD_IN}</p>
          </header>
        </Staged>

        {/* The statement's two halves land as separate beats, the footnote
            after them — the claim interrupts, then qualifies itself. */}
        <Staged beat={1}>
          <figure className="rw-lp-watch-statement rw-lp-glass">
            <blockquote className="rw-lp-watch-statement-quote">
              <StagedLine beat={2}>{STATEMENT_LEAD}</StagedLine>{' '}
              <StagedLine beat={3} className="rw-lp-watch-statement-accent">
                {STATEMENT_ACCENT}
              </StagedLine>
            </blockquote>
            <figcaption>
              <StagedLine beat={4} className="rw-lp-watch-statement-note">
                {STATEMENT_FOOTNOTE}
              </StagedLine>
            </figcaption>
          </figure>
        </Staged>

        <Staged beat={4}>
          <p className="rw-lp-watch-tier-label">{TIER_LABEL}</p>
        </Staged>

        <div className="rw-lp-watch-grid">
          {WATCHDOGS.map((watchdog, index) => (
            <Staged key={watchdog.id} beat={5 + index}>
              <AgentFlipCard
                name={watchdog.name}
                tagline={watchdog.tagline}
                duties={watchdog.body}
                chip={watchdog.rule}
                chipTone="teal"
                tier="watchdog"
                frontRule={watchdog.rule}
                videoSrc={`/agents/${watchdog.id}.mp4`}
                posterSrc={`/agents/${watchdog.id}.jpg`}
              />
            </Staged>
          ))}
        </div>

        {/* The whole pipeline lives on /how-it-works — the landing page links
            to it rather than retelling it (see watchdogs-copy.ts). Gold, not
            teal: the link is an ACTION, and gold is the action temperature. */}
        <Staged beat={7}>
          <p className="rw-lp-watch-pipeline">
            <Link href={MARKETING_LINKS.howItWorks.href} className="rw-lp-watch-pipeline-link">
              {PIPELINE_LINK_LABEL}
              <span aria-hidden="true" className="rw-lp-watch-pipeline-arrow">
                {'→'}
              </span>
            </Link>
          </p>
        </Staged>
      </div>
    </section>
  );
}
