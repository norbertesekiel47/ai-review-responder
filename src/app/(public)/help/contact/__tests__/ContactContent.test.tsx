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
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    // Checks the actual rule: a heading may go one level deeper than the last,
    // never more. This replaced a `not.toContain('<h3')` proxy, which stood in
    // for "no skips" while the footer used h4 — so it forbade the h3 that
    // REMOVES the h2 -> h4 skip, i.e. it defended the bug.
    const skips = levels.flatMap((level, i) => {
      const previous = levels[i - 1];
      return previous !== undefined && level > previous + 1 ? [`h${previous} → h${level}`] : [];
    });
    expect(skips).toEqual([]);
  });
});
