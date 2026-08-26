import type { CSSProperties } from 'react';

/**
 * The hero artifact: the h1 rendered as one object.
 *
 * It replaces a sample inbox email, which showed a single moment and neither
 * of the two things the headline promises — a pipeline, and a gate in the
 * middle of it. This shows both: the review arrives at the top, the gate is
 * the dark pivot across the centre, the public reply leaves at the bottom, and
 * one rail runs through all three.
 *
 * Nothing here is new copy. The review, the reply, the two gate postures and
 * the "Response from the owner" attribution are all claims the page already
 * makes in its six steps; the caption labels the whole thing a sample.
 *
 * Node colours are the dossier steps' own bar tokens — sage for Watch, gold
 * for the Gate, teal for Post — so the hero previews the colour language the
 * stack below uses.
 */
const bar = (token: string) => ({ ['--bar' as string]: token }) as CSSProperties;

export function HeroFlowArtifact() {
  return (
    <figure className="hiw-flow">
      <figcaption className="hiw-flow-cap">
        <span className="hiw-flow-cap-dot" aria-hidden="true" />
        <span>Sample · one review, end to end</span>
        <span className="hiw-flow-cap-tail">about a minute</span>
      </figcaption>

      <div className="hiw-flow-stage">
        <span className="hiw-flow-node" style={bar('var(--rw-sage-bar)')} aria-hidden="true" />
        <div className="hiw-flow-k">A review lands</div>
        <div className="hiw-flow-panel">
          <div className="hiw-flow-stars" aria-label="5 out of 5 stars">
            <span aria-hidden="true">★★★★★</span>
          </div>
          <p className="hiw-flow-quote">
            Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.
          </p>
          <div className="hiw-flow-who">Sarah L. · Bright Linen Dry Cleaning</div>
        </div>
      </div>

      {/* The pivot. The one dark surface in the artifact, because it is the one
          place the owner decides anything. */}
      <div className="hiw-flow-gate">
        <div className="hiw-flow-gate-k">The gate</div>
        <ul className="hiw-flow-gate-rows">
          <li>
            <span className="hiw-flow-gate-dot" style={bar('var(--rw-sage-bar)')} aria-hidden="true" />
            <span className="hiw-flow-gate-plan">Copilot</span>
            <span className="hiw-flow-gate-rule" aria-hidden="true" />
            <span className="hiw-flow-gate-v">your tap</span>
          </li>
          <li>
            <span className="hiw-flow-gate-dot" style={bar('var(--rw-gold-bar)')} aria-hidden="true" />
            <span className="hiw-flow-gate-plan">Autopilot</span>
            <span className="hiw-flow-gate-rule" aria-hidden="true" />
            <span className="hiw-flow-gate-v">your policy, then a veto window</span>
          </li>
        </ul>
      </div>

      <div className="hiw-flow-stage is-last">
        <span className="hiw-flow-node" style={bar('var(--rw-teal-bar)')} aria-hidden="true" />
        <div className="hiw-flow-k">The reply goes public</div>
        <div className="hiw-flow-panel is-live">
          <div className="hiw-flow-owner">
            <span className="hiw-flow-tick" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 13l4 4L19 7" />
              </svg>
            </span>
            Response from the owner
          </div>
          <p className="hiw-flow-quote">
            Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
            because we know your schedule doesn&apos;t wait for ours. See you again soon.
          </p>
        </div>
      </div>
    </figure>
  );
}
