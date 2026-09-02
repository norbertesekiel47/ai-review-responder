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

  it('carries white numerals/checks on rw-teal-strong, never rw-teal (ADR 0004, A2)', () => {
    const { container } = render(<FunnelStepThread step="plan" />);
    const current = container.querySelector('[aria-current="step"]')!;
    expect(current.className).toContain('bg-rw-teal-strong');
    expect(current.className).not.toMatch(/(?:^|\s)bg-rw-teal(?=\s|$)/);
    for (const done of container.querySelectorAll('span.rounded-full')) {
      if (done.textContent === '✓') {
        expect(done.className).toContain('bg-rw-teal-strong');
      }
    }
  });

  it('marks every prior milestone done when step="setup"', () => {
    const { queryAllByText } = render(<FunnelStepThread step="setup" />);
    expect(queryAllByText('✓')).toHaveLength(3); // Find + Preview + Plan
  });
});
