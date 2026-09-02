// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatRelative, RelativeTime } from '../RelativeTime';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe('formatRelative', () => {
  it('is pure over `now` and walks the m/h/d ladder', () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z');
    expect(formatRelative('2026-08-01T11:59:30.000Z', now)).toBe('just now');
    expect(formatRelative('2026-08-01T11:15:00.000Z', now)).toBe('45m ago');
    expect(formatRelative('2026-08-01T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelative('2026-07-29T12:00:00.000Z', now)).toBe('3d ago');
  });
});

describe('RelativeTime', () => {
  it('renders the relative label on the client, with the absolute UTC time as the title', () => {
    render(<RelativeTime value={minutesAgo(45)} />);
    const time = screen.getByText('45m ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('title', expect.stringMatching(/UTC$/));
    expect(time).toHaveAttribute('dateTime');
  });

  // X29: the server has no "now" worth rendering. It prints the absolute UTC
  // date — the same bytes the hydrating client render produces — so the two
  // renders never disagree on a relative label computed at different instants.
  it('renders the absolute UTC date on the server instead of a clock-dependent label', () => {
    const html = renderToStaticMarkup(<RelativeTime value="2026-08-01T12:30:00.000Z" />);
    expect(html).toContain('Aug 1, 2026 UTC');
    expect(html).not.toMatch(/ago|just now/);
  });

  it('renders the fallback for null, undefined and unparseable values', () => {
    const { unmount } = render(<RelativeTime value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    unmount();
    render(<RelativeTime value="not a date" fallback="Never" />);
    expect(screen.getByText('Never')).toBeInTheDocument();
  });
});
