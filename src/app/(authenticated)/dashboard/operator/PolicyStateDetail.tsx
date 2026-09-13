import { Fragment } from 'react';
import type { PolicyState, StoredPolicyConsequence } from '@/lib/agents/operator/schema';

// Shared by the policy card and its receipt, just as their voice renderers
// share field labels. These are frozen server values, never a simulation.
export function PolicyStateDetail({ state, other, account }: { state: PolicyState; other?: PolicyState; account: boolean }) {
  const fields = [
    { key: 'threshold', label: 'Auto-reply', value: state.threshold === null ? 'Off — you approve every reply' : `${state.threshold === 4 ? '4 and 5' : '5'} star reviews` },
    { key: 'vetoWindowMinutes', label: 'Time to stop a reply', value: `${state.vetoWindowMinutes} minutes` },
    { key: 'dailyAutoPostCap', label: 'Daily limit', value: state.dailyAutoPostCap === null ? `Platform default (${state.effectiveDailyCap} per day)` : `${state.dailyAutoPostCap} per day` },
    { key: 'rowExists', label: 'Rule source', value: account
      ? (state.rowExists ? 'Saved account default' : 'Platform defaults')
      : (state.rowExists ? 'Location rule' : 'Inherits account default') },
  ] as const;
  return <>{fields.map(({ key, label, value }) => (
    <Fragment key={key}>
      <span className="op-kv-label">{label}</span>
      <span className={other && state[key] !== other[key] ? 'op-diff-value op-changed' : 'op-diff-value'}>{value}</span>
    </Fragment>
  ))}</>;
}

export function PolicyConsequenceLine({ line, operation, vetoWindowMinutes }: {
  line: StoredPolicyConsequence;
  operation: string;
  vetoWindowMinutes: number;
}) {
  const held = line.held.below_threshold + line.held.cap_reached + line.held.manual;
  return (
    <div className="op-policy-consequence">
      <p className="op-body">
        Under this rule, {line.eligible} of your {line.total} reviews since {line.windowStart.slice(0, 10)} would have been eligible to auto-post. {held} would have waited for you.
      </p>
      <p className="op-note">Waiting for you: {line.held.below_threshold} below the rating threshold, {line.held.cap_reached} over the daily limit, {line.held.manual} under manual approval.</p>
      {operation === 'set_daily_cap' && <p className="op-body">Your busiest day had {line.busiestDay} reviews.</p>}
      {operation === 'set_veto_window' && <p className="op-body">Each auto-post waits {vetoWindowMinutes} minutes for you first.</p>}
      <p className="op-note">Excluded {line.excludedImported} imported reviews and {line.excludedUnknown} reviews whose origin is unknown.</p>
      <p className="op-asof">Reviews received {line.windowStart.slice(0, 10)} to {line.windowEnd.slice(0, 10)}. As of <time dateTime={line.asOf}>{new Date(line.asOf).toLocaleString()}</time>.</p>
    </div>
  );
}
