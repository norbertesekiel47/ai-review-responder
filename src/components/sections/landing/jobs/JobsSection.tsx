'use client';

import { Staged } from '../staged';
import {
  AGENTS_LABEL,
  CLOSING_LEAD,
  CLOSING_TAIL,
  EYEBROW,
  HEADING_ACCENT,
  HEADING_LEAD,
  HEADING_PLAIN,
  JOBS,
  LEAD_IN,
  SURFACE_LABEL,
} from './jobs-copy';

/**
 * The five jobs — a ledger, not a card grid.
 *
 * Five equal rows under one hairline rhythm: index and verb on the left, the
 * claim and body in the middle, the two meta cells on the right. Equal rows
 * are the argument (see jobs-copy.ts): no job gets a bigger box than another,
 * so "reputation system" is something the layout says before the copy does.
 *
 * Static on purpose — no controls, so nothing here joins
 * `focus-visible-marketing.test.ts`. The gold/teal `data-tone` follows the
 * page's temperature rule: acting agents are gold, the watching layer (and
 * the run spine, whose job Measure is) is teal.
 */
export function JobsSection() {
  return (
    <section className="rw-lp-jobs" aria-labelledby="rw-lp-jobs-heading">
      <div className="rw-lp-jobs-inner">
        <Staged beat={0}>
          <header className="rw-lp-jobs-intro">
            <p className="rw-lp-jobs-eyebrow">{EYEBROW}</p>
            <h2 className="rw-lp-jobs-heading" id="rw-lp-jobs-heading" aria-label={HEADING_PLAIN}>
              {HEADING_LEAD} <span className="rw-lp-jobs-heading-accent">{HEADING_ACCENT}</span>
            </h2>
            <p className="rw-lp-jobs-lead">{LEAD_IN}</p>
          </header>
        </Staged>

        <Staged beat={1} className="rw-lp-jobs-ledger-reveal">
          <div className="rw-lp-jobs-ledger">
            <div className="rw-lp-jobs-colhead" aria-hidden="true">
              <span />
              <span />
              <span>{AGENTS_LABEL}</span>
              <span>{SURFACE_LABEL}</span>
            </div>
            <ol className="rw-lp-jobs-rows">
              {JOBS.map((job, i) => (
                <li key={job.id} className="rw-lp-jobs-row" data-tone={job.tone}>
                  <Staged beat={2 + i} className="rw-lp-jobs-row-inner">
                    <div className="rw-lp-jobs-verbcell">
                      <span className="rw-lp-jobs-index">{job.index}</span>
                      <h3 className="rw-lp-jobs-verb">{job.verb}</h3>
                    </div>
                    <div className="rw-lp-jobs-textcell">
                      <p className="rw-lp-jobs-claim">{job.claim}</p>
                      <p className="rw-lp-jobs-body">{job.body}</p>
                    </div>
                    <dl className="rw-lp-jobs-meta">
                      <div className="rw-lp-jobs-metacell">
                        <dt className="rw-lp-jobs-metalabel">{AGENTS_LABEL}</dt>
                        <dd className="rw-lp-jobs-agents">{job.agents}</dd>
                      </div>
                      <div className="rw-lp-jobs-metacell">
                        <dt className="rw-lp-jobs-metalabel">{SURFACE_LABEL}</dt>
                        <dd className="rw-lp-jobs-surface">{job.surface}</dd>
                      </div>
                    </dl>
                  </Staged>
                </li>
              ))}
            </ol>
          </div>
        </Staged>

        <Staged beat={7}>
          <p className="rw-lp-jobs-closing">
            <span className="rw-lp-jobs-closing-lead">{CLOSING_LEAD}</span> {CLOSING_TAIL}
          </p>
        </Staged>
      </div>
    </section>
  );
}
