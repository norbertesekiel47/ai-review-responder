// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FunnelStepThread } from '../FunnelStepThread';

describe('FunnelStepThread', () => {
  it('marks exactly one milestone with aria-current="step" and shows its number', () => {
    const { container } = render(<FunnelStepThread step="plan" />);
    const current = container.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('3'); // Plan is the 3rd milestone
  });

  it('renders earlier milestones as done (✓) and keeps later ones numbered', () => {
    const { queryAllByText, getByText } = render(<FunnelStepThread step="plan" />);
    expect(queryAllByText('✓')).toHaveLength(2); // Find business + Preview
    expect(getByText('4')).toBeInTheDocument(); // Set up still numbered (todo)
    expect(getByText('Set up')).toBeInTheDocument();
  });

  it('marks the first milestone current and shows no checks when step="find"', () => {
    const { container, queryAllByText } = render(<FunnelStepThread step="find" />);
    const current = container.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('1');
    expect(queryAllByText('✓')).toHaveLength(0);
  });

  it('marks every prior milestone done when step="setup"', () => {
    const { queryAllByText } = render(<FunnelStepThread step="setup" />);
    expect(queryAllByText('✓')).toHaveLength(3); // Find + Preview + Plan
  });
});
