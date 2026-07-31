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
