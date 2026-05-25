import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export default function DpaLegalPage() {
  return <LegalPage doc={legalDocs.dpa} />;
}
