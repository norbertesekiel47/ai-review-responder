import type { Metadata } from 'next';
import { FeedbackThanksContent } from './FeedbackThanksContent';

export const metadata: Metadata = {
  // Bare name: the root layout's title template appends " · RepWorth".
  title: 'Thank you',
  description: 'Your feedback has been recorded.',
  robots: { index: false, follow: false },
};

export default function FeedbackThanksPage() {
  return <FeedbackThanksContent />;
}
