import type { MetadataRoute } from 'next';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://repworth.net';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/api',
          '/auth',
          '/approve',
          // Authed/personalized surfaces — nothing indexable behind them.
          '/onboarding',
          '/dashboard',
          '/settings',
          '/account',
          '/mfa',
          // Per-prospect demo pages are tokenized one-offs, not marketing pages.
          '/demo',
          // Unsubscribe landing pages are per-recipient tokens. Trailing slash
          // so the rule covers `/u/<token>` without claiming every future path
          // that merely starts with "u".
          '/u/',
        ],
      },
    ],
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
