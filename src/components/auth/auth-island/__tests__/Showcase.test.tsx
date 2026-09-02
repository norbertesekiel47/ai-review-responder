import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Showcase } from '../Showcase';

describe('Showcase', () => {
  it('renders signup copy when mode is signup', () => {
    const html = renderToStaticMarkup(createElement(Showcase, { mode: 'signup' }));
    expect(html).toContain('Get started in a few minutes');
    expect(html).toContain('reply it deserves');
  });
  it('renders login copy when mode is login', () => {
    const html = renderToStaticMarkup(createElement(Showcase, { mode: 'login' }));
    expect(html).toContain('Welcome back');
    expect(html).toContain('inbox is quiet');
  });
  it('shows no fabricated live stats — only truthful static statements (A21)', () => {
    for (const mode of ['signup', 'login'] as const) {
      const html = renderToStaticMarkup(createElement(Showcase, { mode }));
      expect(html).not.toMatch(/127 reviews|15h|96%|60s|poll cadence|saving 15 hours/);
      expect(html).toContain('You approve');
      expect(html).toContain('before anything posts');
    }
  });
});
