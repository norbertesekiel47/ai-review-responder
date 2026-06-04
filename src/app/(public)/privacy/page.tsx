import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Privacy Policy | RepWorth' };

export default function PrivacyPage() {
  permanentRedirect('/legal/privacy');
}
