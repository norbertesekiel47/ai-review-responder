import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Showcase } from '../Showcase';

describe('Showcase', () => {
  it('renders signup copy when mode is signup', () => {
    const html = renderToStaticMarkup(createElement(Showcase, { mode: 'signup' }));
    expect(html).toContain('Get started in 90 seconds');
    expect(html).toContain('reply it deserves');
  });
  it('renders login copy when mode is login', () => {
    const html = renderToStaticMarkup(createElement(Showcase, { mode: 'login' }));
    expect(html).toContain('Welcome home');
    expect(html).toContain('inbox is quiet');
  });
  it('renders the three stat tiles', () => {
    const html = renderToStaticMarkup(createElement(Showcase, { mode: 'signup' }));
    expect(html).toContain('15h');
    expect(html).toContain('96%');
    expect(html).toContain('60s');
  });
});
