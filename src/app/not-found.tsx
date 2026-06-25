import Link from 'next/link';

// Branded root 404 — island layout on the sage background, server-rendered
// (no client motion needed for a static error surface).
export default function NotFound() {
  return (
    <div className="min-h-screen bg-rw-sage relative">
      <div className="relative z-10 min-h-screen py-20 px-4 flex items-center justify-center">
        <main className="w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl px-8 py-16 text-center">
          <div className="flex items-center justify-center gap-2 mb-10">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rw-teal to-rw-teal/80" aria-hidden="true" />
            <span className="text-sm tracking-wider uppercase text-rw-teal">RepWorth</span>
          </div>
          <p className="text-sm tracking-wider uppercase text-rw-teal mb-3">404</p>
          <h1 className="text-4xl md:text-5xl font-medium text-rw-ink mb-4">
            Page not found
          </h1>
          <p className="text-lg text-rw-ink-soft leading-relaxed mb-10">
            The page you&apos;re looking for doesn&apos;t exist or has moved.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/"
              className="px-8 py-4 bg-rw-teal text-white rounded-full shadow-lg hover:shadow-xl transition-shadow"
            >
              Back to home
            </Link>
            <Link
              href="/dashboard"
              className="px-8 py-4 bg-white text-rw-teal rounded-full border border-rw-teal/20 hover:border-rw-teal/40 transition-colors"
            >
              Go to dashboard
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}
