import Image from 'next/image';

interface BrandLogoProps {
  /** Square render size in px. Defaults to 32, the standard header/nav mark. */
  size?: number;
  /**
   * Accessible name. Decorative by default ('') because the brand mark is
   * almost always paired with adjacent "RepWorth" wordmark text; pass an
   * explicit alt only when the mark stands alone.
   */
  alt?: string;
  /** Extra classes, merged after the default `object-contain`. */
  className?: string;
}

/**
 * The RepWorth brand mark: the single owner of the logo asset
 * (`public/logo.svg`). Every surface (nav, auth cards, dashboard, onboarding,
 * error pages) renders the real logo through this, so there is one place to
 * change it. Renders only the mark; keep the "RepWorth" wordmark as separate
 * text where it is wanted.
 */
export function BrandLogo({ size = 32, alt = '', className }: BrandLogoProps) {
  return (
    <Image
      src="/logo.svg"
      alt={alt}
      width={size}
      height={size}
      className={['object-contain', className].filter(Boolean).join(' ')}
      unoptimized
    />
  );
}
