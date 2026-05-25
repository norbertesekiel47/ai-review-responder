import { LegalPage } from '@/components/legal/LegalPage';
import { legalDocs } from '@/lib/legal/content';

export default function SubProcessorsLegalPage() {
  return <LegalPage doc={legalDocs['sub-processors']} />;
}
