import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Cookie Policy',
  description: 'How RepWorth uses cookies.',
};

export default function CookiesLegalPage() {
  return <LegalPage doc={legalDocs.cookies} />;
}
