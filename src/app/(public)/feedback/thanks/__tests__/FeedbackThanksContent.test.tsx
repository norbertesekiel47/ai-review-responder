import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FeedbackThanksContent } from '../FeedbackThanksContent';

vi.mock('@/components/ui/PageShell', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PageShell: ({ children }: { children: import('react').ReactNode }) =>
      React.createElement('div', null, children),
  };
});

describe('FeedbackThanksContent', () => {
  it('confirms the feedback and offers a way back to RepWorth', () => {
    const html = renderToStaticMarkup(createElement(FeedbackThanksContent));
    expect(html).toContain('Thank you');
    expect(html).toContain('Your feedback has been recorded');
    expect(html).toContain('Back to RepWorth');
    expect(html).toContain('href="/"');
    expect(html).toContain('RepWorth');
  });

  it('uses only brand tokens (no gray/blue prototype styling)', () => {
    const html = renderToStaticMarkup(createElement(FeedbackThanksContent));
    expect(html).not.toContain('bg-gray-50');
    expect(html).not.toContain('bg-blue-');
  });
});
