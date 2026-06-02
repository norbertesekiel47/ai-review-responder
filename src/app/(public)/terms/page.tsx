import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Terms of Service | RepWorth' };

export default function TermsPage() {
  permanentRedirect('/legal/terms');
}
