// worker/ingress/test-helpers.ts
//
// Shared request/reply builders for Twilio ingress tests.
// Used by both status-callback (Task 12) and inbound-message (Task 13) suites.
//
// The Vitest setup uses a dummy DATABASE_POOL_URL (see vitest.setup.ts), so
// tests here do NOT hit a real database. The SQL layer is mocked via
// `vi.mock('@/lib/db/server', ...)` at the top of each test file, with a
// queue-based mockSql that returns pre-seeded values in order.
//
// These helpers build Fastify-shaped request/reply objects that include the
// real X-Twilio-Signature header (signed with a fixture auth token + URL) so
// the handler's signature verification path is exercised end-to-end.

import { createHmac } from 'node:crypto';

export const TEST_AUTH_TOKEN = 'test_auth_token_for_ingress_fixtures';
export const TEST_PUBLIC_URL = 'https://worker.example.com';

/** Twilio HMAC: base64(HMAC-SHA1(token, url + concat(sorted(k+v)))). */
function sign(authToken: string, fullUrl: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHmac('sha1', authToken).update(fullUrl + sorted).digest('base64');
}

export interface BuildOpts {
  invalidSig?: boolean;
  authToken?: string;
  publicUrl?: string;
}

type TwilioIngressPath = '/ingress/twilio/status' | '/ingress/twilio/inbound';

interface TestReply {
  statusCode: number;
  sentBody: unknown;
  status(code: number): TestReply;
  send(payload: unknown): TestReply;
}

interface TestRequest {
  rawBody: string;
  url: string;
  headers: Record<string, string | undefined>;
}

interface BuiltPair {
  req: TestRequest;
  reply: TestReply;
}

function buildRequest(
  path: TwilioIngressPath,
  params: Record<string, string>,
  opts: BuildOpts = {},
): BuiltPair {
  // Configure env so the handler builds the same fullUrl we sign with.
  process.env.TWILIO_AUTH_TOKEN = opts.authToken ?? TEST_AUTH_TOKEN;
  process.env.WORKER_PUBLIC_URL = opts.publicUrl ?? TEST_PUBLIC_URL;

  const rawBody = new URLSearchParams(params).toString();
  const fullUrl = `${opts.publicUrl ?? TEST_PUBLIC_URL}${path}`;
  const signature = opts.invalidSig
    ? 'definitely_not_a_valid_signature'
    : sign(opts.authToken ?? TEST_AUTH_TOKEN, fullUrl, params);

  const req: TestRequest = {
    rawBody,
    url: path,
    headers: {
      'x-twilio-signature': signature,
      'content-type': 'application/x-www-form-urlencoded',
    },
  };

  const reply: TestReply = {
    statusCode: 0,
    sentBody: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.sentBody = payload;
      return this;
    },
  };

  return { req, reply };
}

export function buildStatusRequest(
  params: Record<string, string>,
  opts?: BuildOpts,
): BuiltPair {
  return buildRequest('/ingress/twilio/status', params, opts);
}

export function buildInboundRequest(
  params: Record<string, string>,
  opts?: BuildOpts,
): BuiltPair {
  return buildRequest('/ingress/twilio/inbound', params, opts);
}

/**
 * Join every tagged-template SQL call into a single flat string so tests can
 * pattern-match against the SQL body regardless of parameter interpolation.
 * Mirrors `joinSql` in worker/__tests__/resend-webhook-bounce.test.ts.
 */
export function joinSql(calls: unknown[][]): string {
  return calls
    .flatMap((c) => (c[0] as TemplateStringsArray).raw.map((s) => s))
    .join(' ');
}
