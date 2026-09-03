import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Terms of Service',
  description: 'The RepWorth Terms of Service.',
};

export default function TermsLegalPage() {
  return <LegalPage doc={legalDocs.terms} />;
}
