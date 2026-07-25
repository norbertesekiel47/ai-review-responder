'use client';

import Link from 'next/link';
import { WITHHOLD_REASONS, type WithholdReason } from '@/lib/solicitation/restraint-policy';
import './requests.css';

/**
 * The Requests screen before there is a report to read (#544): one ghost funnel
 * plus the six restraint gates, at two opacities.
 *
 * ONE component, two modes on purpose — `no_batch` and `building` are the same
 * skeleton with different copy, so splitting them would buy two shallow
 * components sharing one stylesheet.
 *
 * `no_batch` deliberately does not distinguish "no batch has ever been built"
 * from "your uploads landed before watch-mode was on": the owner's remedy is
 * identical (upload a file), and explaining a server feature flag to a business
 * owner is noise, not transparency.
 *
 * ADR 0012: no rating, sentiment, or predicted-sentiment signal appears here —
 * the gates are the deterministic restraint policy, and none of them reads one.
 */

/**
 * What each gate CHECKS, in WITHHOLD_REASONS precedence order. Deliberately not
 * BatchReport's REASON_META: that map glosses why a named person was held back
 * ("Already left a review"), this one teaches the rule before any person
 * exists. Same closed enum, two different jobs — the CODES are the shared fact
 * and they come from WITHHOLD_REASONS in both places.
 */
const GATE_COPY: Record<WithholdReason, string> = {
  no_consent: 'Only contacts covered by the consent attestation you signed at upload are ever considered.',
  suppressed: 'Anyone marked never-contact is skipped, permanently.',
  already_reviewed: 'Customers who already reviewed you are never asked again.',
  stale_visit: 'Visits older than the freshness window for your trade are left alone.',
  over_contacted: 'Nobody is asked twice inside the minimum gap between asks.',
  velocity_banked: 'Everyone past the batch cap is banked for the next batch, not dropped.',
};

const NUMBER_FORMAT = new Intl.NumberFormat();

interface GhostPipelineProps {
  mode: 'no_batch' | 'building';
  contactsOnFile: number;
  /**
   * Polling gave up at the ceiling. Still the building screen — the build is
   * running on the worker either way — but nothing is in flight any more, so
   * the busy state is dropped and the owner gets an explicit way to re-check.
   */
  stalled?: boolean;
  onCheckAgain?: () => void;
}

export function GhostPipeline({
  mode,
  contactsOnFile,
  stalled = false,
  onCheckAgain,
}: GhostPipelineProps) {
  const building = mode === 'building';

  return (
    <div className="rq-stack">
      <section
        className="card section-enter section-enter-1 rq-ghost"
        aria-busy={building && !stalled ? 'true' : undefined}
      >
        <div className="rq-hero-head">
          <h2 className="card-h2" style={{ marginBottom: 0 }}>
            {building ? headline(stalled) : 'No batch yet'}
          </h2>
          <span className="rq-watch-pill">Watch-mode · nothing sent</span>
        </div>
        <p className="rq-built">{subhead(building, stalled)}</p>

        <ol className="rq-funnel rq-funnel--ghost" aria-label="Batch funnel">
          <GhostRung caption="candidates evaluated" />
          <GhostRung caption="held back" />
          <GhostRung caption="would have been sent" />
        </ol>

        {building ? (
          stalled && (
            <div className="rq-ghost-actions">
              <button type="button" className="btn btn-secondary rq-action" onClick={onCheckAgain}>
                Check again
              </button>
            </div>
          )
        ) : (
          <div className="rq-ghost-actions">
            <Link className="btn btn-primary rq-action" href="/dashboard/requests/contacts">
              Upload a contacts CSV
            </Link>
            {contactsOnFile > 0 && (
              <p className="rq-fact">
                <span className="rq-fact-lead">
                  {NUMBER_FORMAT.format(contactsOnFile)} contacts on file
                </span>{' '}
                — upload a new file to build your first batch.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="card section-enter section-enter-2 rq-ghost">
        <h2 className="card-h2">Every contact passes six checks</h2>
        <p className="rq-ledger-sub">
          These run in this order, and the first one that stops someone is the
          only reason recorded. When a batch exists you will see exactly who each
          check held back, and why.
        </p>
        <ol className="rq-gates">
          {WITHHOLD_REASONS.map((reason) => (
            <li className="rq-gate" key={reason}>
              <span className="rq-chip rq-chip--ghost">{reason}</span>
              <span className="rq-gate-copy">{GATE_COPY[reason]}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function GhostRung({ caption }: { caption: string }) {
  return (
    <li className="rq-rung rq-rung--ghost">
      <span className="rq-rung-num" aria-hidden="true">
        —
      </span>
      <span className="rq-rung-cap">{caption}</span>
    </li>
  );
}

function headline(stalled: boolean): string {
  return stalled ? 'Still processing' : 'Building your batch…';
}

function subhead(building: boolean, stalled: boolean): string {
  if (!building) {
    return 'Upload the customers you have served and RepWorth will work out who it would ask — without asking anyone.';
  }
  if (stalled) {
    return 'This is taking longer than usual. The build keeps running on our side; check again in a few minutes.';
  }
  return 'Evaluating your contacts against the checks below. Nothing is sent either way.';
}
