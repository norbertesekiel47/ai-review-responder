import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LegalDoc } from '@/lib/legal/content';
import { legalDocs } from '@/lib/legal/content';
import { LegalPage } from '../LegalPage';

vi.mock('@/lib/auth/flags', () => ({ selfServeSignupEnabled: () => false }));
vi.mock('@/lib/payments/flags', () => ({ trialEnabled: () => false }));
vi.mock('@/components/ui/PageShell', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PageShell: ({ children }: { children: import('react').ReactNode }) =>
      React.createElement('div', null, children),
  };
});

function render(doc: LegalDoc): string {
  return renderToStaticMarkup(createElement(LegalPage, { doc }));
}

describe('LegalPage meta line (M23)', () => {
  it('says the effective date once, in words, when the version is the same date', () => {
    const html = render(legalDocs.privacy);
    expect(html).toContain('Effective 9 June 2026');
    expect(html).not.toContain('Version');
    expect(html).not.toContain('2026-06-09');
    expect(html).not.toContain(' - Effective');
  });

  it('adds the version only when it differs from the effective date', () => {
    const html = render({ ...legalDocs.terms, version: 'v3', effectiveDate: '2026-06-09' });
    expect(html).toContain('Effective 9 June 2026 · Version v3');
  });

  it('renders every published document with the same meta line', () => {
    for (const doc of Object.values(legalDocs)) {
      const html = render(doc);
      expect(html).toContain('<h1');
      expect(html).toContain('Effective 9 June 2026');
    }
  });
});
