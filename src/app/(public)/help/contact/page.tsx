import type { Metadata } from 'next';
import { ContactContent } from './ContactContent';

export const metadata: Metadata = {
  title: 'Contact support · RepWorth',
  description:
    'Email RepWorth support, billing, or security — plus response-time targets by plan.',
};

export default function HelpContactPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <ContactContent selfServeEnabled={selfServeEnabled} />;
}
