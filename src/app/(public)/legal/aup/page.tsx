import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export const metadata: Metadata = {
  title: 'Acceptable Use Policy · RepWorth',
  description: 'The RepWorth Acceptable Use Policy.',
};

export default function AupLegalPage() {
  return <LegalPage doc={legalDocs.aup} />;
}
