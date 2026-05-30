// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsSkeleton } from '../SettingsSkeleton';

describe('SettingsSkeleton', () => {
  it('renders an accessible busy status with shimmer rows', () => {
    const { container } = render(<SettingsSkeleton />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/loading settings/i)).toHaveClass('sr-only');
    expect(container.querySelectorAll('.settings-skeleton__row').length).toBeGreaterThanOrEqual(3);
  });
});
