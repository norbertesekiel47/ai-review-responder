import type { Metadata } from 'next';
import { FeedbackThanksContent } from './FeedbackThanksContent';

export const metadata: Metadata = {
  title: 'Thank you · RepWorth',
  description: 'Your feedback has been recorded.',
  robots: { index: false, follow: false },
};

export default function FeedbackThanksPage() {
  return <FeedbackThanksContent />;
}
