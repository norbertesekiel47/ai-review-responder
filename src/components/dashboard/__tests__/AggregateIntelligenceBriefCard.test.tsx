// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AggregateIntelligenceBriefCard } from '@/components/dashboard/aggregate/AggregateIntelligenceBriefCard';
import type { PerLocationBrief } from '@/lib/dashboard/types';

const WEEKLY_BRIEF: PerLocationBrief = {
  locationId: 'loc-1',
  displayName: 'Bristol Bay Coffee',
  brief: {
    text: '- Customers praised the quick service.\n- Several mentions of friendly staff.',
    type: 'weekly',
    periodLabel: 'Jul 6–12',
  },
};

const MONTHLY_BRIEF: PerLocationBrief = {
  locationId: 'loc-2',
  displayName: 'Bristol Bay Roastery',
  brief: {
    text: '- Espresso quality called out repeatedly.',
    type: 'monthly',
    periodLabel: 'July',
  },
};

describe('AggregateIntelligenceBriefCard', () => {
  it('renders nothing when there are no briefs', () => {
    const { container } = render(<AggregateIntelligenceBriefCard perLocationBriefs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a single brief like the single-location card', () => {
    render(<AggregateIntelligenceBriefCard perLocationBriefs={[WEEKLY_BRIEF]} />);

    expect(screen.getByText('Jul 6–12')).toBeInTheDocument();
    expect(screen.getByText(/weekly summary/)).toBeInTheDocument();
    expect(screen.getByText('Customers praised the quick service.')).toBeInTheDocument();
    expect(screen.queryByText('All Locations')).not.toBeInTheDocument();
  });

  it('groups multiple briefs by location with period labels per cadence', () => {
    render(
      <AggregateIntelligenceBriefCard
        perLocationBriefs={[
          WEEKLY_BRIEF,
          MONTHLY_BRIEF,
          { locationId: 'loc-3', displayName: 'No Brief Yet', brief: null },
        ]}
      />,
    );

    expect(screen.getByText('All Locations')).toBeInTheDocument();
    expect(screen.getByText('3 locations')).toBeInTheDocument();
    expect(screen.getByText('Bristol Bay Coffee')).toBeInTheDocument();
    expect(screen.getByText('weekly · Jul 6–12')).toBeInTheDocument();
    expect(screen.getByText('Bristol Bay Roastery')).toBeInTheDocument();
    expect(screen.getByText('monthly · July')).toBeInTheDocument();
    expect(screen.getByText('Espresso quality called out repeatedly.')).toBeInTheDocument();
    expect(screen.queryByText('No Brief Yet')).not.toBeInTheDocument();
  });
});
