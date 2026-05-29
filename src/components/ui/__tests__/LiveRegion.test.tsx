import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveRegion } from '../LiveRegion';

describe('LiveRegion', () => {
  it('defaults to a polite status region carrying the message', () => {
    const html = renderToStaticMarkup(<LiveRegion message="Settings saved" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain('Settings saved');
  });

  it('renders an assertive alert region when level="assertive"', () => {
    const html = renderToStaticMarkup(
      <LiveRegion message="Could not save" level="assertive" />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('Could not save');
  });

  it('renders an empty but present region for an empty message', () => {
    const html = renderToStaticMarkup(<LiveRegion message="" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
