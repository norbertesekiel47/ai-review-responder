'use client';

import { AgentFlipCard } from '../agent-flip-card';
import { Staged } from '../staged';
import {
  avatarFor,
  EYEBROW,
  HEADING_ACCENT,
  HEADING_LEAD,
  LEAD_IN,
  NEXT_TAG,
  PERSONAS,
  PUBLISH_HEADING,
} from './personas-copy';

/**
 * The four acting agents, in depth.
 *
 * Laid out as a stacked list of full-width rows rather than a card grid. The
 * reference doc's §3.4 brief for this beat is "establish them as named
 * characters" — a four-up grid of equal tiles reads as a feature comparison,
 * which is the opposite. Each agent gets its own band, with the name set large
 * enough to carry as a proper noun.
 *
 * The publish chip is the section's real payload. It answers "will this thing
 * post something in my name?" per agent, in a fixed vocabulary — see the
 * accuracy contract in personas-copy.ts.
 *
 * 2026-08-24 (light elevation): the cards themselves are untouched — they are
 * the page's benchmark — but the section joins the cinema: the cards dock in
 * as staged beats instead of a flat fade, so the page's best objects no
 * longer have its flattest entrance.
 */

export function PersonasSection() {
  return (
    <section className="rw-lp-personas" aria-labelledby="rw-lp-personas-heading">
      <div className="rw-lp-personas-inner">
        <Staged beat={0}>
          <header className="rw-lp-personas-intro">
            <p className="rw-lp-personas-eyebrow">{EYEBROW}</p>
            <h2 className="rw-lp-personas-heading" id="rw-lp-personas-heading">
              {HEADING_LEAD}{' '}
              <span className="rw-lp-personas-heading-accent">{HEADING_ACCENT}</span>
            </h2>
            <p className="rw-lp-personas-lead">{LEAD_IN}</p>
          </header>
        </Staged>

        <Staged beat={1}>
          <p className="rw-lp-personas-column-note">{PUBLISH_HEADING}</p>
        </Staged>

        <div className="rw-lp-personas-list">
          {PERSONAS.map((persona, index) => (
            <Staged key={persona.id} beat={2 + index}>
              <AgentFlipCard
                name={persona.name}
                tagline={persona.tagline}
                duties={persona.body}
                chip={persona.publishLabel}
                chipTone={persona.publishes === 'bounded' ? 'gold' : 'teal'}
                status={persona.status}
                statusTag={NEXT_TAG}
                tier="persona"
                {...avatarFor(persona.id)}
              />
            </Staged>
          ))}
        </div>
      </div>
    </section>
  );
}
