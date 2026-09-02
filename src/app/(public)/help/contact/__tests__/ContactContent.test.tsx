import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ContactContent, helpTopicMailto } from '../ContactContent';

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

  it('promises no response-time targets in the page metadata either (M10)', () => {
    // File scan, like page-metadata.test.ts: importing the page pulls server-only flags.
    const src = readFileSync(resolve(process.cwd(), 'src/app/(public)/help/contact/page.tsx'), 'utf-8');
    expect(src).not.toMatch(/response-time|response time|targets by plan/i);
    // Bare title: the root layout's template appends " · RepWorth".
    expect(src).toMatch(/title:\s*'Contact support'/);
  });

  it('makes every common help topic a mailto to the right channel with a prefilled subject (M11)', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).toContain(
      'href="mailto:support@repworth.net?subject=Help%20connecting%20my%20Google%20Business%20Profile"',
    );
    expect(html).toContain('href="mailto:billing@repworth.net?subject=Billing%20question"');
    expect(html).toContain(
      'href="mailto:support@repworth.net?subject=Help%20importing%20locations%20by%20CSV"',
    );
    // No topic is left as a bare list item.
    expect(html).not.toMatch(/<li>Connecting your Google Business Profile<\/li>/);
    expect(html).not.toMatch(/<li>Billing and past-due recovery<\/li>/);
    expect(html).not.toMatch(/<li>Importing locations by CSV<\/li>/);
    expect(helpTopicMailto({ email: 'a@b.c', subject: 'Two words & more' })).toBe(
      'mailto:a@b.c?subject=Two%20words%20%26%20more',
    );
  });

  it('ends in a square-cornered band with the footer as its unwrapped sibling (M12)', () => {
    const html = renderToStaticMarkup(createElement(ContactContent));
    expect(html).not.toContain('rounded-b-[3rem]');
    expect(html).not.toMatch(/class="[^"]*rounded-b-/);
    expect(html).toMatch(/<\/section><footer class="rw-foot/);
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
