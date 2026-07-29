import type { Sql } from 'postgres';
import type { ApprovalMethod } from '@/lib/auto-approval/types';
import type { EscalationStatus } from '@/lib/escalations/types';
import type { TriageOutput, TriageSeverity } from '@/lib/reviews/triage-schema';
import { RECENT_REVIEW_DISPLAY_STATUSES } from '@/lib/shared/response-status';
import { dashboardWindowParams, type DashboardWindow } from '@/lib/kpi/types';
import { AGENT_RUN_KINDS } from './run-spine';
import type {
  AgentOutcomeKind,
  AgentPersona,
  AttributedAgentPersona,
} from './run-spine';

export type RunDisplayState =
  | 'in_progress'
  | 'waiting_on_owner'
  | 'stalled'
  | 'completed'
  | 'cancelled'
  | 'failed';

const STALLED_RUNNING_THRESHOLD_MS = 48 * 60 * 60 * 1000;

// A send batch is legitimately long-lived: 7-day approval window + 72-hour send
// window bounds it at 10 days BY CONSTRUCTION, so 11 days is "past a bound that
// cannot be reached", not a threshold picked by feel. Every other kind keeps the
// 48-hour default — a review handler running for two days really is stuck.
export const STALLED_THRESHOLD_SEND_BATCH_DAYS = 11;

const STALLED_THRESHOLD_SEND_BATCH_MS =
  STALLED_THRESHOLD_SEND_BATCH_DAYS * 24 * 60 * 60 * 1000;

export function stalledThresholdMsForKind(
  kind: (typeof AGENT_RUN_KINDS)[number],
): number {
  return kind === 'solicitation_send_batch'
    ? STALLED_THRESHOLD_SEND_BATCH_MS
    : STALLED_RUNNING_THRESHOLD_MS;
}

export interface ReviewTimelineStep {
  stepIndex: number;
  stepKey: string;
  attributedAgent: AgentPersona;
  status: 'completed' | 'failed' | 'skipped';
  detail: Record<string, unknown>;
  latencyMs: number | null;
  createdAt: string;
}

export interface ReviewTimelineOutcome {
  outcomeKind: AgentOutcomeKind;
  attributedAgent: AgentPersona;
  occurredAt: string;
}

export interface ReviewTimelineRun {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  endedAt: string | null;
  error: Record<string, unknown> | null;
  displayState: RunDisplayState;
  steps: ReviewTimelineStep[];
  outcomes: ReviewTimelineOutcome[];
}

export interface ReviewTimelineResponse {
  id: string;
  status: string;
  approvalMethod: ApprovalMethod | null;
  autoPostScheduledAt: string | null;
  postedAt: string | null;
  responseText: string;
  version: number;
}

export interface ReviewTimelineEscalation {
  id: string;
  status: EscalationStatus;
  severity: TriageSeverity;
  suggestedAction: TriageOutput['suggested_action'];
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface ReviewTimeline {
  review: {
    id: string;
    rating: number | null;
    reviewerName: string | null;
    submittedAt: string | null;
    status: string;
  };
  response: ReviewTimelineResponse | null;
  escalation: ReviewTimelineEscalation | null;
  runs: ReviewTimelineRun[];
}

// status-audit-ignore: WS5 display-state-only subset; not a reusable SQL/counting group.
const OWNER_WAITING_RESPONSE_STATUSES = new Set([
  'pending_approval',
  'awaiting_owner_connect',
]);

export function deriveRunDisplayState(
  run: {
    status: 'running' | 'completed' | 'cancelled' | 'failed';
    kind: (typeof AGENT_RUN_KINDS)[number];
    startedAt: Date | string;
  },
  latestResponse: {
    status: string;
    approvalMethod?: string | null;
    autoPostScheduledAt?: Date | string | null;
  } | null,
  now: Date,
): RunDisplayState {
  if (run.status === 'completed') return 'completed';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'failed') return 'failed';
  if (latestResponse && OWNER_WAITING_RESPONSE_STATUSES.has(latestResponse.status)) {
    return 'waiting_on_owner';
  }
  if (now.getTime() - new Date(run.startedAt).getTime() > stalledThresholdMsForKind(run.kind)) {
    return 'stalled';
  }
  return 'in_progress';
}

type ReviewRow = {
  id: string;
  star_rating: number | null;
  reviewer_name: string | null;
  review_date: Date | string | null;
  status: string;
};

type ResponseRow = {
  id: string;
  status: string;
  approval_method: ApprovalMethod | null;
  auto_post_scheduled_at: Date | string | null;
  posted_at: Date | string | null;
  response_text: string;
  version: number;
};

type EscalationRow = {
  id: string;
  status: EscalationStatus;
  triage_severity: TriageSeverity;
  triage_suggested_action: TriageOutput['suggested_action'];
  created_at: Date | string;
  acknowledged_at: Date | string | null;
  resolved_at: Date | string | null;
};

type RunRow = {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  kind: (typeof AGENT_RUN_KINDS)[number];
  started_at: Date | string;
  ended_at: Date | string | null;
  error: unknown;
};

type StepRow = {
  agent_run_id: string;
  step_index: number;
  step_key: string;
  attributed_agent: AgentPersona;
  status: 'completed' | 'failed' | 'skipped';
  detail: unknown;
  latency_ms: number | null;
  created_at: Date | string;
};

type OutcomeRow = {
  agent_run_id: string;
  outcome_kind: AgentOutcomeKind;
  attributed_agent: AgentPersona;
  occurred_at: Date | string;
};

type TeamSummaryRow = {
  attributed_agent: AttributedAgentPersona;
  outcome_kind: AgentOutcomeKind;
  n: number;
};

export type AgentTeamScope =
  | { kind: 'account'; accountId: string }
  | { kind: 'location'; accountId: string; businessId: string };

export interface AgentTeamSummary {
  reply: number;
  guardian: number;
  insights: number;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value == null ? null : iso(value);
}

function parseJsonbObject(value: unknown, column: string): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`agents/read: expected ${column} to contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function mapResponse(row: ResponseRow | undefined): ReviewTimelineResponse | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    approvalMethod: row.approval_method,
    autoPostScheduledAt: nullableIso(row.auto_post_scheduled_at),
    postedAt: nullableIso(row.posted_at),
    responseText: row.response_text,
    version: row.version,
  };
}

function mapEscalation(row: EscalationRow | undefined): ReviewTimelineEscalation | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    severity: row.triage_severity,
    suggestedAction: row.triage_suggested_action,
    createdAt: iso(row.created_at),
    acknowledgedAt: nullableIso(row.acknowledged_at),
    resolvedAt: nullableIso(row.resolved_at),
  };
}

function groupSteps(rows: StepRow[]): Map<string, ReviewTimelineStep[]> {
  const grouped = new Map<string, ReviewTimelineStep[]>();
  for (const row of rows) {
    const steps = grouped.get(row.agent_run_id) ?? [];
    steps.push({
      stepIndex: row.step_index,
      stepKey: row.step_key,
      attributedAgent: row.attributed_agent,
      status: row.status,
      detail: parseJsonbObject(row.detail, 'agent_run_steps.detail'),
      latencyMs: row.latency_ms,
      createdAt: iso(row.created_at),
    });
    grouped.set(row.agent_run_id, steps);
  }
  return grouped;
}

function groupOutcomes(rows: OutcomeRow[]): Map<string, ReviewTimelineOutcome[]> {
  const grouped = new Map<string, ReviewTimelineOutcome[]>();
  for (const row of rows) {
    const outcomes = grouped.get(row.agent_run_id) ?? [];
    outcomes.push({
      outcomeKind: row.outcome_kind,
      attributedAgent: row.attributed_agent,
      occurredAt: iso(row.occurred_at),
    });
    grouped.set(row.agent_run_id, outcomes);
  }
  return grouped;
}

function mapTeamSummary(rows: TeamSummaryRow[]): AgentTeamSummary {
  const summary: AgentTeamSummary = { reply: 0, guardian: 0, insights: 0 };
  for (const row of rows) {
    // Every posted reply records reply_posted; an auto-policy post records
    // reply_auto_posted ON THE SAME RUN as a qualifier (mark-posted.ts).
    // Count only reply_posted or auto-posts double.
    if (
      row.attributed_agent === 'reply'
      && row.outcome_kind === 'reply_posted'
    ) {
      summary.reply += Number(row.n);
    } else if (
      row.attributed_agent === 'guardian'
      && row.outcome_kind === 'review_escalated'
    ) {
      summary.guardian += Number(row.n);
    } else if (
      row.attributed_agent === 'insights'
      && row.outcome_kind === 'digest_sent'
    ) {
      summary.insights += Number(row.n);
    }
  }
  return summary;
}

export async function getReviewTimeline(
  sql: Sql,
  params: { accountId: string; reviewId: string },
): Promise<ReviewTimeline | null> {
  const [review] = await sql<ReviewRow[]>`
    SELECT r.id, r.star_rating, r.reviewer_name, r.review_date, r.status
    FROM reviews r
    JOIN businesses b ON b.id = r.business_id
    WHERE r.id = ${params.reviewId}
      AND b.account_id = ${params.accountId}
      AND b.archived_at IS NULL
  `;
  if (!review) return null;

  const [responseRows, escalationRows, runRows] = await Promise.all([
    sql<ResponseRow[]>`
      SELECT resp.id, resp.status, resp.approval_method,
             resp.auto_post_scheduled_at, resp.posted_at,
             COALESCE(resp.approved_text, resp.response_text) AS response_text,
             resp.version
      FROM responses resp
      JOIN businesses b ON b.id = resp.business_id
      LEFT JOIN flagged_responses fr
        ON fr.response_id = resp.id AND fr.status = 'open'
      WHERE resp.review_id = ${params.reviewId}
        AND b.account_id = ${params.accountId}
        AND b.archived_at IS NULL
        AND resp.status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
        AND fr.id IS NULL
      ORDER BY resp.version DESC
      LIMIT 1
    `,
    sql<EscalationRow[]>`
      SELECT e.id, e.status, e.triage_severity, e.triage_suggested_action,
             e.created_at, e.acknowledged_at, e.resolved_at
      FROM review_escalations e
      WHERE e.review_id = ${params.reviewId}
        AND e.account_id = ${params.accountId}
      ORDER BY (e.status <> 'resolved') DESC, e.created_at DESC
      LIMIT 1
    `,
    sql<RunRow[]>`
      SELECT ar.id, ar.status, ar.kind, ar.started_at, ar.ended_at, ar.error
      FROM agent_runs ar
      WHERE ar.account_id = ${params.accountId}
        AND ar.kind = 'review_handler'
        AND ar.subject_type = 'review'
        AND ar.subject_id = ${params.reviewId}
      ORDER BY ar.started_at DESC
      LIMIT 20
    `,
  ]);

  const latestResponse = mapResponse(responseRows[0]);
  const escalation = mapEscalation(escalationRows[0]);
  if (runRows.length === 0) {
    return {
      review: {
        id: review.id,
        rating: review.star_rating,
        reviewerName: review.reviewer_name,
        submittedAt: nullableIso(review.review_date),
        status: review.status,
      },
      response: latestResponse,
      escalation,
      runs: [],
    };
  }

  const runIds = runRows.map((run) => run.id);
  const [stepRows, outcomeRows] = await Promise.all([
    sql<StepRow[]>`
      SELECT s.agent_run_id, s.step_index, s.step_key, s.attributed_agent,
             s.status, s.detail, s.latency_ms, s.created_at
      FROM agent_run_steps s
      JOIN agent_runs ar ON ar.id = s.agent_run_id
      WHERE s.agent_run_id = ANY(${runIds}::uuid[])
        AND ar.account_id = ${params.accountId}
      ORDER BY s.agent_run_id, s.step_index
    `,
    sql<OutcomeRow[]>`
      SELECT o.agent_run_id, o.outcome_kind, o.attributed_agent, o.occurred_at
      FROM agent_outcomes o
      WHERE o.agent_run_id = ANY(${runIds}::uuid[])
        AND o.account_id = ${params.accountId}
      ORDER BY o.agent_run_id, o.occurred_at
    `,
  ]);
  const stepsByRun = groupSteps(stepRows);
  const outcomesByRun = groupOutcomes(outcomeRows);
  const now = new Date();

  return {
    review: {
      id: review.id,
      rating: review.star_rating,
      reviewerName: review.reviewer_name,
      submittedAt: nullableIso(review.review_date),
      status: review.status,
    },
    response: latestResponse,
    escalation,
    runs: runRows.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: iso(run.started_at),
      endedAt: nullableIso(run.ended_at),
      error: run.error == null ? null : parseJsonbObject(run.error, 'agent_runs.error'),
      displayState: deriveRunDisplayState(
        { status: run.status, kind: run.kind, startedAt: run.started_at },
        latestResponse,
        now,
      ),
      steps: stepsByRun.get(run.id) ?? [],
      outcomes: outcomesByRun.get(run.id) ?? [],
    })),
  };
}

export async function getAgentTeamSummary(
  sql: Sql,
  scope: AgentTeamScope,
  window: DashboardWindow,
): Promise<AgentTeamSummary> {
  const { windowDays } = dashboardWindowParams(window);
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  if (scope.kind === 'location') {
    const rows = await sql<TeamSummaryRow[]>`
      SELECT o.attributed_agent, o.outcome_kind, COUNT(*)::int AS n
      FROM agent_outcomes o
      WHERE o.account_id = ${scope.accountId}
        AND o.business_id = ${scope.businessId}
        AND o.occurred_at >= ${windowStart}
      GROUP BY o.attributed_agent, o.outcome_kind
    `;
    return mapTeamSummary(rows);
  }

  const rows = await sql<TeamSummaryRow[]>`
    SELECT o.attributed_agent, o.outcome_kind, COUNT(*)::int AS n
    FROM agent_outcomes o
    WHERE o.account_id = ${scope.accountId}
      AND o.occurred_at >= ${windowStart}
    GROUP BY o.attributed_agent, o.outcome_kind
  `;
  return mapTeamSummary(rows);
}
