// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrackedKeywordsSection } from '../TrackedKeywordsSection';

describe('TrackedKeywordsSection', () => {
  // X27: the detail page's CollapsibleSection owns the card and the heading.
  it('renders the body only — chips, the add control, no card chrome and no heading', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <TrackedKeywordsSection businessId="biz-1" keywords={['best tacos']} />
      </QueryClientProvider>,
    );

    expect(container.querySelector('section')).toBeNull();
    expect(container.querySelector('h2')).toBeNull();
    expect(screen.getByText('best tacos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove best tacos' })).toBeInTheDocument();
    expect(screen.getByLabelText('New tracked keyword')).toBeInTheDocument();
  });
});
