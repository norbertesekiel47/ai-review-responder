import type { Metadata } from 'next';
import { noindexRobots } from '@/lib/seo';

// mfa/challenge is a client component and can't export metadata itself; this
// server layout carries the title + noindex for the whole /mfa subtree (#19).
// The root layout's `title.template` ('%s · RepWorth') appends the brand, so
// the title here is the page name only.
export const metadata: Metadata = {
  title: 'Security check',
  robots: noindexRobots,
};

export default function MfaLayout({ children }: { children: React.ReactNode }) {
  return children;
}
