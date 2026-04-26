/**
 * Dev/test helper: nukes all signup-flow rate-limit keys from the cache Redis
 * so you can re-test signup → OTP → resend → verify without waiting an hour.
 *
 * Usage:
 *   pnpm tsx scripts/clear-signup-rate-limits.ts
 *   pnpm tsx scripts/clear-signup-rate-limits.ts <email>   # also clears email-scoped keys
 *
 * Reads REDIS_CACHE_URL + REDIS_CACHE_TOKEN from .env.local (loaded via dotenv).
 *
 * Key patterns deleted:
 *   signup:ip:*                       (5/IP/hour cap on POST /api/auth/signup)
 *   verify-otp:email:<email>          (8/email/10min on POST /api/auth/verify-otp)
 *   verify-otp:ip:*                   (30/IP/10min)
 *   resend-conf:email:<email>         (2/email/hour on POST /api/auth/resend-confirmation)
 *   resend-conf:ip:*                  (5/IP/hour)
 *   select-plan:auth:*                (10/authId/10min on POST /api/onboarding/select-plan)
 *   select-plan:ip:*                  (30/IP/10min)
 *   forgot-password:*                 (forgot/reset flow)
 *   reset-password:*
 */

import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
// Prefer .env.local (Next.js convention), fall back to .env.
if (existsSync('.env.local')) dotenvConfig({ path: '.env.local' });
else dotenvConfig();

import Redis from 'ioredis';
import { getCacheRedisOptions } from '../src/lib/db/redis-cache';

const PATTERNS = [
  'signup:ip:*',
  'verify-otp:ip:*',
  'resend-conf:ip:*',
  'select-plan:ip:*',
  'select-plan:auth:*',
  'forgot-password:ip:*',
  'forgot-password:email:*',
  'reset-password:ip:*',
];

async function main() {
  if (!process.env.REDIS_CACHE_URL) {
    console.error('REDIS_CACHE_URL not set — nothing to do.');
    process.exit(1);
  }

  const redis = new Redis(getCacheRedisOptions());

  const email = process.argv[2]?.trim().toLowerCase();
  if (email) {
    PATTERNS.push(`verify-otp:email:${email}`);
    PATTERNS.push(`resend-conf:email:${email}`);
  }

  let totalDeleted = 0;
  for (const pattern of PATTERNS) {
    if (pattern.includes('*')) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        const deleted = await redis.del(...keys);
        console.log(`  ${pattern} → ${deleted} key(s) deleted`);
        totalDeleted += deleted;
      } else {
        console.log(`  ${pattern} → 0 keys`);
      }
    } else {
      const deleted = await redis.del(pattern);
      console.log(`  ${pattern} → ${deleted} key(s) deleted`);
      totalDeleted += deleted;
    }
  }

  console.log(`\nDone. ${totalDeleted} key(s) cleared.`);
  await redis.quit();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
