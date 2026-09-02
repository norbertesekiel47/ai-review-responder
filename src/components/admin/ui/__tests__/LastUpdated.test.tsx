// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LastUpdated } from '../LastUpdated';

describe('LastUpdated', () => {
  it('renders the UTC time of the last successful load with seconds', () => {
    render(
      <LastUpdated
        updatedAt={Date.parse('2026-09-02T14:03:27.000Z')}
        refreshing={false}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
    expect(screen.getByText('14:03:27 UTC')).toBeInTheDocument();
    expect(screen.getByText('14:03:27 UTC')).toHaveAttribute(
      'dateTime',
      '2026-09-02T14:03:27.000Z',
    );
  });

  it('treats react-query\'s 0 sentinel as "not loaded yet", never the epoch', () => {
    render(<LastUpdated updatedAt={0} refreshing={false} onRefresh={() => {}} />);
    expect(screen.getByText('Not loaded yet')).toBeInTheDocument();
    expect(screen.queryByText(/00:00:00/)).toBeNull();
  });

  it('calls onRefresh from the Refresh control', async () => {
    const onRefresh = vi.fn();
    render(<LastUpdated updatedAt={Date.now()} refreshing={false} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables the control and says so while a fetch is in flight', () => {
    render(<LastUpdated updatedAt={Date.now()} refreshing onRefresh={() => {}} />);
    const button = screen.getByRole('button', { name: 'Refreshing…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});
