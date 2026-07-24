// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { VoiceReportCard } from '../VoiceReportCard';

interface ReportCardBody {
  activationThreshold: number;
  editedCount: number;
  activated: boolean;
  traits: Array<{
    key: string;
    name: string;
    claim: string;
    snippet: { before: string; after: string };
  }>;
  fallbackSnippet: { before: string; after: string } | null;
}

function jsonResponse(body: ReportCardBody, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

const PRE_ACTIVATION: ReportCardBody = {
  activationThreshold: 5,
  editedCount: 2,
  activated: false,
  traits: [],
  fallbackSnippet: null,
};

describe('VoiceReportCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the settings skeleton while the report card is loading', () => {
    // Never-resolving fetch keeps the component in its loading state.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    render(<VoiceReportCard locationId="loc-1" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading settings…');
    // The always-mounted live region announces nothing while loading.
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('shows a visible error and announces it assertively when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 500 })),
    );

    render(<VoiceReportCard locationId="loc-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load your voice report card.',
    );
    // Rendered twice: once in the live region, once as the visible paragraph.
    expect(screen.getAllByText('Could not load your voice report card.')).toHaveLength(2);
  });

  it('renders pre-activation progress dots and copy before the threshold is reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(PRE_ACTIVATION)));

    render(<VoiceReportCard locationId="loc-1" />);

    expect(
      await screen.findByRole('img', { name: '2 of 5 edited replies' }),
    ).toBeInTheDocument();
    expect(screen.getByText('2 of 5 edited replies.')).toBeInTheDocument();
    expect(
      screen.getByText(/Only replies you've edited and posted count/),
    ).toBeInTheDocument();
  });

  it('renders each detected trait with its claim and before/after snippet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          activationThreshold: 5,
          editedCount: 6,
          activated: true,
          traits: [
            {
              key: 'greeting',
              name: 'Greeting',
              claim: 'You open with “Hi” — never “Dear.”',
              snippet: {
                before: 'Dear Amanda, thank you so much.',
                after: 'Hi Amanda — thanks so much!',
              },
            },
            {
              key: 'point_of_view',
              name: 'Point of view',
              claim: 'You write as “I,” not “we.”',
              snippet: {
                before: 'We are so glad you enjoyed it.',
                after: 'I am so glad you enjoyed it.',
              },
            },
          ],
          fallbackSnippet: null,
        }),
      ),
    );

    render(<VoiceReportCard locationId="loc-1" />);

    expect(await screen.findByText('Greeting')).toBeInTheDocument();
    expect(screen.getByText('You open with “Hi” — never “Dear.”')).toBeInTheDocument();
    expect(screen.getByText('Dear Amanda, thank you so much.')).toBeInTheDocument();
    expect(screen.getByText('Hi Amanda — thanks so much!')).toBeInTheDocument();

    expect(screen.getByText('Point of view')).toBeInTheDocument();
    expect(screen.getByText('You write as “I,” not “we.”')).toBeInTheDocument();
    expect(screen.getByText('We are so glad you enjoyed it.')).toBeInTheDocument();
    expect(screen.getByText('I am so glad you enjoyed it.')).toBeInTheDocument();

    // One Draft/Your edit label pair per trait snippet.
    expect(screen.getAllByText('Draft')).toHaveLength(2);
    expect(screen.getAllByText('Your edit')).toHaveLength(2);
  });

  it('renders the zero-trait fallback line and snippet when activated with no traits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          activationThreshold: 5,
          editedCount: 7,
          activated: true,
          traits: [],
          fallbackSnippet: {
            before: 'Thanks for visiting us.',
            after: 'We appreciate you stopping by.',
          },
        }),
      ),
    );

    render(<VoiceReportCard locationId="loc-1" />);

    expect(
      await screen.findByText(/You've edited 7 replies — no consistent pattern stands out yet\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Thanks for visiting us.')).toBeInTheDocument();
    expect(screen.getByText('We appreciate you stopping by.')).toBeInTheDocument();
  });

  it('re-fetches for the new location when locationId changes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(PRE_ACTIVATION))
      .mockResolvedValueOnce(jsonResponse({ ...PRE_ACTIVATION, editedCount: 4 }));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<VoiceReportCard locationId="loc-1" />);
    expect(await screen.findByText('2 of 5 edited replies.')).toBeInTheDocument();

    rerender(<VoiceReportCard locationId="loc-2" />);
    expect(await screen.findByText('4 of 5 edited replies.')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/settings/voice/report-card?locationId=loc-1',
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/settings/voice/report-card?locationId=loc-2',
    );
  });
});
