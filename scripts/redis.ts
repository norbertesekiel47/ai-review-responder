/**
 * Dev/test helper: tiny Redis CLI for the cache Redis instance.
 *
 * Reuses the project's REDIS_CACHE_URL + REDIS_CACHE_TOKEN connection so it
 * works against local Docker Redis, Upstash, or anything else the rest of the
 * app talks to.
 *
 * Usage:
 *   pnpm redis get <key>
 *   pnpm redis keys <pattern>
 *   pnpm redis scan <pattern>
 *   pnpm redis del <key> [key2 ...]
 *   pnpm redis ttl <key>
 *   pnpm redis set <key> <value> [--ex <seconds>]
 *   pnpm redis info
 *   pnpm redis zernio                       # dump all Zernio connect-flow keys
 *   pnpm redis flush-zernio <business-id>   # delete a business's Zernio Redis state
 *
 * Examples:
 *   pnpm redis get connect_pending:019dd271-41d1-74ab-8a0c-a190089584c4
 *   pnpm redis keys 'connect_*'
 *   pnpm redis del connect_lock:019dd271-41d1-74ab-8a0c-a190089584c4
 *   pnpm redis zernio
 */

import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (existsSync('.env.local')) dotenvConfig({ path: '.env.local' });
else dotenvConfig();

import Redis from 'ioredis';
import { getCacheRedisOptions } from '../src/lib/db/redis-cache';

function usage(): never {
  console.error(`Usage: pnpm redis <command> [args...]

Commands:
  get <key>                  Read a value (pretty-prints JSON when applicable)
  keys <pattern>             List keys matching glob pattern (uses KEYS — fine for dev)
  scan <pattern>             Same as keys but uses SCAN cursor (production-safe)
  del <key> [key2 ...]       Delete one or more keys
  ttl <key>                  Show remaining TTL in seconds (-1 = no TTL, -2 = missing)
  set <key> <value>          Write a value. Add --ex <seconds> for TTL.
  info                       Connection summary + DBSIZE
  zernio                     Dump all Zernio connect-flow keys with values
  flush-zernio <biz-id>      Delete every Zernio Redis key for a business (asks for confirm)

Env: reads REDIS_CACHE_URL + REDIS_CACHE_TOKEN from .env.local`);
  process.exit(1);
}

function prettyValue(raw: string | null): string {
  if (raw === null) return '(nil)';
  // Try JSON pretty-print; fall back to raw text.
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    /* not JSON */
  }
  return raw;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (yes/no) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main(): Promise<void> {
  if (!process.env.REDIS_CACHE_URL) {
    console.error('REDIS_CACHE_URL not set in .env.local — cannot connect.');
    process.exit(1);
  }

  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  const redis = new Redis(getCacheRedisOptions());

  try {
    switch (command) {
      case 'get': {
        const [key] = args;
        if (!key) usage();
        const value = await redis.get(key);
        console.log(prettyValue(value));
        break;
      }

      case 'keys': {
        const [pattern] = args;
        if (!pattern) usage();
        const keys = await redis.keys(pattern);
        if (keys.length === 0) {
          console.log('(no matches)');
        } else {
          for (const k of keys.sort()) console.log(k);
          console.error(`\n${keys.length} key(s)`);
        }
        break;
      }

      case 'scan': {
        const [pattern] = args;
        if (!pattern) usage();
        const found: string[] = [];
        let cursor = '0';
        do {
          const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
          found.push(...batch);
          cursor = next;
        } while (cursor !== '0');
        if (found.length === 0) {
          console.log('(no matches)');
        } else {
          for (const k of found.sort()) console.log(k);
          console.error(`\n${found.length} key(s)`);
        }
        break;
      }

      case 'del': {
        if (args.length === 0) usage();
        const deleted = await redis.del(...args);
        console.log(`Deleted ${deleted} of ${args.length} key(s)`);
        break;
      }

      case 'ttl': {
        const [key] = args;
        if (!key) usage();
        const ttl = await redis.ttl(key);
        if (ttl === -2) console.log(`${key}: (key does not exist)`);
        else if (ttl === -1) console.log(`${key}: no TTL set (persistent)`);
        else console.log(`${key}: ${ttl}s`);
        break;
      }

      case 'set': {
        const [key, value, ...flags] = args;
        if (!key || value === undefined) usage();
        const exIdx = flags.indexOf('--ex');
        if (exIdx >= 0) {
          const seconds = Number(flags[exIdx + 1]);
          if (!Number.isFinite(seconds) || seconds <= 0) {
            console.error('Invalid --ex value');
            process.exit(1);
          }
          await redis.set(key, value, 'EX', seconds);
          console.log(`OK (TTL ${seconds}s)`);
        } else {
          await redis.set(key, value);
          console.log('OK');
        }
        break;
      }

      case 'info': {
        const dbsize = await redis.dbsize();
        const url = process.env.REDIS_CACHE_URL ?? '(unset)';
        const masked = url.replace(/:\/\/[^@]*@/, '://***@');
        console.log(`URL:    ${masked}`);
        console.log(`DBSIZE: ${dbsize} keys`);
        break;
      }

      case 'zernio': {
        // Convenience: dump all known connect-flow + Zernio keys with values.
        const patterns = [
          'connect_pending:*',
          'connect_state:*',
          'connect_locations:*',
          'connect_lock:*',
          'connect_finalize:*',
          'zernio_review_map:*',
          'zernio_event_seen:*',
        ];
        let total = 0;
        for (const pattern of patterns) {
          const keys = await redis.keys(pattern);
          if (keys.length === 0) continue;
          console.log(`\n# ${pattern}  (${keys.length})`);
          for (const k of keys.sort()) {
            const ttl = await redis.ttl(k);
            const value = await redis.get(k);
            const ttlNote = ttl === -1 ? '(no TTL)' : ttl === -2 ? '(expired)' : `TTL ${ttl}s`;
            console.log(`\n${k}  ${ttlNote}`);
            console.log(prettyValue(value));
          }
          total += keys.length;
        }
        if (total === 0) console.log('(no Zernio Redis state)');
        else console.error(`\n${total} key(s) total`);
        break;
      }

      case 'flush-zernio': {
        const [businessId] = args;
        if (!businessId) usage();
        const businessKeys = [
          `connect_pending:${businessId}`,
          `connect_lock:${businessId}`,
        ];
        // Plus any state/locations keys whose value belongs to this business
        // — strict match: parse the JSON blob and compare the explicit
        // businessId field. Substring matching would false-positive on any
        // value that happened to contain the UUID anywhere (correlation
        // ids, audit metadata, etc.).
        const scanned: string[] = [];
        for (const pattern of ['connect_state:*', 'connect_locations:*', 'connect_finalize:*']) {
          const keys = await redis.keys(pattern);
          for (const k of keys) {
            const v = await redis.get(k);
            if (!v) continue;
            let matched = false;
            try {
              const parsed = JSON.parse(v) as { businessId?: unknown; business_id?: unknown };
              const bid = parsed.businessId ?? parsed.business_id;
              if (typeof bid === 'string' && bid === businessId) matched = true;
            } catch {
              // Not JSON — fall back to a strict UUID-shape boundary match
              // so we don't false-match on substring bleed-through.
              const boundaryRegex = new RegExp(`(^|[^0-9a-f])${businessId}([^0-9a-f-]|$)`, 'i');
              if (boundaryRegex.test(v)) matched = true;
            }
            if (matched) scanned.push(k);
          }
        }
        const reviewMapKeys = await redis.keys(`zernio_review_map:${businessId}:*`);

        const all = [...businessKeys, ...scanned, ...reviewMapKeys];
        if (all.length === 0) {
          console.log(`No Zernio Redis state found for business ${businessId}`);
          break;
        }

        console.log(`Will delete ${all.length} key(s):`);
        for (const k of all) console.log(`  ${k}`);
        const ok = await confirm('\nProceed?');
        if (!ok) {
          console.log('Aborted.');
          break;
        }
        const deleted = await redis.del(...all);
        console.log(`Deleted ${deleted} key(s)`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}\n`);
        usage();
    }
  } finally {
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
