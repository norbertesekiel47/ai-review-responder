// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { NeedsAttentionList } from '@/components/dashboard/NeedsAttentionList';
import { ESCALATION_STATUS } from '@/lib/escalations/types';
import {
  TRIAGE_SEVERITIES,
  TRIAGE_SEVERITY_LABELS,
  TRIAGE_SUGGESTED_ACTIONS,
} from '@/lib/reviews/triage-schema';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <NeedsAttentionList />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

const OPEN_STATUSES = [ESCALATION_STATUS.ESCALATED, ESCALATION_STATUS.ACKNOWLEDGED] as const;
const VOCABULARY_CASES = Array.from({
  length: Math.max(
    OPEN_STATUSES.length,
    TRIAGE_SEVERITIES.length,
    TRIAGE_SUGGESTED_ACTIONS.length,
  ),
}, (_, index) => ({
  status: OPEN_STATUSES[index % OPEN_STATUSES.length]!,
  severity: TRIAGE_SEVERITIES[index % TRIAGE_SEVERITIES.length]!,
  suggestedAction: TRIAGE_SUGGESTED_ACTIONS[index % TRIAGE_SUGGESTED_ACTIONS.length]!,
}));

describe('NeedsAttentionList', () => {
  it('renders the server-ordered escalation queue with review context and timeline links', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      totalOpen: 24,
      items: [
        {
          id: 'escalation-1',
          status: 'escalated',
          severity: 'high',
          suggestedAction: 'respond_and_escalate',
          createdAt: '2026-07-10T12:00:00.000Z',
          reviewId: 'review-high',
          businessName: 'Bristol Bay Coffee',
          reviewRating: 1,
        },
        {
          id: 'escalation-2',
          status: 'acknowledged',
          severity: 'medium',
          suggestedAction: 'escalate',
          createdAt: '2026-07-11T12:00:00.000Z',
          reviewId: 'review-medium',
          businessName: 'Harbor Roasters',
          reviewRating: 3,
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderList();

    expect(await screen.findByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getByText('High severity')).toBeInTheDocument();
    expect(screen.getByText('Medium severity')).toBeInTheDocument();
    expect(screen.getByText('Bristol Bay Coffee')).toBeInTheDocument();
    expect(screen.getByText('1/5 rating')).toBeInTheDocument();
    expect(screen.getByText('Respond and escalate')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 24 open escalations.')).toBeInTheDocument();

    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Open Bristol Bay Coffee review timeline',
      'Open Harbor Roasters review timeline',
    ]);
    expect(links[0]).toHaveAttribute('href', '/dashboard/reviews/review-high/timeline');
    expect(links[1]).toHaveAttribute('href', '/dashboard/reviews/review-medium/timeline');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/escalations',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('stays hidden while the account-wide request is pending', async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    const view = renderList();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders nothing after a successful empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ totalOpen: 0, items: [] })));

    const view = renderList();

    await waitFor(() => {
      expect(view.queryClient.getQueryState(['dashboard-open-escalations'])?.status)
        .toBe('success');
    });
    expect(view.container).toBeEmptyDOMElement();
  });

  it('stays hidden when the account-wide request fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(
      { error: 'Escalations unavailable' },
      { status: 500 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const view = renderList();

    await waitFor(() => {
      expect(view.queryClient.getQueryState(['dashboard-open-escalations'])?.status)
        .toBe('error');
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
  });

  it('rejects a contradictory total smaller than the returned item slice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      totalOpen: 0,
      items: [{
        id: 'escalation-1',
        status: ESCALATION_STATUS.ESCALATED,
        severity: 'high',
        suggestedAction: 'escalate',
        createdAt: '2026-07-10T12:00:00.000Z',
        reviewId: 'review-high',
        businessName: 'Bristol Bay Coffee',
        reviewRating: 1,
      }],
    })));

    const view = renderList();

    await waitFor(() => {
      expect(view.queryClient.getQueryState(['dashboard-open-escalations'])?.status)
        .toBe('error');
    });
    expect(view.container).toBeEmptyDOMElement();
  });

  it.each(VOCABULARY_CASES)(
    'accepts canonical $status / $severity / $suggestedAction vocabulary',
    async ({ status, severity, suggestedAction }) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
        totalOpen: 1,
        items: [{
          id: 'escalation-vocabulary',
          status,
          severity,
          suggestedAction,
          createdAt: '2026-07-10T12:00:00.000Z',
          reviewId: 'review-vocabulary',
          businessName: 'Canonical Cafe',
          reviewRating: 2,
        }],
      })));

      renderList();

      expect(await screen.findByText(TRIAGE_SEVERITY_LABELS[severity])).toBeInTheDocument();
      expect(screen.getByRole('link')).toHaveAttribute(
        'href',
        '/dashboard/reviews/review-vocabulary/timeline',
      );
    },
  );
});
