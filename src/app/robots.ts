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
        ],
      },
    ],
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
