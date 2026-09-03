import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';

// Bare name: the root layout's title template appends " · RepWorth". This stub
// redirects before the metadata renders, so the fix is for consistency only.
export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  permanentRedirect('/legal/privacy');
}
