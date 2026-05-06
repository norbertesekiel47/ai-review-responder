import Link from 'next/link';

interface SiteNavProps {
  /** When true, the right-side Log in / Sign up cluster is hidden. */
  comingSoon?: boolean;
  /** Reserved — accepted for backward compatibility with existing call sites. */
  selfServeEnabled?: boolean;
}

const NAV_LINKS = [
  { label: 'Features', href: '/features' },
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Pricing', href: '/pricing' },
];

export function SiteNav({ comingSoon = false }: SiteNavProps) {
  return (
    <nav className="px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-between gap-4">
      <Link href="/" className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/Logo - SVG.svg"
          alt="RepWorth"
          width={32}
          height={32}
          className="w-8 h-8 object-contain"
        />
        <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
      </Link>

      <div className="hidden sm:flex items-center gap-6">
        {NAV_LINKS.map(({ label, href }) => (
          <Link
            key={label}
            href={href}
            className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
          >
            {label}
          </Link>
        ))}
      </div>

      {!comingSoon && (
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="text-sm bg-[#97B3AE] text-white px-4 py-2 rounded-full hover:bg-[#97B3AE]/90 transition-colors"
          >
            Sign up
          </Link>
        </div>
      )}
    </nav>
  );
}
