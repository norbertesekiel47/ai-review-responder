import Link from 'next/link';

/**
 * Site-wide marketing footer. Rendered by SiteShell as the last child of the
 * island on every marketing page. Uses the global `.rw-foot` styles.
 */
export function SiteFooter() {
  return (
    <footer className="rw-foot">
      <span suppressHydrationWarning>© {new Date().getFullYear()} RepWorth. All rights reserved.</span>
      <span>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/terms">Terms &amp; Conditions</Link>
      </span>
    </footer>
  );
}
