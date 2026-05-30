import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export const metadata: Metadata = {
  title: 'Cookie Policy · RepWorth',
  description: 'How RepWorth uses cookies.',
};

export default function CookiesLegalPage() {
  return <LegalPage doc={legalDocs.cookies} />;
}
