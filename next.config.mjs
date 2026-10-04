import { withSentryConfig } from '@sentry/nextjs';
import { withBotId } from 'botid/next/config';
import { buildContentSecurityPolicy } from './src/lib/security/csp.mjs';

// Page-route prefixes that need the backend RepWorth switched off at shutdown
// (2026-10); each redirects to /closed — see redirects() below. Owner app
// (dashboard, settings, account, onboarding, mfa), auth (signup, login,
// password reset), admin, the approval and unsubscribe links, the lead-capture
// and demo pages, and the review-QR and Google reply redirectors.
const CLOSED_PAGE_PREFIXES = [
  '/signup',
  '/login',
  '/forgot-password',
  '/reset-password',
  '/book-a-demo',
  '/demo',
  '/approve',
  '/u',
  '/onboarding',
  '/dashboard',
  '/settings',
  '/account',
  '/mfa',
  '/admin',
  '/q',
  '/r',
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['postgres'],
  // Next 16 serves only the qualities listed here (default: 75 alone) and
  // silently clamps any other `quality` prop to the nearest listed value. 88
  // exists for the landing route map's full-bleed chart ground
  // (`future/FutureSection.tsx`): at 75 the contour linework banded and the
  // owner read the whole section as low-resolution.
  images: { qualities: [75, 88] },
  // Agent instructions are hand-owned here (#798). Left at its default, Next
  // 16.3 upserts a managed `<!-- BEGIN:nextjs-agent-rules -->` block into the
  // tracked root `AGENTS.md` on every `next dev` that detects a coding agent,
  // and re-asserts it byte-for-byte on each upgrade that rewords it. The
  // useful part of that block — "read the version-matched docs bundled at
  // node_modules/next/dist/docs/ before writing Next code" — is restated in
  // our own words in `.claude/CLAUDE.md` → Working rules, the durable layer
  // both Claude Code and Codex route through. One authoritative owner per fact.
  agentRules: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=(), usb=()',
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'same-origin',
          },
          {
            key: 'Content-Security-Policy',
            value: buildContentSecurityPolicy(process.env.NODE_ENV),
          },
        ].filter((h) => h.value !== ''),
      },
    ];
  },
  async redirects() {
    return [
      // RepWorth has shut down (2026-10). Every PAGE route that needs the
      // backend (Supabase, the worker, Redis) sends the visitor to the static
      // /closed notice instead of a broken form or an error. Temporary (307),
      // never permanent, so browsers do not cache it and the site can be
      // revived by deleting this block. `/:path*` matches the bare prefix too.
      // /api/** is deliberately absent: API callers get their own status, not
      // an HTML page. Listed first so a stale deep link takes one hop.
      ...CLOSED_PAGE_PREFIXES.map((prefix) => ({
        source: `${prefix}/:path*`,
        destination: '/closed',
        permanent: false,
      })),
      { source: '/terms', destination: '/legal/terms', permanent: true },
      { source: '/privacy', destination: '/legal/privacy', permanent: true },
      // Past Replies folded into Reviews → History (2026-06-19). Hygiene for
      // staging bookmarks; the sidebar/mobile links already point at the new path.
      {
        source: '/dashboard/past-replies',
        destination: '/dashboard/reviews/history',
        permanent: true,
      },
    ];
  },
};

// BotID (outermost) adds the bot-protection challenge/proxy rewrites; Sentry
// (inner) instruments the build and uploads source maps. `org`/`project` are
// env-driven so each environment targets its own Sentry project (staging →
// repworth-staging, prod → its own); uploads run only when SENTRY_AUTH_TOKEN is
// set and stay silent/inert otherwise (local, dev, preview).
export default withBotId(
  withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !process.env.SENTRY_AUTH_TOKEN,
    telemetry: false,

    // Upload a larger set of source maps for prettier stack traces (increases build time).
    widenClientFileUpload: true,

    // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
    // Must not collide with middleware matchers, or client-side error reporting fails.
    tunnelRoute: '/monitoring',

    webpack: {
      // Auto-instrument Vercel Cron Monitors configured via vercel.json.
      automaticVercelMonitors: true,

      // Tree-shake Sentry SDK logger statements to reduce bundle size.
      treeshake: {
        removeDebugLogging: true,
      },
    },
  }),
);
