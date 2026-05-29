# Close point-2 test gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three pure-local test gaps named in `docs/launch-ready-part1.md` line 165 — `OutboxPoller` coverage, the Resend webhook signature *accept* path, and the flaky `bounced-skip` test — as three independent PRs.

**Architecture:** Each PR is built in its own **sibling** git worktree (under `repworth-wt/<slug>`, never nested in `.claude/worktrees/` — nested worktrees leak module resolution into the parent `node_modules`/eslintrc and poison `lint`+`test`, per CLAUDE.md). Branches are cut off `main` HEAD. Tests follow the established `vi.hoisted` + tagged-template-`sql` mock convention. The only production change in the whole effort is adding the `export` keyword to one function.

**Tech Stack:** Vitest 4, TypeScript (strict, `noUncheckedIndexedAccess`), Postgres.js (mocked), BullMQ (mocked), Fastify (test doubles), Node `crypto`, svix-style HMAC.

**Spec:** `docs/superpowers/specs/2026-05-28-close-point2-test-gaps-design.md`

---

## PR 1 — `OutboxPoller` tests

**Worktree:** already created at `/Users/norbertesekiel/Developer/startups/repworth-wt/launch-p1-outbox-poller-tests` on branch `fix/launch-p1-outbox-poller-tests`. The session is already inside it. The design spec is already committed here.

**Files:**
- Modify: `worker/background/pollers/OutboxPoller.ts:26` (`async function pollOutbox` → `export async function pollOutbox`)
- Create: `worker/background/pollers/__tests__/OutboxPoller.test.ts`

**Why mocking `../../../queues` is mandatory:** `worker/queues.ts` runs `getRedisOptions()` at module load (`new URL(process.env.REDIS_QUEUE_URL!)` — unset under test → throws) and constructs 18 BullMQ `Queue`s. `OutboxPoller` imports `topicToQueue` from it, so the test must replace that module wholesale. Likewise `@sentry/node` is imported directly (not via `worker/sentry`).

### Task 1.1: Export `pollOutbox` (test seam)

- [ ] **Step 1: Make the edit**

In `worker/background/pollers/OutboxPoller.ts`, change line 26 from:

```ts
async function pollOutbox(): Promise<void> {
```

to:

```ts
export async function pollOutbox(): Promise<void> {
```

Nothing else changes. `startOutboxPoller`/`stopOutboxPoller` still call it identically.

- [ ] **Step 2: Verify typecheck still passes**

Run: `pnpm typecheck`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add worker/background/pollers/OutboxPoller.ts
git commit -m "test(outbox): export pollOutbox so the poll cycle is unit-testable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: Scaffold the test file + watchdog coverage

These are characterization tests over existing, working code: each test is expected to **pass** on first run. If one fails, treat it as a discrepancy to investigate (test wrong, or real bug) before forcing green.

- [ ] **Step 1: Create the test file with mocks, helpers, and the watchdog tests**

Create `worker/background/pollers/__tests__/OutboxPoller.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────
const {
  sqlReturnQueue,
  txReturnQueue,
  mockSql,
  mockTx,
  mockQueueAdd,
  mockCaptureMessage,
  mockAddBreadcrumb,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const txReturnQueue: unknown[] = [];
  const shiftFrom = (q: unknown[]) => {
    const r = q.shift() ?? [];
    return Promise.resolve(Array.isArray(r) ? r : [r]);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockTx: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => shiftFrom(txReturnQueue));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => shiftFrom(sqlReturnQueue));
  mockSql.begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx));
  return {
    sqlReturnQueue,
    txReturnQueue,
    mockSql,
    mockTx,
    mockQueueAdd: vi.fn(),
    mockCaptureMessage: vi.fn(),
    mockAddBreadcrumb: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../queues', () => ({
  topicToQueue: { send_notification: { add: mockQueueAdd } },
}));
vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
  addBreadcrumb: mockAddBreadcrumb,
  captureException: vi.fn(),
}));

// Import AFTER mocks are wired.
import { pollOutbox } from '../OutboxPoller';

// ── Helpers ─────────────────────────────────────────────────────────
function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join(' ');
}
/** Find the sql() call whose flattened text contains ALL needles. */
function findSql(calls: unknown[][], ...needles: string[]): unknown[] | undefined {
  return calls.find((c) => needles.every((n) => sqlText(c).includes(n)));
}
function outboxEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'out-1',
    topic: 'send_notification',
    payload: { response_id: 'resp-1' },
    attempts: 1,
    max_attempts: 5,
    ...overrides,
  };
}

describe('OutboxPoller.pollOutbox', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    txReturnQueue.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // ── Phase 1: watchdog ──
  it('runs the three watchdog recovery queries inside a transaction', async () => {
    sqlReturnQueue.push([]); // claim returns no pending rows
    await pollOutbox();

    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(mockTx).toHaveBeenCalledTimes(3);
    // 1: reset retryable stale 'dispatched' → 'pending'
    expect(sqlText(mockTx.mock.calls[0])).toContain("status = 'pending'");
    expect(sqlText(mockTx.mock.calls[0])).toContain("INTERVAL '1 hour'");
    expect(sqlText(mockTx.mock.calls[0])).toContain('attempts < max_attempts');
    // 2: dead-letter exhausted stale 'dispatched' → 'failed'
    expect(sqlText(mockTx.mock.calls[1])).toContain("status = 'failed'");
    expect(sqlText(mockTx.mock.calls[1])).toContain('attempts >= max_attempts');
    // 3: recover stale 'dispatching' → 'pending'
    expect(sqlText(mockTx.mock.calls[2])).toContain("status = 'dispatching'");
    expect(sqlText(mockTx.mock.calls[2])).toContain("INTERVAL '2 minutes'");
  });

  it('logs recovered/failed/stale counts when the watchdog acted', async () => {
    txReturnQueue.push([{ count: '2' }]); // recovered
    txReturnQueue.push([{ count: '1' }]); // terminated
    txReturnQueue.push([{ count: '3' }]); // stale dispatching
    sqlReturnQueue.push([]); // no pending rows
    await pollOutbox();

    const watchdogLog = logSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('Watchdog'),
    );
    expect(watchdogLog).toBeDefined();
    expect(watchdogLog![0]).toContain('recovered=2');
    expect(watchdogLog![0]).toContain('failed=1');
    expect(watchdogLog![0]).toContain('stale_dispatching=3');
  });

  it('continues to dispatch even if the watchdog transaction throws', async () => {
    mockSql.begin.mockRejectedValueOnce(new Error('watchdog tx failed'));
    sqlReturnQueue.push([outboxEntry()]); // claim returns one entry
    await pollOutbox();

    expect(errorSpy).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledOnce(); // dispatch still happened
  });
});
```

- [ ] **Step 2: Run the watchdog tests**

Run: `pnpm vitest run worker/background/pollers/__tests__/OutboxPoller.test.ts`
Expected: PASS (3 tests). If `findSql`/`sqlText` are flagged unused by lint, they are consumed by later tasks — that's fine until Task 1.5.

- [ ] **Step 3: Commit**

```bash
git add worker/background/pollers/__tests__/OutboxPoller.test.ts
git commit -m "test(outbox): cover watchdog recovery (reset, dead-letter, stale-dispatching)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: Dispatch happy-path + empty-batch + JSONB-string coverage

- [ ] **Step 1: Append these tests inside the `describe` block (after the watchdog tests)**

```ts
  // ── Phase 2 + 3: dispatch ──
  it('dispatches a claimed pending row to its queue and marks it dispatched', async () => {
    sqlReturnQueue.push([outboxEntry()]); // claim
    await pollOutbox();

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [topicArg, payloadArg, optsArg] = mockQueueAdd.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { jobId: string },
    ];
    expect(topicArg).toBe('send_notification');
    expect(payloadArg).toEqual({ response_id: 'resp-1', outbox_id: 'out-1', outbox_attempt: 1 });
    expect(optsArg).toEqual({ jobId: 'out-1_1' });

    const dispatchedUpdate = findSql(mockSql.mock.calls, "status = 'dispatched'");
    expect(dispatchedUpdate).toBeDefined();
  });

  it('returns without dispatching when no pending rows are claimed', async () => {
    sqlReturnQueue.push([]); // empty claim
    await pollOutbox();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('parses a JSON-string payload into an object before enqueueing', async () => {
    sqlReturnQueue.push([outboxEntry({ payload: JSON.stringify({ response_id: 'resp-1' }) })]);
    await pollOutbox();

    const payloadArg = (mockQueueAdd.mock.calls[0] as unknown[])[1];
    expect(payloadArg).toEqual({ response_id: 'resp-1', outbox_id: 'out-1', outbox_attempt: 1 });
    expect(typeof payloadArg).toBe('object');
  });
```

- [ ] **Step 2: Run the file**

Run: `pnpm vitest run worker/background/pollers/__tests__/OutboxPoller.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 3: Commit**

```bash
git add worker/background/pollers/__tests__/OutboxPoller.test.ts
git commit -m "test(outbox): cover dispatch happy path, empty batch, and JSONB-string payload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.4: Unknown-topic + attempt-guard coverage

- [ ] **Step 1: Append these tests inside the `describe` block**

```ts
  // ── Unknown topic ──
  it('marks an unknown-topic row failed and reports to Sentry without enqueueing', async () => {
    sqlReturnQueue.push([outboxEntry({ topic: 'bogus_topic' })]);
    await pollOutbox();

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledOnce();
    expect(String((mockCaptureMessage.mock.calls[0] as unknown[])[0])).toContain('Unknown topic');

    const failedUpdate = findSql(mockSql.mock.calls, "status = 'failed'", 'last_error');
    expect(failedUpdate).toBeDefined();
    // The interpolated value (index 1) carries the reason string.
    expect(String((failedUpdate as unknown[])[1])).toContain('Unknown topic');
  });

  // ── Attempt-guard / dead-letter on dispatch failure ──
  it('resets the row to pending when enqueue fails and attempts remain', async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));
    sqlReturnQueue.push([outboxEntry({ attempts: 1, max_attempts: 5 })]);
    await pollOutbox();

    // 'pending' + 'last_error' is unique to the reset (the claim has 'pending'
    // in its WHERE but no last_error; the watchdog reset is a tx call, not sql).
    const pendingReset = findSql(mockSql.mock.calls, "status = 'pending'", 'last_error');
    expect(pendingReset).toBeDefined();
  });

  it('dead-letters the row to failed when enqueue fails and attempts are exhausted', async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));
    sqlReturnQueue.push([outboxEntry({ attempts: 5, max_attempts: 5 })]);
    await pollOutbox();

    const failedUpdate = findSql(mockSql.mock.calls, "status = 'failed'", 'last_error');
    expect(failedUpdate).toBeDefined();
  });
```

- [ ] **Step 2: Run the file**

Run: `pnpm vitest run worker/background/pollers/__tests__/OutboxPoller.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 3: Commit**

```bash
git add worker/background/pollers/__tests__/OutboxPoller.test.ts
git commit -m "test(outbox): cover unknown-topic dead-letter and dispatch-failure attempt guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.5: Verify, gate, and open PR 1

- [ ] **Step 1: Full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green; no pre-existing test regressed. (If lint flags an unused helper, confirm every helper is now used; remove any that genuinely is not.)

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/launch-p1-outbox-poller-tests
gh pr create --base main --title "test(outbox): unit-test OutboxPoller dispatch/watchdog/dead-letter" --body "$(cat <<'EOF'
Closes the P0 'No test for OutboxPoller' gap (docs/launch-ready-part1.md:124).

## What
- Export `pollOutbox` so the poll cycle is directly, deterministically testable (the only production change).
- New `worker/background/pollers/__tests__/OutboxPoller.test.ts` covering:
  - watchdog: reset retryable stale `dispatched`, dead-letter exhausted, recover stale `dispatching`, count logging, and continue-on-watchdog-failure
  - dispatch happy path (queue.add args + jobId + `dispatched` transition)
  - empty batch no-op
  - JSONB-as-string payload parsing
  - unknown topic → `failed` + Sentry, no enqueue
  - dispatch failure → reset-to-pending (attempts remain) / dead-letter (exhausted)

## Safety
No behavior change beyond one `export` keyword. Full `lint`/`typecheck`/`test` green locally.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report the PR URL and stop for review.**

---

## PR 2 — Resend signature accept-path tests

**Worktree setup (run from inside the PR-1 worktree or the primary checkout — `git worktree` works from any worktree of the repo):**

```bash
git worktree add /Users/norbertesekiel/Developer/startups/repworth-wt/launch-p1-resend-sig -b fix/launch-p1-resend-sig-tests main
```

Then switch the session in with the native tool:
`EnterWorktree path=/Users/norbertesekiel/Developer/startups/repworth-wt/launch-p1-resend-sig`

Then: `pnpm install` and baseline `pnpm vitest run worker/ingress` (expect green).

**Files:**
- Create: `worker/ingress/__tests__/resend-webhook-signature.test.ts`
- (Do **not** touch `resend-webhook-bounce.test.ts` — it deliberately bypasses signatures via `MOCK_EXTERNAL_APIS=true`.)

### Task 2.1: Write the signature accept/reject suite

- [ ] **Step 1: Create the test file**

Create `worker/ingress/__tests__/resend-webhook-signature.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const { sqlReturnQueue, mockSql, mockSendInternalEmail } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const r = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(Array.isArray(r) ? r : [r]);
  });
  return {
    sqlReturnQueue,
    mockSql,
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'mock' }),
  };
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/notifications/email', () => ({
  sendInternalEmail: (...a: unknown[]) => mockSendInternalEmail(...a),
}));

import { handleResendWebhook } from '../resend';

// Svix secrets are 'whsec_' + base64(rawKeyBytes); the handler base64-decodes
// the part after the prefix and HMACs "${svixId}.${svixTimestamp}.${rawBody}".
const RAW_SECRET = Buffer.from('resend-test-signing-key').toString('base64');
const SECRET = `whsec_${RAW_SECRET}`;

function sign(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secretBytes = Buffer.from(RAW_SECRET, 'base64');
  const content = `${svixId}.${svixTimestamp}.${rawBody}`;
  return createHmac('sha256', secretBytes).update(content).digest('base64');
}
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReq(body: unknown, headers: Record<string, string | undefined>): any {
  return { body, headers, rawBody: JSON.stringify(body) };
}
function makeReply() {
  const captured: { status?: number; body?: unknown } = {};
  const reply = {
    status: (code: number) => {
      captured.status = code;
      return reply;
    },
    send: (b: unknown) => {
      captured.body = b;
    },
  } as unknown as import('fastify').FastifyReply;
  return { reply, captured };
}
// Fully-signed request; ageSeconds shifts the timestamp into the past (>0) or future (<0).
function signedReq(body: unknown, opts: { ageSeconds?: number; svixId?: string } = {}) {
  const svixId = opts.svixId ?? 'msg_signed';
  const ts = String(nowSeconds() - (opts.ageSeconds ?? 0));
  const sig = sign(JSON.stringify(body), svixId, ts);
  return makeReq(body, {
    'svix-id': svixId,
    'svix-timestamp': ts,
    'svix-signature': `v1,${sig}`,
  });
}

describe('handleResendWebhook — signature verification (real HMAC)', () => {
  const origSecret = process.env.RESEND_WEBHOOK_SECRET;
  const origMock = process.env.MOCK_EXTERNAL_APIS;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    delete process.env.MOCK_EXTERNAL_APIS;
  });
  afterEach(() => {
    vi.useRealTimers();
    if (origSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = origSecret;
    if (origMock === undefined) delete process.env.MOCK_EXTERNAL_APIS;
    else process.env.MOCK_EXTERNAL_APIS = origMock;
  });

  it('accepts a correctly signed request with a fresh timestamp', async () => {
    sqlReturnQueue.push({ count: 1 }); // inbound_events INSERT (fresh, not duplicate)
    sqlReturnQueue.push([]); // UPDATE notification_deliveries (delivered)
    sqlReturnQueue.push([]); // UPDATE inbound_events → processed

    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(signedReq(body), reply);

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ received: true });
    expect(mockSql).toHaveBeenCalled();
  });

  it('rejects a stale timestamp (older than 300s) before touching the DB', async () => {
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(signedReq(body, { ageSeconds: 400 }), reply);

    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ error: 'invalid_signature' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects a future timestamp (more than 60s ahead)', async () => {
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(signedReq(body, { ageSeconds: -120 }), reply);

    expect(captured.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects when the body is tampered after signing', async () => {
    const signed = signedReq({ type: 'email.delivered', data: { email_id: 'orig' } });
    signed.body = { type: 'email.delivered', data: { email_id: 'tampered' } };
    signed.rawBody = JSON.stringify(signed.body);
    const { reply, captured } = makeReply();
    await handleResendWebhook(signed, reply);

    expect(captured.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects when svix headers are missing', async () => {
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(makeReq(body, {}), reply);

    expect(captured.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('fails closed (401) when no secret is set and not in mock mode', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const { reply, captured } = makeReply();
    await handleResendWebhook(signedReq(body), reply);

    expect(captured.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('accepts when one of several space-separated signatures matches', async () => {
    sqlReturnQueue.push({ count: 1 });
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const svixId = 'msg_multi';
    const ts = String(nowSeconds());
    const body = { type: 'email.delivered', data: { email_id: 'msg-abc' } };
    const good = sign(JSON.stringify(body), svixId, ts);
    const req = makeReq(body, {
      'svix-id': svixId,
      'svix-timestamp': ts,
      'svix-signature': `v1,AAAAbogus v1,${good}`,
    });
    const { reply, captured } = makeReply();
    await handleResendWebhook(req, reply);

    expect(captured.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the file**

Run: `pnpm vitest run worker/ingress/__tests__/resend-webhook-signature.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 3: Confirm the existing bounce test still passes (unchanged)**

Run: `pnpm vitest run worker/ingress`
Expected: PASS (both resend files + others green).

- [ ] **Step 4: Commit**

```bash
git add worker/ingress/__tests__/resend-webhook-signature.test.ts
git commit -m "test(resend): cover real svix HMAC accept + stale/future/tamper reject paths

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: Verify, gate, and open PR 2

- [ ] **Step 1: Full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/launch-p1-resend-sig-tests
gh pr create --base main --title "test(resend): cover webhook signature accept path (real svix HMAC)" --body "$(cat <<'EOF'
Closes the P0 'Resend webhook signature acceptance path untested' gap (docs/launch-ready-part1.md:125).

## What
New `worker/ingress/__tests__/resend-webhook-signature.test.ts` exercising the **real** HMAC path (no `MOCK_EXTERNAL_APIS` bypass):
- valid signature + fresh timestamp → 200, reaches the dedup INSERT
- stale timestamp (>300s) → 401, zero DB calls
- future timestamp (>60s ahead) → 401
- tampered body → 401
- missing svix headers → 401
- no secret + non-mock mode → 401 (fail-closed)
- multiple space-separated signatures, one valid → 200

Reject paths assert zero `sql` calls (the signature gate runs first). The existing `resend-webhook-bounce.test.ts` is untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report the PR URL and stop for review.**

---

## PR 3 — `bounced-skip` flakiness hardening (reproduce-first)

**Worktree setup:**

```bash
git worktree add /Users/norbertesekiel/Developer/startups/repworth-wt/launch-p1-bounced-skip -b fix/launch-p1-bounced-skip-flaky main
```

`EnterWorktree path=/Users/norbertesekiel/Developer/startups/repworth-wt/launch-p1-bounced-skip`, then `pnpm install`.

**Files:**
- Modify: `worker/jobs/notification/__tests__/bounced-skip.test.ts` (scaffolding only — the four behavioral assertions stay byte-for-byte identical)

### Task 3.1: Reproduce and diagnose (systematic-debugging)

- [ ] **Step 1: Invoke the systematic-debugging skill** before editing anything.

- [ ] **Step 2: Establish the failure under load**

The doc reports failure only during a full-suite **parallel** run: a 5000ms timeout and the assertion `Response resp-1 belongs to business undefined, not biz-1`. Reproduce by running the full suite repeatedly:

```bash
for i in $(seq 1 10); do
  echo "=== run $i ==="; pnpm test 2>&1 | tail -8
done
```

If it does not surface, increase pressure (Vitest 4 default pool runs files in parallel forks):

```bash
for i in $(seq 1 10); do pnpm vitest run --pool=forks 2>&1 | grep -E "bounced-skip|business undefined|5000ms" ; done
```

Capture the exact failing assertion / stack into a scratch note (`/tmp/bounced-skip-repro.md`). **If it provably will not reproduce after a reasonable budget, write that down explicitly** and proceed to evidence-based hardening (Step 3 hypotheses) rather than guessing.

- [ ] **Step 3: Confirm the mechanism.** Verify against these hypotheses (do not assume):
  - **Floating-promise / queue bleed:** a worker fires an un-awaited `sql()` (analytics, outbox completion) that resolves during the *next* test and consumes its pushed fixture from the shared module-level `sqlReturnQueue` → `resp_business_id` reads `undefined`. Slower CPU (parallel load) shifts when that promise resolves → intermittent.
  - **Module-state bleed:** the four `await import()`ed workers share state across tests with no `vi.resetModules()`.
  - **Slow dynamic import:** per-test `await import()` under CPU contention exceeds the 5000ms test timeout.

  Evidence to gather: add a temporary counter to `mockSql` logging call count per test; assert how many `sql()` calls each worker actually makes vs how many fixtures are pushed.

### Task 3.2: Harden the test (apply the subset the evidence supports)

The assertions are unchanged; only the scaffolding hardens. Below is the **primary candidate** — apply the parts the reproduction justified. The two changes are independent and composable.

- [ ] **Step 1 (if queue-bleed / module-bleed confirmed): isolate per-test state and hoist imports**

Replace the per-test `await import(...)` calls with top-level static imports (deterministic, removes import cost), and reset module + mock state between every test so a late `sql()` from a prior test cannot misalign the next. At the top of the file, after the existing `vi.mock(...)` calls:

```ts
import { handleSendNotification } from '../NotificationWorker';
import { handleWeeklySummary } from '../../WeeklySummaryWorker';
import { handleMonthlyImpact } from '../../MonthlyImpactWorker';
import { handleOnboardingDrip } from '../../OnboardingDripWorker';
```

Remove the four inline `const { handleX } = await import(...)` lines from the test bodies (call the imported functions directly).

Then make the shared `beforeEach` (apply to **all four** `describe` blocks) drain any in-flight microtasks and reset state, so a straggler `sql()` resolves against the *old* test, not the new one:

```ts
beforeEach(async () => {
  vi.clearAllMocks();
  sqlReturnQueue.length = 0;
  // Flush any floating promises left by the previous worker invocation so a
  // late sql() can't shift a fixture meant for this test.
  await new Promise((r) => setImmediate(r));
});
```

- [ ] **Step 2 (if fixture-ordering is the root cause): make the `sql` mock content-addressed instead of order-dependent**

If Step 1 does not fully stabilize it, replace the order-dependent `shift()` queue with a mock that returns fixtures keyed by query shape, so call-order can never return the wrong row. Adjust `vi.hoisted`:

```ts
const { sqlFixtures, mockSql, mockTx, /* …unchanged email/outbox mocks… */ } = vi.hoisted(() => {
  // Map: substring of the SQL text → result rows for that query.
  const sqlFixtures = new Map<string, unknown[]>();
  const resolve = (strings: TemplateStringsArray): unknown[] => {
    const text = strings.join(' ');
    for (const [needle, rows] of sqlFixtures) if (text.includes(needle)) return rows;
    return [];
  };
  const mockTx = vi.fn((s: TemplateStringsArray) => Promise.resolve(resolve(s)));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSql: any = vi.fn((s: TemplateStringsArray) => Promise.resolve(resolve(s)));
  mockSql.begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockTx));
  return { sqlFixtures, mockSql, mockTx, /* … */ };
});
```

Each test then registers fixtures by the table it queries instead of pushing in order, e.g.:

```ts
sqlFixtures.set('FROM responses', [mockResponseRow()]);
sqlFixtures.set('FROM businesses', [bouncedBusiness()]);
```

(Confirm the exact `FROM <table>` / distinguishing fragment for each worker's queries while diagnosing in 3.1, and clear the map in `beforeEach`.) Keep the four `expect(...)` assertions identical.

- [ ] **Step 3 (only if a genuine fixed-timeout hang is found): set an explicit per-test timeout**

If the 5000ms is slow import/CPU rather than a hang, Step 1's static imports remove it. Only if a real wait is found, give that test an explicit budget: `it('…', async () => { … }, 15_000)`. Document why.

- [ ] **Step 4: Verify stability under load**

```bash
for i in $(seq 1 15); do pnpm test 2>&1 | tail -3; done
```

Expected: 15/15 green, no `bounced-skip` failure, no 5000ms timeout.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/notification/__tests__/bounced-skip.test.ts
git commit -m "test(notification): de-flake bounced-skip under parallel load

Root cause: <fill from 3.1 evidence>. Fix: <static imports / microtask flush /
content-addressed sql mock — whichever applied>. Behavioral assertions unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.3: Verify, gate, and open PR 3

- [ ] **Step 1: Full local gate (run twice to confirm stability)**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test`
Expected: all green both times.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/launch-p1-bounced-skip-flaky
gh pr create --base main --title "test(notification): de-flake bounced-skip under parallel load" --body "$(cat <<'EOF'
Hardens the flaky test noted in docs/launch-ready-part1.md:47.

## Root cause
<from systematic-debugging in Task 3.1>

## Fix
Scaffolding-only changes (behavioral assertions unchanged):
<static imports / microtask flush / content-addressed sql mock — as applied>

## Verification
Full suite run 15× back-to-back with zero failures.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report the PR URL.**

---

## Self-review (against the spec)

- **Spec coverage:** PR 1 covers all four named OutboxPoller behaviors (watchdog reset, dead-letter, attempt-guard, dispatch) + unknown-topic + JSONB + empty-batch. PR 2 covers accept + stale + future + tamper + missing-headers + fail-closed + multi-sig. PR 3 is reproduce-first with evidence-gated hardening. ✓
- **Worktree strategy:** all three use sibling worktrees off `main`; matches spec. ✓
- **One production change:** only the `export` keyword (Task 1.1). ✓
- **No existing test modified** except `bounced-skip.test.ts` scaffolding (PR 3), assertions preserved. ✓
- **Type consistency:** `findSql`/`sqlText`/`outboxEntry` (PR 1) and `sign`/`signedReq`/`makeReq`/`makeReply` (PR 2) are each defined once and reused; `mockSql.begin` shape matches `OutboxPoller`'s `sql.begin(cb)` usage. ✓
- **Placeholder scan:** PR 3 commit/PR bodies contain `<fill from evidence>` markers — these are intentionally evidence-dependent (reproduce-first) and must be filled at execution time, not left literal.
