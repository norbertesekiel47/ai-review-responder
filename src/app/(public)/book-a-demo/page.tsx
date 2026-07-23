import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { BookADemoContent } from './BookADemoContent';

export const metadata: Metadata = {
  title: 'Join the waitlist · RepWorth',
  description: 'Request early access to RepWorth: automated, owner-approved Google review responses for local businesses.',
};

export default function BookADemoPage() {
  const selfServeEnabled = selfServeSignupEnabled();
  return <BookADemoContent selfServeEnabled={selfServeEnabled} />;
}
