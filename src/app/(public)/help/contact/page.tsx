import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { ContactContent } from './ContactContent';

export const metadata: Metadata = {
  title: 'Contact support · RepWorth',
  description:
    'Email RepWorth support, billing, or security — plus response-time targets by plan.',
};

export default function HelpContactPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  return <ContactContent selfServeEnabled={selfServeEnabled} />;
}
