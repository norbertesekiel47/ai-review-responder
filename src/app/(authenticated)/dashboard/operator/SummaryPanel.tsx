'use client';

import Link from 'next/link';
import type { OwnerConversationSummary } from '@/lib/agents/operator/reads';
import './operator.css';

export interface SummaryPanelProps {
  summary: OwnerConversationSummary | null;
  /**
   * How to name a location on screen, injected the way the cards get it: the
   * roster lives in `LocationContext` and this stays a pure renderer.
   */
  locationLabel: (locationId: string) => string;
  /** Shown instead of the blocks when the scope is `all` and nothing is chosen. */
  hint: string | null;
}

/**
 * The summary panel (spec §3.1): three blocks from AUTHORITATIVE reads, each
 * carrying the instant it was read at.
 *
 * A PURE RENDERER. It imports no dashboard DTO and issues no read of its own —
 * the architecture pass (H1-D) measured that the dashboard payload shapes the
 * rating band wrong, lacks the posted count and lacks the location list, and
 * that importing it drags in a 45-second Redis cache. Run A's granular helpers,
 * already wired into `getConversationForOwner`, are the source.
 *
 * `null` summary is NOT a zeroed panel. Every number here is scoped to one
 * location, and with none chosen an all-zeros panel with a fresh timestamp
 * reads as "just measured, and the answer is zero" — which for an account with
 * a dozen drafts waiting is a lie the timestamp vouches for.
 */
export function SummaryPanel({ summary, locationLabel, hint }: SummaryPanelProps) {
  if (summary === null) {
    return (
      <aside className="op-panel" aria-label="Summary">
        {hint !== null && <p className="op-body">{hint}</p>}
      </aside>
    );
  }

  const { locationId, pending, recent, rules, facts, connectionStatus, asOf } = summary;
  /**
   * THE LOCATION EVERY NUMBER BELOW IS SCOPED TO, named rather than implied.
   * The summary follows the latest TURN, which is not necessarily the
   * selector: after a Salon turn the owner can pick the Cafe and this panel
   * still reports the Salon. Saying "this location" then attached Salon's
   * counts and Salon's connection warning to whatever the selector happened to
   * show, and the Connect link dropped the scope entirely — it reads
   * `currentScope` unless `?locationId=` says otherwise (C3).
   */
  const here = locationLabel(locationId);

  return (
    <aside className="op-panel" aria-label="Summary">
      {connectionStatus !== 'active' && (
        <div className="op-kv">
          <span className="op-kv-label">Google</span>
          <p className="op-body">
            {here} is not connected to Google, so nothing can be posted yet.
          </p>
          <Link className="empty-link op-action" href={`/dashboard/connect?locationId=${locationId}`}>
            Connect Google Business
          </Link>
        </div>
      )}

      <section className="op-kv" aria-label="Waiting for you">
        <span className="op-kv-label">Waiting for you</span>
        <span className="op-kv-value">{pending.pendingCount}</span>
        <span className="op-body">
          drafts waiting at {here}, of {pending.draftsWaiting} across every location
        </span>
        <AsOf asOf={asOf} />
      </section>

      <section className="op-kv" aria-label="Recently completed">
        <span className="op-kv-label">Recently completed</span>
        <span className="op-kv-value">{recent.posted7d}</span>
        <span className="op-body">
          replies posted in the last {recent.reportingPeriodDays} days
        </span>
        <AsOf asOf={asOf} />
      </section>

      <section className="op-kv" aria-label="Current operating rules">
        <span className="op-kv-label">Current operating rules</span>
        <span className="op-body">
          {rules.threshold === null
            ? 'Auto-posting is off — you approve every reply.'
            : `Auto-posting from ${rules.threshold} stars up.`}
        </span>
        <span className="op-body">
          You get {rules.vetoWindowMinutes} minutes to stop a reply, up to {rules.dailyCap} a day.
        </span>
        <span className="op-body">
          {rules.locationOverrideExists
            ? `These are ${here}’s own rules.`
            : 'These come from the account default.'}
        </span>
        {/*
          The voice facts belong to the same block: the glossary's **Operating
          rules** is the threshold, veto window and daily cap PLUS the voice
          config, and a second card for two sentences would split one answer.
        */}
        <span className="op-body">
          {facts === null || facts.tone === null
            ? 'No tone is set, so replies use the RepWorth default voice.'
            : `Replies are written ${facts.tone}.`}
        </span>
        <span className="op-body">
          {facts === null
            ? 'Nothing is recorded to mention or avoid.'
            : `${facts.highlightFacts.length} things to mention, ${facts.avoidFacts.length} to avoid.`}
        </span>
        <AsOf asOf={asOf} />
      </section>
    </aside>
  );
}

/**
 * The server's OWN `asOf`, never a second `new Date()` in the browser: a number
 * and the instant it was read must not be able to disagree.
 */
function AsOf({ asOf }: { asOf: string }) {
  return (
    <span className="op-asof">
      As of <time dateTime={asOf}>{new Date(asOf).toLocaleTimeString()}</time>
    </span>
  );
}
