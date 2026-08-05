'use client';

import { AgentFlipCard } from '../agent-flip-card';
import { Reveal } from '../reveal';
import {
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
 * The supervising agents.
 *
 * Deliberately cooler than the personas section — teal accent, wider spacing,
 * more air. The reference doc (§1.2) asks for the watchdogs to read as an
 * "oversight layer" rather than a "worker layer", and a temperature shift does
 * that without spending a sentence explaining it. If this section ever adopts
 * the gold accent, the two layers collapse into one.
 *
 * The Judge promise is a standalone panel, not a bullet inside a card. The doc
 * calls it the strongest trust statement RepWorth owns and asks for something
 * that stops the scroll; burying it in a feature list wastes it.
 */
export function WatchdogsSection() {
  return (
    <section className="rw-lp-watch" aria-labelledby="rw-lp-watch-heading">
      <div className="rw-lp-watch-inner">
        <Reveal>
          <header className="rw-lp-watch-intro">
            <p className="rw-lp-watch-eyebrow">{EYEBROW}</p>
            <h2 className="rw-lp-watch-heading" id="rw-lp-watch-heading">
              {HEADING_LEAD} <span className="rw-lp-watch-heading-accent">{HEADING_ACCENT}</span>
            </h2>
            <p className="rw-lp-watch-lead">{LEAD_IN}</p>
          </header>
        </Reveal>

        <Reveal index={1}>
          <figure className="rw-lp-watch-statement rw-lp-glass">
            <blockquote className="rw-lp-watch-statement-quote">
              {STATEMENT_LEAD}{' '}
              <span className="rw-lp-watch-statement-accent">{STATEMENT_ACCENT}</span>
            </blockquote>
            <figcaption className="rw-lp-watch-statement-note">{STATEMENT_FOOTNOTE}</figcaption>
          </figure>
        </Reveal>

        <p className="rw-lp-watch-tier-label">{TIER_LABEL}</p>

        <div className="rw-lp-watch-grid">
          {WATCHDOGS.map((watchdog, index) => (
            <Reveal key={watchdog.id} index={index + 2}>
              <AgentFlipCard
                name={watchdog.name}
                tagline={watchdog.tagline}
                duties={watchdog.body}
                chip={watchdog.rule}
                chipTone="teal"
                tier="watchdog"
                videoSrc={`/agents/${watchdog.id}.mp4`}
                posterSrc={`/agents/${watchdog.id}.jpg`}
              />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
