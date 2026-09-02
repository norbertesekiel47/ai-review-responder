// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewTimeline } from '@/lib/agents/read';
import { resolveBackLink, TimelineContent } from '../TimelineContent';
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

function renderTimeline(timeline: ReviewTimeline = makeTimeline(), from?: string | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const fetchMock = vi.fn().mockResolvedValue(response(timeline));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={client}>
      <TimelineContent reviewId="review-1" from={from} />
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

    // Owner-facing label, not the de-snake-cased step key (D19).
    const step = (await screen.findByText('Draft written')).closest('li');
    expect(step).not.toBeNull();
    expect(screen.queryByText('Draft generated')).toBeNull();
    expect(within(step!).getByText('Guardian')).toBeInTheDocument();
    expect(within(step!).queryByText('Reply')).toBeNull();
    expect(within(step!).getByText('Reply wrote a draft in your voice.')).toBeInTheDocument();
    // Identifiers and version numbers are not facts any more (D19).
    expect(within(step!).queryByText('Response id')).toBeNull();
    expect(within(step!).queryByText('response-1')).toBeNull();
    expect(within(step!).queryByText('Version')).toBeNull();
    expect(within(step!).queryByText('Held back')).toBeNull();
    expect(within(step!).queryByText('Raw customer prose must never render here.')).toBeNull();
    expect(within(step!).queryByText('Service quality')).toBeNull();
    expect(within(step!).queryByText(/Nested prose/)).toBeNull();

    const moderationStep = screen.getByText('Safety check').closest('li');
    expect(moderationStep).not.toBeNull();
    expect(within(moderationStep!).getByText('Flagged')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('No')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('Severity')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('High')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('Held back')).toBeInTheDocument();
    expect(within(moderationStep!).getByText('Yes')).toBeInTheDocument();
    expect(within(moderationStep!).queryByText(/prose-like value/)).toBeNull();
  });

  it('renders no latency and no reply version — neither is an owner fact (D19)', async () => {
    renderTimeline();
    await screen.findByText('Draft written');
    expect(screen.queryByText(/420 ms/)).toBeNull();
    expect(screen.queryByText(/38 ms/)).toBeNull();
    expect(screen.queryByText('Reply version')).toBeNull();
  });

  it('headlines the held decision above the step list (D19)', async () => {
    renderTimeline();
    const run = (await screen.findByText('Draft written')).closest('article');
    expect(run).not.toBeNull();
    expect(
      within(run!).getByText('Held back by the safety check — nothing was posted.'),
    ).toBeInTheDocument();
  });

  it('headlines the hand-off when the policy gate sent the draft to the owner', async () => {
    renderTimeline(makeTimeline({
      runs: [
        {
          id: 'run-gate',
          status: 'running',
          startedAt: '2026-07-13T11:00:00.000Z',
          endedAt: null,
          error: null,
          displayState: 'waiting_on_owner',
          steps: [
            {
              stepIndex: 1,
              stepKey: 'moderation_checked',
              attributedAgent: 'system',
              status: 'completed',
              detail: { flagged: false, severity: 'low', held: false },
              latencyMs: 10,
              createdAt: '2026-07-13T11:01:00.000Z',
            },
            {
              stepIndex: 2,
              stepKey: 'policy_gate',
              attributedAgent: 'reply',
              status: 'completed',
              detail: { decision: 'held_for_owner' },
              latencyMs: 2,
              createdAt: '2026-07-13T11:01:01.000Z',
            },
          ],
          outcomes: [],
        },
      ],
    }));
    expect(
      await screen.findByText('Sent to you for approval — nothing posts until you say so.'),
    ).toBeInTheDocument();
    const gateStep = screen.getByText('Approval decision').closest('li');
    expect(within(gateStep!).getByText('Sent to you')).toBeInTheDocument();
  });

  it('labels failed and skipped steps with a text chip, in the step\'s own words (D20)', async () => {
    renderTimeline(makeTimeline({
      runs: [
        {
          id: 'run-chips',
          status: 'failed',
          startedAt: '2026-07-13T11:00:00.000Z',
          endedAt: '2026-07-13T11:02:00.000Z',
          error: { reason: 'CostLimitExceeded' },
          displayState: 'failed',
          steps: [
            {
              stepIndex: 1,
              stepKey: 'moderation_checked',
              attributedAgent: 'system',
              status: 'failed',
              detail: { flagged: true, severity: 'high', held: true },
              latencyMs: 10,
              createdAt: '2026-07-13T11:01:00.000Z',
            },
            {
              stepIndex: 2,
              stepKey: 'policy_gate',
              attributedAgent: 'reply',
              status: 'skipped',
              detail: {},
              latencyMs: null,
              createdAt: '2026-07-13T11:01:01.000Z',
            },
            {
              stepIndex: 3,
              stepKey: 'reply_posted',
              attributedAgent: 'reply',
              status: 'failed',
              detail: {},
              latencyMs: null,
              createdAt: '2026-07-13T11:01:02.000Z',
            },
          ],
          outcomes: [],
        },
      ],
    }));
    const safety = (await screen.findByText('Safety check')).closest('li');
    expect(within(safety!).getByText('Did not pass')).toHaveClass('timeline-run-state--failed');
    const gate = screen.getByText('Approval decision').closest('li');
    expect(within(gate!).getByText('Skipped')).toHaveClass('timeline-run-state--cancelled');
    const posted = screen.getByText('Reply posted').closest('li');
    expect(within(posted!).getAllByText('Failed').length).toBeGreaterThan(0);
  });

  it('offers the approve verb when a run is waiting on the owner (D21)', async () => {
    renderTimeline();
    await screen.findByText('Waiting on you');
    const cta = screen.getByRole('link', { name: 'Approve or edit the draft' });
    expect(cta).toHaveAttribute('href', '/dashboard/reviews');
    expect(
      screen.getByText('This reply is waiting for you — nothing posts until you approve it.'),
    ).toBeInTheDocument();
  });

  it('keeps the back link in the loading state (D21)', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(() => {})));
    render(
      <QueryClientProvider client={client}>
        <TimelineContent reviewId="review-1" />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('link', { name: /back to reviews/i })).toHaveAttribute(
      'href',
      '/dashboard/reviews',
    );
  });

  it('keeps the back link in the error state (D21)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'not_found' }, 404)));
    render(
      <QueryClientProvider client={client}>
        <TimelineContent reviewId="review-1" from="dashboard" />
      </QueryClientProvider>,
    );
    await screen.findByText('Unable to load this timeline');
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('honors ?from= against a closed allowlist and falls back to the queue (D21)', async () => {
    renderTimeline(makeTimeline(), 'history');
    expect(await screen.findByRole('link', { name: /back to all reviews/i })).toHaveAttribute(
      'href',
      '/dashboard/reviews/history',
    );
    expect(resolveBackLink('dashboard')).toEqual({ href: '/dashboard', label: 'Back to dashboard' });
    expect(resolveBackLink('https://evil.example')).toEqual(resolveBackLink(null));
    expect(resolveBackLink('toString')).toEqual(resolveBackLink(undefined));
    expect(resolveBackLink(null).href).toBe('/dashboard/reviews');
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

  it('collapses the posted + auto-posted outcome pair into one auto-posted chip', async () => {
    renderTimeline(makeTimeline({
      runs: [
        {
          id: 'run-auto',
          status: 'completed',
          startedAt: '2026-07-12T10:00:00.000Z',
          endedAt: '2026-07-12T10:05:00.000Z',
          error: null,
          displayState: 'completed',
          steps: [],
          outcomes: [
            {
              outcomeKind: 'reply_posted',
              attributedAgent: 'reply',
              occurredAt: '2026-07-12T10:04:00.000Z',
            },
            {
              outcomeKind: 'reply_auto_posted',
              attributedAgent: 'reply',
              occurredAt: '2026-07-12T10:04:00.000Z',
            },
          ],
        },
      ],
    }));

    expect(await screen.findByText('Reply auto-posted')).toBeInTheDocument();
    expect(screen.queryByText('Reply posted')).toBeNull();
  });

  it('still renders the generic posted chip for an owner-approved post', async () => {
    renderTimeline(makeTimeline({
      runs: [
        {
          id: 'run-owner',
          status: 'completed',
          startedAt: '2026-07-12T10:00:00.000Z',
          endedAt: '2026-07-12T10:05:00.000Z',
          error: null,
          displayState: 'completed',
          steps: [],
          outcomes: [
            {
              outcomeKind: 'reply_posted',
              attributedAgent: 'reply',
              occurredAt: '2026-07-12T10:04:00.000Z',
            },
          ],
        },
      ],
    }));

    expect(await screen.findByText('Reply posted')).toBeInTheDocument();
    expect(screen.queryByText('Reply auto-posted')).toBeNull();
  });

  it('shows the auto-post deadline banner with month and day for a future non-today deadline', async () => {
    const deadline = '2026-07-16T15:00:00.000Z';
    renderTimeline(makeTimeline({
      response: {
        ...makeTimeline().response!,
        status: 'approved',
        approvalMethod: 'auto_policy',
        autoPostScheduledAt: deadline,
      },
    }));
    await screen.findByRole('heading', { name: 'Morgan Lee' });

    const expected = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(deadline));
    expect(await screen.findByText(`Scheduled to auto-post at ${expected}`)).toBeInTheDocument();
    expect(
      screen.getByText('To cancel, use Cancel auto-post in the notification we sent you.'),
    ).toBeInTheDocument();
  });

  it('shows a time-only deadline when the auto-post is due later today', async () => {
    const deadline = '2026-07-13T15:00:00.000Z';
    renderTimeline(makeTimeline({
      response: {
        ...makeTimeline().response!,
        status: 'approved',
        approvalMethod: 'auto_policy',
        autoPostScheduledAt: deadline,
      },
    }));
    await screen.findByRole('heading', { name: 'Morgan Lee' });

    const expected = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(deadline));
    expect(await screen.findByText(`Scheduled to auto-post at ${expected}`)).toBeInTheDocument();
  });

  it('hides the scheduled banner once the deadline is in the past', async () => {
    renderTimeline(makeTimeline({
      response: {
        ...makeTimeline().response!,
        status: 'approved',
        approvalMethod: 'auto_policy',
        autoPostScheduledAt: '2026-07-13T11:00:00.000Z',
      },
    }));
    await screen.findByRole('heading', { name: 'Morgan Lee' });

    expect(screen.queryByText(/scheduled to auto-post/i)).toBeNull();
    expect(screen.queryByText(/to cancel, use cancel auto-post/i)).toBeNull();
  });

  it('hides the scheduled banner and posted-at fact when neither applies', async () => {
    renderTimeline();
    await screen.findByRole('heading', { name: 'Morgan Lee' });

    expect(screen.queryByText(/scheduled to auto-post/i)).toBeNull();
    expect(screen.queryByText(/to cancel, use cancel auto-post/i)).toBeNull();
    expect(screen.queryByText('Posted at')).toBeNull();
  });

  it('shows the viewer-local posted time once the reply is posted', async () => {
    const postedAt = '2026-07-12T18:30:00.000Z';
    renderTimeline(makeTimeline({
      response: {
        ...makeTimeline().response!,
        status: 'posted',
        approvalMethod: 'auto_policy',
        autoPostScheduledAt: null,
        postedAt,
      },
    }));
    await screen.findByRole('heading', { name: 'Morgan Lee' });

    const expected = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(postedAt));
    expect(screen.getByText('Posted at')).toBeInTheDocument();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('renders a structured failure reason next to the failed badge', async () => {
    renderTimeline(makeTimeline({
      runs: [
        {
          id: 'run-failed',
          status: 'failed',
          startedAt: '2026-07-08T10:00:00.000Z',
          endedAt: '2026-07-08T10:02:00.000Z',
          error: { reason: 'provider_terminal' },
          displayState: 'failed',
          steps: [],
          outcomes: [],
        },
      ],
    }));

    await screen.findByText('Failed');
    expect(screen.getByText('Provider terminal')).toBeInTheDocument();
  });

  it('renders a generic short reason when the failed run error has no usable reason', async () => {
    renderTimeline(makeTimeline({
      runs: [
        {
          id: 'run-failed',
          status: 'failed',
          startedAt: '2026-07-08T10:00:00.000Z',
          endedAt: '2026-07-08T10:02:00.000Z',
          error: { code: 500, detail: { raw: 'never dump this JSON' } },
          displayState: 'failed',
          steps: [],
          outcomes: [],
        },
      ],
    }));

    await screen.findByText('Failed');
    expect(screen.getByText('This run hit an unexpected error.')).toBeInTheDocument();
    expect(screen.queryByText(/never dump this JSON/)).toBeNull();
    expect(screen.queryByText(/\{/)).toBeNull();
  });

  it('renders no reason line when a failed run has a null error', async () => {
    renderTimeline(makeTimeline({
      runs: [
        {
          id: 'run-failed',
          status: 'failed',
          startedAt: '2026-07-08T10:00:00.000Z',
          endedAt: '2026-07-08T10:02:00.000Z',
          error: null,
          displayState: 'failed',
          steps: [],
          outcomes: [],
        },
      ],
    }));

    await screen.findByText('Failed');
    expect(document.querySelector('.timeline-run__error')).toBeNull();
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
