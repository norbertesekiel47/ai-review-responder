import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export default function TermsLegalPage() {
  return <LegalPage doc={legalDocs.terms} />;
}
