'use client';

import { Reveal } from '../reveal';
import {
  EYEBROW,
  GOVERNOR_NOTE,
  HEADING_ACCENT,
  HEADING_LEAD,
  LEAD_IN,
  MOVEMENT_NOTE,
  TIERS,
} from './tiers-copy';

/**
 * Copilot vs Autopilot — section 8.
 *
 * The dial IS the layout (v2, owner feedback 2026-08-24: the floating-gauge +
 * two-cards version read as decoration). One horizontal travel line spans the
 * section; the two modes are POSITIONS on it — Copilot anchored at the left
 * end, Autopilot at the right — with the gold thumb resting on the Copilot
 * side, because that is where every account starts. "A dial, not a switch" is
 * argued by the geometry: detents between the ends say there is a range, not
 * two states.
 *
 * The track is decorative (aria-hidden, static). If it ever becomes an
 * interactive control it gets a `--rw-lp-accent` focus ring and a row in
 * focus-visible-marketing.test.ts.
 *
 * No glass, no cards: the modes are text anchored to the diagram, the way the
 * fleet section's nodes are. Neither mode takes a tier temperature — they are
 * modes, not agents — and nothing here is gold-FILLED (the three pills stay
 * the whole set).
 */

export function TiersSection() {
  return (
    <section className="rw-lp-tiers" aria-labelledby="rw-lp-tiers-heading">
      <div className="rw-lp-tiers-inner">
        <Reveal>
          <header className="rw-lp-tiers-intro">
            <p className="rw-lp-tiers-eyebrow">{EYEBROW}</p>
            <h2 className="rw-lp-tiers-heading" id="rw-lp-tiers-heading">
              {HEADING_LEAD} <span className="rw-lp-tiers-heading-accent">{HEADING_ACCENT}</span>
            </h2>
            <p className="rw-lp-tiers-lead">{LEAD_IN}</p>
          </header>
        </Reveal>

        <Reveal index={1} className="rw-lp-tiers-dialplate-reveal">
          <div className="rw-lp-tiers-dialplate">
            <div className="rw-lp-tiers-track" aria-hidden="true">
              {/* End stops, three detents between them: a range, not a toggle. */}
              <span className="rw-lp-tiers-detent" data-end="true" />
              <span className="rw-lp-tiers-detent" />
              <span className="rw-lp-tiers-detent" />
              <span className="rw-lp-tiers-detent" />
              <span className="rw-lp-tiers-detent" data-end="true" />
              {/* The thumb rests on the Copilot side: the default. */}
              <span className="rw-lp-tiers-thumb" />
            </div>

            <div className="rw-lp-tiers-modes">
              {TIERS.map((tier) => (
                <article key={tier.id} className="rw-lp-tiers-mode" data-tier={tier.id}>
                  <h3 className="rw-lp-tiers-mode-name">{tier.name}</h3>
                  <p className="rw-lp-tiers-mode-claim">{tier.claim}</p>
                  <p className="rw-lp-tiers-mode-body">{tier.body}</p>
                </article>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal index={2}>
          <p className="rw-lp-tiers-note">
            {MOVEMENT_NOTE} <span className="rw-lp-tiers-note-governor">{GOVERNOR_NOTE}</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
