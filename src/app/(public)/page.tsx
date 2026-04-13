import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-xl font-bold text-stone-900">RepWorth</span>
          <Link
            href="/admin/login"
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
          >
            Admin Login
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="bg-amber-50">
        <div className="mx-auto max-w-3xl px-6 py-20 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl">
            Every review answered.
            <br />
            <span className="text-amber-600">Zero effort.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-stone-600">
            RepWorth monitors your Google reviews, drafts personalized responses
            with AI, and sends them to you for one-tap approval. You go from 12%
            response rate to 100% — without learning new software.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href="/admin/login"
              className="rounded-lg bg-amber-600 px-6 py-3 text-sm font-semibold text-white hover:bg-amber-700"
            >
              Get Started
            </Link>
            <a
              href="#how-it-works"
              className="rounded-lg border border-stone-300 px-6 py-3 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              See How It Works
            </a>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="bg-white">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-center text-2xl font-bold text-stone-900">
            How It Works
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-stone-600">
            A continuous loop that runs in the background for each business.
            The owner spends 30 seconds per review.
          </p>
          <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <div key={step.number} className="text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-sm font-bold text-amber-700">
                  {step.number}
                </div>
                <h3 className="mt-3 font-semibold text-stone-900">
                  {step.title}
                </h3>
                <p className="mt-1 text-sm text-stone-500">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="bg-amber-50">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-center text-2xl font-bold text-stone-900">
            Built for Small Businesses
          </h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-lg border border-stone-200 bg-white p-6"
              >
                <div className="text-2xl">{f.icon}</div>
                <h3 className="mt-3 font-semibold text-stone-900">
                  {f.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-stone-500">
                  {f.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="bg-white">
        <div className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-center text-2xl font-bold text-stone-900">
            Simple Pricing
          </h2>
          <p className="mt-3 text-center text-stone-600">
            No setup fees. No contracts. Cancel anytime.
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            <PricingCard
              name="Founding Member"
              price="$99"
              description="Rate locked for life. First 10 slots only."
              features={[
                'Google review monitoring',
                'AI-drafted responses',
                'One-tap email approval',
                'Multilingual support',
                'Weekly summary emails',
              ]}
              highlight
            />
            <PricingCard
              name="Standard"
              price="$149"
              description="Full service after founding slots fill."
              features={[
                'Everything in Founding',
                'Priority support',
                'Custom voice training',
                'ROI dashboard',
              ]}
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-stone-100 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
          <span className="text-sm text-stone-400">
            RepWorth &middot; AI Review Responder
          </span>
          <Link
            href="/admin/login"
            className="text-sm text-stone-500 hover:text-stone-700"
          >
            Admin
          </Link>
        </div>
      </footer>
    </div>
  );
}

// ── Static data ──────────────────────────────────────────────────────

const STEPS = [
  {
    number: 1,
    title: 'Monitor',
    description:
      'We poll your Google reviews every 60 minutes automatically.',
  },
  {
    number: 2,
    title: 'Generate',
    description:
      'AI drafts a personalized response that sounds like you wrote it.',
  },
  {
    number: 3,
    title: 'Approve',
    description:
      'You get an email. Tap approve, edit, or regenerate. 30 seconds.',
  },
  {
    number: 4,
    title: 'Post',
    description:
      'The approved response is posted to Google on your behalf.',
  },
];

const FEATURES = [
  {
    icon: '\uD83C\uDF0D',
    title: 'Multilingual',
    description:
      'Reviews in Spanish, Vietnamese, Chinese? Responses are generated in the same language automatically.',
  },
  {
    icon: '\uD83D\uDD12',
    title: 'Owner Approval Required',
    description:
      'Nothing is ever posted without your explicit approval. You stay in control.',
  },
  {
    icon: '\u26A1',
    title: 'Under 1 Hour',
    description:
      'From new review to draft response in your inbox — typically under 60 minutes.',
  },
  {
    icon: '\uD83C\uDFAF',
    title: 'Specific, Not Generic',
    description:
      'References the exact dishes, services, and staff mentioned in the review. No "thanks for your feedback."',
  },
  {
    icon: '\uD83D\uDCC8',
    title: 'Weekly Summaries',
    description:
      'Every Monday, get a summary: how many reviews, response rate, and any negative reviews needing attention.',
  },
  {
    icon: '\uD83D\uDCB0',
    title: '10x Cheaper Than Enterprise',
    description:
      'Birdeye charges $300-450/mo. We start at $99/mo. Same AI, simpler delivery.',
  },
];

// ── Components ───────────────────────────────────────────────────────

function PricingCard({
  name,
  price,
  description,
  features,
  highlight,
}: {
  name: string;
  price: string;
  description: string;
  features: string[];
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-6 ${
        highlight
          ? 'border-amber-600 bg-amber-50 ring-1 ring-amber-600'
          : 'border-stone-200 bg-white'
      }`}
    >
      {highlight && (
        <span className="mb-3 inline-block rounded-full bg-amber-600 px-3 py-0.5 text-xs font-semibold text-white">
          Limited
        </span>
      )}
      <h3 className="text-lg font-bold text-stone-900">{name}</h3>
      <p className="mt-1 text-3xl font-bold text-stone-900">
        {price}
        <span className="text-base font-normal text-stone-500">/mo</span>
      </p>
      <p className="mt-2 text-sm text-stone-500">{description}</p>
      <ul className="mt-4 space-y-2">
        {features.map((f) => (
          <li
            key={f}
            className="flex items-start gap-2 text-sm text-stone-700"
          >
            <svg
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="2.5"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 12.75l6 6 9-13.5"
              />
            </svg>
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}
