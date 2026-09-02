// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StatTile } from '../StatTile';
import { ErrorState } from '../states';

describe('StatTile', () => {
  it('renders label, value, and sub text', () => {
    render(<StatTile label="Today" value="$4.12" sub="vs yesterday" />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('$4.12')).toBeInTheDocument();
    expect(screen.getByText('vs yesterday')).toBeInTheDocument();
  });

  it('applies the alert variant border', () => {
    const { container } = render(<StatTile label="At risk" value={2} alert />);
    expect(container.firstElementChild?.className).toContain('border-red-300');
  });

  it('is a plain div without href — nothing to click, no link role', () => {
    render(<StatTile label="Cost" value="$1" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  // X13: an alert tile IS the alert, so it is also the way to the work.
  it('becomes a link to the resolving page when href is given, keeping the alert frame', () => {
    render(<StatTile label="Failed Jobs" value={3} alert href="/admin/jobs" />);
    const link = screen.getByRole('link', { name: /Failed Jobs/ });
    expect(link).toHaveAttribute('href', '/admin/jobs');
    expect(link).toHaveTextContent('3');
    expect(link.className).toContain('border-red-300');
  });

  it('renders the label at 11px gray-600, not the 10px gray-500 that failed contrast (X31)', () => {
    render(<StatTile label="Pending" value={1} />);
    const label = screen.getByText('Pending');
    expect(label.className).toContain('text-[11px]');
    expect(label.className).toContain('text-gray-600');
    expect(label.className).not.toContain('text-gray-500');
  });
});

describe('ErrorState', () => {
  it('names the failed request and wires Retry', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="Couldn't load jobs"
        detail="GET /api/admin/jobs failed (500)"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Couldn't load jobs")).toBeInTheDocument();
    expect(screen.getByText('GET /api/admin/jobs failed (500)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
