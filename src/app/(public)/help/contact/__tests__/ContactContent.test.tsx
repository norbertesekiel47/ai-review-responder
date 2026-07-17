import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ContactContent } from '../ContactContent';

vi.mock('@/components/ui/PageShell', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PageShell: ({ children }: { children: import('react').ReactNode }) =>
      React.createElement('div', null, children),
  };
});

describe('ContactContent', () => {
  it('renders a clickable mailto link for every support channel', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).toContain('href="mailto:support@repworth.net"');
    expect(html).toContain('href="mailto:billing@repworth.net"');
    expect(html).toContain('href="mailto:security@repworth.net"');
  });

  it('describes current-plan support without unsupported tier-specific SLAs', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).toContain('Copilot and Autopilot support is available');
    expect(html).not.toContain('business hours');
    expect(html).toContain('Importing locations by CSV');
  });

  it('offers a branded way back to RepWorth', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).toContain('Back to RepWorth');
    expect(html).toContain('href="/"');
  });

  it('uses only brand tokens (no prototype gray/blue/amber/yellow)', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).not.toContain('bg-gray-50');
    expect(html).not.toContain('bg-blue-');
    expect(html).not.toContain('amber');
    expect(html).not.toContain('text-yellow-');
  });

  it('has exactly one h1 (no heading-level skips)', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html.match(/<h1/g)?.length).toBe(1);
    // Channel + panel headings are all h2 — no h3 jump under the single h1.
    expect(html).not.toContain('<h3');
  });
});
