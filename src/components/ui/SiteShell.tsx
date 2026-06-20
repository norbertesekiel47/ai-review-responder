import type { ReactNode } from 'react';
import { MarqueeBackground } from '@/components/ui/MarqueeBackground';
import { SiteNav } from '@/components/ui/SiteNav';
import { SiteFooter } from '@/components/ui/SiteFooter';

interface SiteShellProps {
  /**
   * Page-scope class applied to the outer wrapper (e.g. 'rw-landing',
   * 'hiw-page'). Page-specific CSS in globals.css targets descendants of this
   * class, so every page must pass its own scope.
   */
  scope: string;
  /** Forwarded to SiteNav. */
  selfServeEnabled?: boolean;
  /** Forwarded to SiteNav. */
  comingSoon?: boolean;
  /**
   * Optional node rendered between the marquee and the island wrap — used for a
   * page's section dot-nav (landing `rw-dot-nav`, how-it-works `hiw-dotnav`,
   * features `<DotNav>`). Omitted on pages without one (pricing).
   */
  overlay?: ReactNode;
  children?: ReactNode;
}

/**
 * Single owner of the RepWorth marketing chrome: drifting-reviews marquee,
 * the white island, the navbar and the footer. Marketing pages compose this and
 * inject their content as children. Distinct from `PageShell` (an unrelated
 * Tailwind/parallax island used by other surfaces).
 */
export function SiteShell({
  scope,
  selfServeEnabled = false,
  comingSoon = false,
  overlay,
  children,
}: SiteShellProps) {
  return (
    <div className={scope}>
      <MarqueeBackground />
      {overlay}
      <div className="rw-island-wrap">
        <div className="rw-island">
          {/* Header / main / footer are siblings so each keeps its landmark role
              (a <footer>/<header> nested inside <main> is NOT a landmark). The
              skip link in (public)/layout.tsx targets #main-content. */}
          <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />
          <main id="main-content">{children}</main>
          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
