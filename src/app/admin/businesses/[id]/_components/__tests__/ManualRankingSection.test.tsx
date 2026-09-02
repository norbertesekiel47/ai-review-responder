// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ManualRankingSection } from '../ManualRankingSection';

function renderSection(snapshots: Parameters<typeof ManualRankingSection>[0]['snapshots']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ManualRankingSection businessId="biz-1" snapshots={snapshots} />
    </QueryClientProvider>,
  );
}

const snapshot = (source: string) => ({
  keyword: 'plumber downtown',
  rankPosition: 3,
  snapshotDate: '2026-08-01',
  source,
});

describe('ManualRankingSection', () => {
  // X27: the detail page's CollapsibleSection owns the card and the heading;
  // this component renders only the body, so the section is not double-framed.
  it('renders the body only — no card chrome and no heading of its own', () => {
    const { container } = renderSection([]);
    expect(container.querySelector('section')).toBeNull();
    expect(container.querySelector('h2')).toBeNull();
    expect(screen.getByText('No ranking data yet.')).toBeInTheDocument();
    expect(screen.getByLabelText('Keyword')).toBeInTheDocument();
  });

  // Source chips: ink for an automated read, neutral for manual — the console's
  // gray/ink pair, no off-palette purple, and no gray text on a colour.
  it('renders the provenance chip in the console palette', () => {
    renderSection([snapshot('serpapi'), { ...snapshot('manual'), keyword: 'dentist near me' }]);

    expect(screen.getByText('serpapi').className).toContain('bg-gray-900');
    expect(screen.getByText('manual').className).toContain('bg-gray-100');
    expect(document.body.innerHTML).not.toMatch(/purple/);
  });
});
