// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoListItem } from '@/lib/demos/types';

// PlaceAutocomplete boots the Google Maps loader in an effect; stub the module
// so this suite exercises the demos list, not the loader.
vi.mock('@googlemaps/js-api-loader', () => ({
  importLibrary: vi.fn(async () => ({})),
  setOptions: vi.fn(),
}));

import { DemosClient, PICK_A_PLACE_COPY } from '../DemosClient';

function demo(overrides: Partial<DemoListItem> = {}): DemoListItem {
  return {
    id: 'demo-1',
    slug: 'bella-italia-abc123',
    businessName: 'Bella Italia',
    generationStatus: 'completed',
    generationError: null,
    viewCount: 4,
    createdAt: '2026-08-01T12:30:00.000Z',
    expiresAt: '2026-09-01T12:30:00.000Z',
    ...overrides,
  };
}

function renderClient(initialData: DemoListItem[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DemosClient initialData={initialData} />
    </QueryClientProvider>,
  );
}

describe('DemosClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify([demo()]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });

  it('renders a completed demo with its /demo/<slug> link and Copy Link button', () => {
    renderClient([demo()]);

    expect(screen.getByText('Bella Italia')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '/demo/bella-italia-abc123' });
    expect(link).toHaveAttribute('href', '/demo/bella-italia-abc123');
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeInTheDocument();
    // X9: the demo vocabulary of the shared StatusBadge — humanized, not the raw token.
    expect(screen.getByText('Completed')).toHaveAttribute('data-vocab', 'demo');
    expect(screen.queryByText('completed')).not.toBeInTheDocument();
  });

  it('renders a failed demo with its generationError and no Copy Link', () => {
    renderClient([
      demo({
        id: 'demo-2',
        generationStatus: 'failed',
        generationError: 'SerpAPI returned no reviews',
      }),
    ]);

    expect(screen.getByText('Failed')).toHaveAttribute('data-vocab', 'demo');
    expect(screen.getByText('SerpAPI returned no reviews')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Link' })).not.toBeInTheDocument();
  });

  it('pulses a running demo through the shared badge', () => {
    renderClient([demo({ id: 'demo-3', generationStatus: 'running' })]);
    expect(screen.getByText('Running').className).toContain('animate-pulse');
  });

  // ── X23: the generate form is a form ─────────────────────────────────

  function stubGenerateFetch(list: DemoListItem[] = [demo()]) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        const body = init?.method === 'POST' ? { id: 'demo-new' } : list;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return calls;
  }

  it('submits through a real form (Enter submits, the button is type=submit) and shows "Demo queued"', async () => {
    const user = userEvent.setup();
    const calls = stubGenerateFetch();
    renderClient([]);

    const submit = screen.getByRole('button', { name: 'Generate Demo' });
    expect(submit).toHaveAttribute('type', 'submit');
    expect(submit.closest('form')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Or paste a Google Maps URL' }));
    await user.type(screen.getByLabelText('Business Location'), 'https://www.google.com/maps/place/x');
    await user.type(screen.getByLabelText('Business Name'), 'Bella Italia{Enter}');

    await waitFor(() => {
      expect(calls.some((c) => c.init?.method === 'POST')).toBe(true);
    });
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toBe('/api/admin/demos/generate');
    expect(JSON.parse(String(post.init?.body))).toEqual({
      googleMapsUrl: 'https://www.google.com/maps/place/x',
      businessName: 'Bella Italia',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Demo queued for Bella Italia');
    // Fields reset for the next one.
    expect(screen.getByLabelText('Business Name')).toHaveValue('');
  });

  it('refuses to submit in search mode until a place is picked, without a request', async () => {
    const user = userEvent.setup();
    const calls = stubGenerateFetch();
    renderClient([]);

    await user.type(screen.getByLabelText('Business Name'), 'Bella Italia');
    await user.click(screen.getByRole('button', { name: 'Generate Demo' }));

    // getByText, not getByRole('alert'): the stubbed Maps loader also raises
    // PlaceAutocomplete's own load-error alert in this environment.
    expect(screen.getByText(PICK_A_PLACE_COPY)).toHaveAttribute('role', 'alert');
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('renders the empty state when no demos exist', () => {
    renderClient([]);

    expect(screen.getByText('No demos generated yet')).toBeInTheDocument();
    expect(screen.getByText('Use the form above to create one.')).toBeInTheDocument();
  });

  // Source-level guards for the two SSR/lifecycle fixes made when this tree
  // moved behind a server page. Neither is observable through the DOM: jsdom
  // always has a `window`, and React 19 no longer warns on a post-unmount
  // setState — so a regression would only show up in production.
  describe('SSR + lifecycle safety', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/admin/demos/DemosClient.tsx'),
      'utf-8',
    );

    it('reads window.location only inside handleCopy, never during render', () => {
      const handlerIndex = source.indexOf('const handleCopy');
      expect(handlerIndex).toBeGreaterThan(-1);
      const windowReads = [...source.matchAll(/window\.location/g)].map((m) => m.index!);
      expect(windowReads.length).toBeGreaterThan(0);
      for (const index of windowReads) {
        expect(index).toBeGreaterThan(handlerIndex);
      }
    });

    it('clears the "Copied!" timeout on unmount', () => {
      expect(source).toContain('clearTimeout(copiedTimer.current)');
      expect(source).toMatch(/useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>/);
    });
  });
});
