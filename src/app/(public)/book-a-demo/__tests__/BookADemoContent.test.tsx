import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BookADemoContent } from '../BookADemoContent';

vi.mock('@/components/ui/PageShell', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PageShell: ({ children }: { children: import('react').ReactNode }) =>
      React.createElement('div', null, children),
  };
});

describe('BookADemoContent', () => {
  it('renders the book-a-demo route as an early access page under the one CTA phrase', () => {
    const html = renderToStaticMarkup(createElement(BookADemoContent));

    expect(html).toContain('Get early access to RepWorth');
    expect(html).toContain('value="book-a-demo"');
    expect(html).toContain('value="waitlist"');
    // The submit button carries the same phrase as the h1 and the nav pills.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Get early access</);
    expect(html).not.toContain('Join the waitlist');
    expect(html).not.toContain('Join waitlist');
    expect(html).not.toContain('early access waitlist');
    expect(html).not.toContain('(placeholder)');
    expect(html).not.toContain('Local restaurant owner');
    expect(html).not.toContain('12% to 100%');
    expect(html).not.toContain('â€”');
    expect(html).not.toContain('Book your demo');
    expect(html).not.toContain('Takes 15 minutes');
  });

  it('does not imply demos were once bookable', () => {
    const html = renderToStaticMarkup(createElement(BookADemoContent));
    expect(html).toContain('offer you a walkthrough when demos open');
    expect(html).not.toContain('bookings reopen');
  });

  it('renders the footer unwrapped, as a sibling straight after main', () => {
    const html = renderToStaticMarkup(createElement(BookADemoContent));
    expect(html).toMatch(/<\/main><footer class="rw-foot rw-foot-dl"/);
  });
});
