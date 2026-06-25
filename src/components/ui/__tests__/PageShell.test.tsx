import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageShell } from '../PageShell';

describe('PageShell', () => {
  it('defaults the island to max-w-5xl and renders its children', () => {
    const html = renderToStaticMarkup(<PageShell sections={[]}>island-child</PageShell>);
    expect(html).toContain('max-w-5xl');
    expect(html).toContain('island-child');
  });

  it('applies a custom island max-width when provided', () => {
    const html = renderToStaticMarkup(
      <PageShell sections={[]} maxWidthClassName="max-w-md">x</PageShell>,
    );
    expect(html).toContain('max-w-md');
    expect(html).not.toContain('max-w-5xl');
  });

  it('renders dot-nav buttons as type="button" so they never submit a wrapping form', () => {
    const html = renderToStaticMarkup(
      <PageShell sections={[{ ref: { current: null }, label: 'Top' }]}>x</PageShell>,
    );
    expect(html).toContain('aria-label="Go to Top"');
    expect(html).toContain('type="button"');
  });

  it('gives dot-nav buttons a teal focus-visible ring', () => {
    const html = renderToStaticMarkup(
      <PageShell sections={[{ ref: { current: null }, label: 'Top' }]}>x</PageShell>,
    );
    expect(html).toContain('focus-visible:outline-rw-teal');
  });
});
