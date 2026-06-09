import { withSentryConfig } from '@sentry/nextjs';
import { withBotId } from 'botid/next/config';
import { buildContentSecurityPolicy } from './src/lib/security/csp.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['postgres'],
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
            key: 'Content-Security-Policy',
            value: buildContentSecurityPolicy(process.env.NODE_ENV),
          },
        ].filter((h) => h.value !== ''),
      },
    ];
  },
  async redirects() {
    return [
      { source: '/terms', destination: '/legal/terms', permanent: true },
      { source: '/privacy', destination: '/legal/privacy', permanent: true },
    ];
  },
};

// BotID (outermost) adds the bot-protection challenge/proxy rewrites; Sentry
// (inner) instruments the build. Both compose by augmenting the config object.
export default withBotId(
  withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !process.env.SENTRY_AUTH_TOKEN,
    telemetry: false,
  }),
);
