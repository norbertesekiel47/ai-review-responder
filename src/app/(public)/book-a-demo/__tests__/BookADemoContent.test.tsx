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
  it('renders the book-a-demo route as an early access waitlist page', () => {
    const html = renderToStaticMarkup(createElement(BookADemoContent));

    expect(html).toContain('Join the RepWorth early access waitlist');
    expect(html).toContain('value="book-a-demo"');
    expect(html).toContain('value="waitlist"');
    expect(html).toContain('Join waitlist');
    expect(html).not.toContain('Book your demo');
    expect(html).not.toContain('Takes 15 minutes');
  });
});
