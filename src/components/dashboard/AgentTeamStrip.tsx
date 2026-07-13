'use client';

import { useQuery } from '@tanstack/react-query';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';
import type { LocationScope } from '@/contexts/LocationContext';
import {
  DEFAULT_DASHBOARD_WINDOW,
  type DashboardWindow,
} from '@/lib/kpi/types';

type AgentTeamSummary = {
  window: DashboardWindow;
  reply: number;
  guardian: number;
  insights: number;
};

type AgentKey = 'reply' | 'guardian' | 'insights';

type AgentDefinition = {
  key: AgentKey;
  name: string;
  role: string;
  icon: IconName;
  activity: (count: number) => string;
};

const AGENTS: readonly AgentDefinition[] = [
  {
    key: 'reply',
    name: 'Reply',
    role: 'Publishes approved replies',
    icon: 'edit',
    activity: (count) => `${count} ${count === 1 ? 'reply' : 'replies'} posted`,
  },
  {
    key: 'guardian',
    name: 'Guardian',
    role: 'Flags reviews that need you',
    icon: 'shield',
    activity: (count) => `${count} ${count === 1 ? 'review' : 'reviews'} escalated`,
  },
  {
    key: 'insights',
    name: 'Insights',
    role: 'Delivers your weekly reports',
    icon: 'lightbulb',
    activity: (count) => `${count} ${count === 1 ? 'report' : 'reports'} sent`,
  },
];

const WINDOW_LABELS: Record<DashboardWindow, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '12w': 'Last 12 weeks',
};

interface Props {
  scope: LocationScope;
  window?: DashboardWindow;
}

/** Windowed outcomes for the same location/account scope as the dashboard. */
export function AgentTeamStrip({
  scope,
  window = DEFAULT_DASHBOARD_WINDOW,
}: Props) {
  const query = useQuery({
    queryKey: ['dashboard-agent-team', scope, window],
    queryFn: ({ signal }) => fetchAgentTeam(scope, window, signal),
  });

  if (query.isPending) {
    return (
      <section className="card agent-team" aria-labelledby="agent-team-heading">
        <h2 id="agent-team-heading" className="card-h2">Your agent team</h2>
        <output className="agent-team-state">Loading agent activity…</output>
      </section>
    );
  }

  if (query.isError) {
    return (
      <section className="card agent-team" aria-labelledby="agent-team-heading">
        <h2 id="agent-team-heading" className="card-h2">Your agent team</h2>
        <div className="agent-team-state agent-team-state--error" role="alert">
          {query.error instanceof Error ? query.error.message : 'Unable to load agent activity'}
        </div>
      </section>
    );
  }

  const windowLabel = WINDOW_LABELS[query.data.window];
  return (
    <section className="card agent-team" aria-labelledby="agent-team-heading">
      <div className="agent-team-head">
        <div>
          <h2 id="agent-team-heading" className="card-h2">Your agent team</h2>
          <p>Quietly working across every review.</p>
        </div>
      </div>
      <div className="agent-team-grid">
        {AGENTS.map((agent) => {
          const count = query.data[agent.key];
          return (
            <article key={agent.key} className={`agent-team-card agent-team-card--${agent.key}`}>
              <div className="agent-team-icon" aria-hidden="true">
                <Icon name={agent.icon} size={19} />
              </div>
              <div className="agent-team-copy">
                <h3>{agent.name}</h3>
                <p>{agent.role}</p>
              </div>
              <div className="agent-team-activity">
                <strong>{count === 0 ? 'Standing by' : agent.activity(count)}</strong>
                <span>{windowLabel}</span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

async function fetchAgentTeam(
  scope: LocationScope,
  window: DashboardWindow,
  signal: AbortSignal,
): Promise<AgentTeamSummary> {
  const params = new URLSearchParams();
  params.set('scope', scope);
  params.set('window', window);
  const response = await fetch(`/api/dashboard/agent-team?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = isObject(body) && typeof body.error === 'string'
      ? body.error
      : 'Unable to load agent activity';
    throw new Error(message);
  }
  if (!isAgentTeamSummary(body, window)) {
    throw new Error('Agent activity response was incomplete');
  }
  return body;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isAgentTeamSummary(
  value: unknown,
  expectedWindow: DashboardWindow,
): value is AgentTeamSummary {
  if (
    !isObject(value)
    || value.window !== expectedWindow
  ) {
    return false;
  }
  return ['reply', 'guardian', 'insights'].every((key) => {
    const count = value[key];
    return typeof count === 'number' && Number.isInteger(count) && count >= 0;
  });
}
