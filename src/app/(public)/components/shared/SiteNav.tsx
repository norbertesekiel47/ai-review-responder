import Link from 'next/link';

interface SiteNavProps {
  comingSoon?: boolean;
}

export function SiteNav({ comingSoon = false }: SiteNavProps) {
  const navLinks = [
    { label: 'Features', href: '/features' },
    { label: 'How it works', href: '/how-it-works' },
    ...(comingSoon ? [] : [{ label: 'Book a Demo', href: '/book-a-demo' }]),
  ];

  return (
    <nav className="px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-between">
      <div className="hidden sm:flex items-center gap-6">
        {navLinks.map(({ label, href }) => (
          <Link
            key={label}
            href={href}
            className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
          >
            {label}
          </Link>
        ))}
      </div>
      <Link href="/" className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
        <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
      </Link>
    </nav>
  );
}
