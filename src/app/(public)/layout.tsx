/**
 * Layout for all public (marketing, auth, approve, demo) routes.
 *
 * Renders a skip-to-content link as the FIRST focusable element so keyboard /
 * screen-reader users can jump past the repeated chrome. It lives here, not in
 * the root layout, so it never targets admin / onboarding / MFA shells that
 * have no marketing chrome (which would make the `#main-content` target dangle).
 *
 * Landmark contract (owned by each page, not this layout):
 *   Every public page must expose exactly ONE `<main id="main-content">` as the
 *   skip-link target. We intentionally do NOT wrap `{children}` in a
 *   layout-level `<main>` because some pages already render their own — doing so
 *   would nest `<main>` landmarks (invalid + an a11y regression). Pages that
 *   already have a `<main>` (e.g. Features via `SiteShell islandAs="main"`,
 *   Security's inline `<main>`) only need `id="main-content"` added to it; pages
 *   without one must add a single `<main id="main-content">`.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-[#557069] focus:px-4 focus:py-2 focus:text-sm focus:text-white focus:outline-2 focus:outline-offset-2 focus:outline-[#97B3AE]"
      >
        Skip to content
      </a>
      {children}
    </>
  );
}
