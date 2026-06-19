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
  /**
   * Island root element. Defaults to 'div'; features passes 'main' to keep the
   * page's single <main> landmark.
   */
  islandAs?: 'main' | 'div';
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
  islandAs = 'div',
  children,
}: SiteShellProps) {
  const Island = islandAs;
  return (
    <div className={scope}>
      <MarqueeBackground />
      {overlay}
      <div className="rw-island-wrap">
        <Island className="rw-island">
          <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />
          {children}
          <SiteFooter />
        </Island>
      </div>
    </div>
  );
}
