// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewTimeline } from '@/lib/agents/read';
import { TimelineContent } from '../TimelineContent';
import { TimelineEscalationActions } from '../TimelineEscalationActions';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@/components/dashboard/shell/TopBar', () => ({
  TopBar: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header>
      <span>{title}</span>
      {subtitle && <span>{subtitle}</span>}
    </header>
  ),
}));

const NOW = new Date('2026-07-13T12:00:00.000Z');

function makeTimeline(overrides: Partial<ReviewTimeline> = {}): ReviewTimeline {
  return {
    review: {
      id: 'review-1',
      rating: 5,
      reviewerName: 'Morgan Lee',
      submittedAt: '2026-07-10T09:30:00.000Z',
      status: 'responded',
    },
    response: {
      id: 'response-1',
      status: 'pending_approval',
      approvalMethod: null,
      autoPostScheduledAt: null,
      postedAt: null,
      responseText: 'Thanks for visiting.',
      version: 2,
    },
    escalation: null,
    runs: [
      {
        id: 'run-progress',
        status: 'running',
        startedAt: '2026-07-13T11:00:00.000Z',
        endedAt: null,
        error: null,
        displayState: 'in_progress',
        steps: [
          {
            stepIndex: 1,
            stepKey: 'draft_generated',
            // Deliberately contradicts the usual step mapping. The UI must use
            // this stored attribution, never infer Reply from draft_generated.
            attributedAgent: 'guardian',
            status: 'completed',
            detail: {
              response_id: 'response-1',
              version: 2,
              held: false,
              unsafe_note: 'Raw customer prose must never render here.',
              issues: ['service_quality'],
              nested_payload: { raw: 'Nested prose must stay hidden.' },
            },
            latencyMs: 420,
            createdAt: '2026-07-13T11:01:00.000Z',
          },
          {
            stepIndex: 2,
            stepKey: 'moderation_checked',
            attributedAgent: 'system',
            status: 'completed',
            detail: {
              flagged: false,
              severity: 'high',
              held: true,
              source: 'A prose-like value under the wrong step must stay hidden.',
            },
            latencyMs: 38,
            createdAt: '2026-07-13T11:01:01.000Z',
          },
        ],
        outcomes: [
          {
            outcomeKind: 'reply_drafted',
            // Deliberately contradicts reply_drafted's usual attribution.
            attributedAgent: 'insights',
            occurredAt: '2026-07-13T11:01:00.000Z',
          },
        ],
      },
      {
        id: 'run-waiting',
        status: 'running',
        startedAt: '2026-07-13T10:00:00.000Z',
        endedAt: null,
        error: null,
        displayState: 'waiting_on_owner',
        steps: [],
        outcomes: [],
      },
      {
        id: 'run-stalled',
        status: 'running',
        startedAt: '2026-07-10T06:00:00.000Z',
        endedAt: null,
        error: null,
        displayState: 'stalled',
        steps: [],
        outcomes: [],
      },
      {
        id: 'run-completed',
        status: 'completed',
        startedAt: '2026-07-09T10:00:00.000Z',
        endedAt: '2026-07-09T10:05:00.000Z',
        error: null,
        displayState: 'completed',
        steps: [],
        outcomes: [],
      },
      {
        id: 'run-failed',
        status: 'failed',
        startedAt: '2026-07-08T10:00:00.000Z',
        endedAt: '2026-07-08T10:02:00.000Z',
        error: { reason: 'CostLimitExceeded' },
        displayState: 'failed',
        steps: [],
        outcomes: [],
      },
    ],
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderTimeline(timeline: ReviewTimeline = makeTimeline()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const fetchMock = vi.fn().mockResolvedValue(response(timeline));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={client}>
      <TimelineContent reviewId="review-1" />
    </QueryClientProvider>,
  );
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TimelineContent', () => {
  it('fetches the review timeline and renders its review header', async () => {
    const fetchMock = renderTimeline();

    expect(await screen.findByRole('heading', { name: 'Morgan Lee' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/reviews/review-1/timeline');
    expect(screen.getByLabelText('5 out of 5 stars')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to reviews/i })).toHaveAttribute(
      'href',
      '/dashboard/reviews',
    );
  });

  it('renders all five server-owned display states, including stalled age', async () => {
    renderTimeline();

    await screen.findByText('In progress');
    expect(screen.getByText('Waiting on you')).toBeInTheDocument();
    expect(screen.getByText('Stalled · 3d 6h')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('uses stored step attribution and renders only known safe structured facts', async () => {
    renderTimeline();

    const step = (await screen.findByText('Draft generated')).closest('li');
    expect(step).not.toBeNull();
    expect(within(step!).getByText('Guardian')).toBeInTheDocument();
    expect(within(step!).queryByText('Reply')).toBeNull();
    expect(within(step!).getByText('Response id')).toBeInTheDocument();
    expect(within(step!).getByText('response-1')).toBeInTheDocument();
    expect(within(step!).getByText('Version')).toBeInTheDocument();
    expect(within(step!).getByText('2')).toBeInTheDocument();
    expect(within(step!).queryByText('Held')).toBeNull();
    expect(within(step!).queryByText('Raw customer prose must never render here.')).toBeNull();
    expect(within(step!).queryByText('Service quality')).toBeNull();
    expect(within(step!).queryByText(/Nested prose/)).toBeNull();

    const moderationStep = screen.getByText('Moderation checked').closest('li');
    expect(moderationStep).not.toBeNull();
    expect(within(moderationStep!).getByText('Flagged')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('No')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('Severity')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('High')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('Held')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('Yes')).toBeInTheDocument();
    expect(within(moderationStep!).queryByText(/prose-like value/)).toBeNull();
  });

  it('uses the stored outcome attribution even when it contradicts outcomeKind', async () => {
    renderTimeline();

    const outcome = (await screen.findByText('Reply drafted')).closest<HTMLElement>('.timeline-outcome');
    expect(outcome).not.toBeNull();
    expect(outcome).toHaveClass('timeline-outcome--insights');
    expect(within(outcome!).getByText('Insights')).toBeInTheDocument();
  });

  it('renders the honest legacy state without fabricating a run', async () => {
    renderTimeline(makeTimeline({ runs: [] }));

    expect(await screen.findByText(/predates the agent timeline/i)).toBeInTheDocument();
    expect(screen.queryByText(/run 1/i)).toBeNull();
  });

  it('announces loading and exposes fetch failures accessibly', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let settle: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve; })));
    render(
      <QueryClientProvider client={client}>
        <TimelineContent reviewId="review-1" />
      </QueryClientProvider>,
    );

    expect(screen.getByText(/loading review timeline/i)).toBeInTheDocument();
    settle?.(response({ error: 'timeline unavailable' }, 503));

    expect(await screen.findByRole('alert')).toHaveTextContent('timeline unavailable');
  });
});

describe('TimelineEscalationActions', () => {
  it('renders no controls when a stale caller passes a resolved escalation', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <TimelineEscalationActions
        escalation={{
          id: 'escalation-resolved',
          status: 'resolved',
          severity: 'high',
          suggestedAction: 'escalate',
          createdAt: '2026-07-13T08:00:00.000Z',
          acknowledgedAt: '2026-07-13T09:00:00.000Z',
          resolvedAt: '2026-07-13T10:00:00.000Z',
        }}
        onRefresh={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['Acknowledge', 'acknowledge'],
    ['Resolve', 'resolve'],
  ] as const)('POSTs %s to the existing escalation route', async (label, action) => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    render(
      <TimelineEscalationActions
        escalation={{
          id: 'escalation-7',
          status: 'escalated',
          severity: 'high',
          suggestedAction: 'escalate',
          createdAt: '2026-07-13T08:00:00.000Z',
          acknowledgedAt: null,
          resolvedAt: null,
        }}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/dashboard/escalations/escalation-7/${action}`,
      { method: 'POST' },
    );
  });

  it('treats a 409 as stale state and refetches without an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Escalation is already resolved' }, 409),
    ));
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    render(
      <TimelineEscalationActions
        escalation={{
          id: 'escalation-8',
          status: 'acknowledged',
          severity: 'medium',
          suggestedAction: 'escalate',
          createdAt: '2026-07-13T08:00:00.000Z',
          acknowledgedAt: '2026-07-13T09:00:00.000Z',
          resolvedAt: null,
        }}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders other action failures as accessible errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ error: 'Unable to resolve escalation' }, 500),
    ));

    render(
      <TimelineEscalationActions
        escalation={{
          id: 'escalation-9',
          status: 'acknowledged',
          severity: 'low',
          suggestedAction: 'escalate',
          createdAt: '2026-07-13T08:00:00.000Z',
          acknowledgedAt: '2026-07-13T09:00:00.000Z',
          resolvedAt: null,
        }}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to resolve escalation');
  });
});
