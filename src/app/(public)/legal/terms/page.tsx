import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export const metadata: Metadata = {
  title: 'Terms of Service · RepWorth',
  description: 'The RepWorth Terms of Service.',
};

export default function TermsLegalPage() {
  return <LegalPage doc={legalDocs.terms} />;
}
