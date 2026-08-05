'use client';

import { AgentFlipCard } from '../agent-flip-card';
import { Reveal } from '../reveal';
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
 */

export function PersonasSection() {
  return (
    <section className="rw-lp-personas" aria-labelledby="rw-lp-personas-heading">
      <div className="rw-lp-personas-inner">
        <Reveal>
          <header className="rw-lp-personas-intro">
            <p className="rw-lp-personas-eyebrow">{EYEBROW}</p>
            <h2 className="rw-lp-personas-heading" id="rw-lp-personas-heading">
              {HEADING_LEAD}{' '}
              <span className="rw-lp-personas-heading-accent">{HEADING_ACCENT}</span>
            </h2>
            <p className="rw-lp-personas-lead">{LEAD_IN}</p>
          </header>
        </Reveal>

        <p className="rw-lp-personas-column-note">{PUBLISH_HEADING}</p>

        <div className="rw-lp-personas-list">
          {PERSONAS.map((persona, index) => (
            <Reveal key={persona.id} index={index}>
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
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
