// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

// jsdom lacks IntersectionObserver, which motion's whileInView relies on.
beforeAll(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

vi.mock('@/components/ui/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) =>
    createElement('div', { 'data-testid': 'page-shell' }, children),
}));
vi.mock('@/components/ui/SiteNav', () => ({
  SiteNav: () => createElement('nav', { 'data-testid': 'site-nav' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));

const { DemoViewerContent } = await import('../DemoViewerContent');

function makeResult(overrides: Partial<GenerationResult> = {}): GenerationResult {
  return {
    responseText: 'Thank you for the kind words!',
    language: 'en',
    provider: 'openai',
    model: 'gpt-4o-mini-2024-07-18',
    usage: { promptTokens: 0, completionTokens: 0 },
    costUsd: 0,
    apiCostId: null,
    ...overrides,
  };
}

const enReview: NormalizedReview = {
  reviewerName: 'Dan P.',
  starRating: 4,
  reviewText: 'Great coffee.',
  reviewDate: '2026-02-28',
  detectedLanguage: 'en',
};
const esReview: NormalizedReview = {
  reviewerName: 'Maria G.',
  starRating: 5,
  reviewText: '¡El mejor latte!',
  reviewDate: '2026-03-03',
  detectedLanguage: 'es',
};

describe('DemoViewerContent', () => {
  it('renders one card per review', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview, esReview],
        responses: [makeResult(), makeResult({ language: 'es', responseText: '¡Gracias!' })],
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText('Dan P.')).toBeInTheDocument();
    expect(screen.getByText('Maria G.')).toBeInTheDocument();
  });

  it('CTA links to /book-a-demo, not a mailto', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview],
        responses: [makeResult()],
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByRole('link', { name: /book a demo/i })).toHaveAttribute('href', '/book-a-demo');
  });

  it('hides the languages chip when every review and reply is English', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview],
        responses: [makeResult()],
        selfServeEnabled: false,
      }),
    );
    expect(screen.queryByText(/languages handled/i)).not.toBeInTheDocument();
  });

  it('shows the languages chip when a non-English language is present', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview, esReview],
        responses: [makeResult(), makeResult({ language: 'es' })],
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText('2 languages handled')).toBeInTheDocument();
  });

  it('labels the reply "RepWorth reply" and not "AI Response"', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview],
        responses: [makeResult()],
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText(/repworth reply/i)).toBeInTheDocument();
    expect(screen.queryByText(/ai response/i)).not.toBeInTheDocument();
  });
});
