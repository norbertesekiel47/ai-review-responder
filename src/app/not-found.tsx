import Link from 'next/link';

export const metadata = { title: 'Page not found | RepWorth' };

// Branded root 404 — island layout on the sage background, server-rendered
// (no client motion needed for a static error surface).
export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#D2E0D3] relative">
      <div className="relative z-10 min-h-screen py-20 px-4 flex items-center justify-center">
        <main className="w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl px-8 py-16 text-center">
          <div className="flex items-center justify-center gap-2 mb-10">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" aria-hidden="true" />
            <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
          </div>
          <p className="text-sm tracking-wider uppercase text-[#97B3AE] mb-3">404</p>
          <h1 className="text-4xl md:text-5xl font-medium text-[#2a2a2a] mb-4">
            Page not found
          </h1>
          <p className="text-lg text-[#6a6a6a] leading-relaxed mb-10">
            The page you&apos;re looking for doesn&apos;t exist or has moved.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/"
              className="px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg hover:shadow-xl transition-shadow"
            >
              Back to home
            </Link>
            <Link
              href="/dashboard"
              className="px-8 py-4 bg-white text-[#97B3AE] rounded-full border border-[#97B3AE]/20 hover:border-[#97B3AE]/40 transition-colors"
            >
              Go to dashboard
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}
