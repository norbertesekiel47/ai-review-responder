import { permanentRedirect } from 'next/navigation';

export default function TermsPage() {
  permanentRedirect('/legal/terms');
}
