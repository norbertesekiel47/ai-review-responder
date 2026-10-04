'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CLOSED_NOTICE_CTA } from './marketing-links';

/**
 * Site-wide closure strip for every public page (rendered by
 * `(public)/layout.tsx`, after the skip link). RepWorth has shut down, so the
 * strip says so before any marketing copy does and links to the `/closed`
 * notice. Static by design: no data, no flags, nothing that needs the backend
 * the shutdown switched off. Hidden on `/closed` itself, where it would only
 * link to the page the visitor is already reading.
 */
export function ClosedBanner() {
  const pathname = usePathname();
  if (pathname === CLOSED_NOTICE_CTA.href) return null;

  return (
    <aside
      aria-label="Service notice"
      className="relative z-20 bg-rw-ink2 px-4 py-2.5 text-center font-[family-name:var(--rw-font-body)] text-sm leading-snug text-white"
    >
      RepWorth has closed and is no longer taking sign-ups.{' '}
      <Link
        href={CLOSED_NOTICE_CTA.href}
        className="whitespace-nowrap underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        Read the notice
      </Link>
    </aside>
  );
}
