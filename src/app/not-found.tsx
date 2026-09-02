import Link from 'next/link';
import { SiteShell } from '@/components/ui/SiteShell';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled } from '@/lib/payments/flags';

/**
 * Branded root 404 in the Island chrome: SiteShell gives it the same nav pill,
 * bone island and footer as every marketing page (the demo 404 does the same
 * with its own island), so a visitor on a dead URL keeps the site's doors and
 * legal links. Server-rendered; the flags are read here (invariant #13) so the
 * nav offers the right door. There is deliberately no "Go to dashboard": an
 * anonymous visitor would only bounce to /login, and a signed-in owner already
 * has the nav.
 */
export default function NotFound() {
  const selfServeEnabled = selfServeSignupEnabled();
  const trialOn = selfServeEnabled && isTrialEnabled();
  return (
    <SiteShell scope="rw-not-found" selfServeEnabled={selfServeEnabled} trialEnabled={trialOn}>
      <div className="px-8 py-20 md:py-28 flex flex-col items-center text-center">
        <p className="text-sm tracking-wider uppercase text-rw-teal-strong mb-3">404</p>
        <h1 className="text-4xl md:text-5xl font-medium text-rw-ink mb-4">Page not found</h1>
        <p className="text-lg text-rw-ink-soft leading-relaxed max-w-md mb-10">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/"
          className="inline-block px-8 py-4 bg-rw-teal-strong text-white rounded-full shadow-lg font-medium"
        >
          Back to home
        </Link>
        <Link href="/help/contact" className="text-sm text-rw-teal-strong underline mt-6">
          Tell us what you were looking for
        </Link>
      </div>
    </SiteShell>
  );
}
