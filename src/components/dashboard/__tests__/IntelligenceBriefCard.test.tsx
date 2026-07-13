// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntelligenceBriefCard } from '@/components/dashboard/kpi/IntelligenceBriefCard';

describe('IntelligenceBriefCard persona attribution', () => {
  it('labels the brief as work from the Insights agent', () => {
    render(<IntelligenceBriefCard brief={{
      text: 'Customers praised the quick service.',
      type: 'weekly',
      periodLabel: 'Jul 6–12',
    }} />);

    expect(screen.getByText('Insights agent')).toBeInTheDocument();
    expect(screen.getByText(/weekly summary/i)).toBeInTheDocument();
  });
});
