import type { Metadata } from 'next';
import { BookADemoContent } from './BookADemoContent';

export const metadata: Metadata = {
  title: 'Join the waitlist · RepWorth',
  description: 'Request early access to RepWorth — automated, owner-approved Google review responses for local businesses.',
};

export default function BookADemoPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <BookADemoContent selfServeEnabled={selfServeEnabled} />;
}
