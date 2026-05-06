import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeadIntakeForm } from '../LeadIntakeForm';

describe('LeadIntakeForm', () => {
  it('renders waitlist copy wired to the landing source', () => {
    const html = renderToStaticMarkup(
      createElement(LeadIntakeForm, { intent: 'waitlist', source: 'landing' }),
    );

    expect(html).toContain('Join waitlist');
    expect(html).toContain('name="intent"');
    expect(html).toContain('value="waitlist"');
    expect(html).toContain('name="source"');
    expect(html).toContain('value="landing"');
    expect(html).not.toContain('Book a Demo');
    expect(html).not.toContain('Book My Demo');
  });

  it('renders custom demo copy wired to the book-a-demo source', () => {
    const html = renderToStaticMarkup(
      createElement(LeadIntakeForm, {
        intent: 'demo',
        source: 'book-a-demo',
        tone: 'light',
        copy: {
          button: 'Request demo',
          successHeading: 'Request received.',
          successBody: 'We will reach out to coordinate a demo.',
        },
      }),
    );

    expect(html).toContain('Request demo');
    expect(html).toContain('value="demo"');
    expect(html).toContain('value="book-a-demo"');
  });
});
