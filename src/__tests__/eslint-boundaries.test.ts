import { ESLint } from 'eslint';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The first lintText call pays ESLint's full flat-config + plugin cold start
// (~8s when lefthook runs every pre-push job in parallel), which blows the
// default 5s per-test timeout on whichever case runs first.
vi.setConfig({ testTimeout: 30_000 });

// Drives the resolved flat config over in-memory fixtures via the ESLint Node
// API. This is the permanent regression guard for the no-restricted-imports
// no-merge footgun: a future zone edit that silently drops a ban fails here.
const RESTRICTED_RULE_IDS = new Set([
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
  // Dynamic import() is invisible to no-restricted-imports; the invariant-#1
  // dynamic bans run through no-restricted-syntax, so it must be counted here
  // or the dynamic-import assertions would filter out their own messages.
  'no-restricted-syntax',
]);

let eslint: ESLint;
beforeAll(() => {
  // Default flat-config discovery from cwd (the worktree/repo root).
  eslint = new ESLint();
});

// Returns only restricted-import messages so unrelated config noise can't
// flip an assertion. `filePath` is virtual — used solely for config matching.
async function restrictedMessages(code: string, relPath: string) {
  const filePath = path.join(process.cwd(), relPath);
  const results = await eslint.lintText(code, { filePath, warnIgnored: false });
  const result = results[0];
  if (!result) throw new Error(`ESLint returned no result for ${relPath}`);
  // Fail fast on config/parse breakage: a fatal or null-ruleId message means the
  // fixture didn't lint cleanly, which would make the `toHaveLength(0)` "allowed"
  // assertions pass for the wrong reason. Surface it instead.
  const fatalErrors = result.messages.filter((m) => m.fatal || m.ruleId === null);
  expect(fatalErrors, JSON.stringify(fatalErrors)).toHaveLength(0);
  return result.messages.filter(
    (m) => m.ruleId != null && RESTRICTED_RULE_IDS.has(m.ruleId),
  );
}

const FORBIDDEN_RUNTIME: ReadonlyArray<readonly [string, string]> = [
  ["import OpenAI from 'openai';", 'openai'],
  ["import Anthropic from '@anthropic-ai/sdk';", '@anthropic-ai/sdk'],
  ["import { Queue } from 'bullmq';", 'bullmq'],
  ["import postgres from 'postgres';", 'postgres'],
  ["import { generateResponse } from '@/lib/responses/generator';", 'generator'],
  ["import { runLlmTask } from '@/lib/llm/run-task';", '@/lib/llm (task seam)'],
];

// Dynamic import() variants — must be caught by no-restricted-syntax (the
// static no-restricted-imports rule never sees import()).
const FORBIDDEN_DYNAMIC: ReadonlyArray<readonly [string, string]> = [
  ["await import('openai');", 'openai'],
  ["await import('@anthropic-ai/sdk');", '@anthropic-ai/sdk'],
  ["await import('bullmq');", 'bullmq'],
  ["await import('postgres');", 'postgres'],
  ["await import('@/lib/responses/generator');", 'generator'],
  ["await import('@/lib/llm/run-task');", '@/lib/llm (task seam)'],
  ["await import('../../../../worker/queues');", 'worker/queues'],
];

describe('invariant #1 — Vercel UI surface may not runtime-import worker-only modules', () => {
  it.each(FORBIDDEN_RUNTIME)('app route importing %s errors', async (code) => {
    const msgs = await restrictedMessages(
      `${code}\nexport function GET() { return new Response('ok'); }\n`,
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('app route importing worker/queues errors', async () => {
    const msgs = await restrictedMessages(
      "import { reviewQueue } from '../../../../worker/queues';\nexport function GET() { return new Response('ok'); }\n",
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('components/ui primitive importing openai errors (ui zone not clobbered)', async () => {
    const msgs = await restrictedMessages(
      "import OpenAI from 'openai';\nexport const X = () => null;\n",
      'src/components/ui/_fixture.tsx',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('shared src/lib importing openai does NOT error (shared boundary intact)', async () => {
    const msgs = await restrictedMessages(
      "import OpenAI from 'openai';\nexport const x = OpenAI;\n",
      'src/lib/_fixture.ts',
    );
    expect(msgs).toHaveLength(0);
  });

  it('app route type-only postgres import is allowed', async () => {
    const msgs = await restrictedMessages(
      "import type postgres from 'postgres';\nexport type Sql = postgres.Sql;\nexport function GET() { return new Response('ok'); }\n",
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs).toHaveLength(0);
  });

  it('app route type-only @/lib/llm/types import is allowed', async () => {
    const msgs = await restrictedMessages(
      "import type { LLMCallResult } from '@/lib/llm/types';\nexport type R = LLMCallResult;\nexport function GET() { return new Response('ok'); }\n",
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs).toHaveLength(0);
  });

  it('app route parent-traversal import still errors (inherited ban kept)', async () => {
    const msgs = await restrictedMessages(
      "import { x } from '../../foo';\nexport function GET() { return new Response(String(x)); }\n",
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('components (non-ui) importing @/app still errors (inherited @/app ban kept)', async () => {
    const msgs = await restrictedMessages(
      "import { handler } from '@/app/api/x/route';\nexport const C = () => handler;\n",
      'src/components/dashboard/_fixture.tsx',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  // Tests don't ship to Vercel and legitimately import route handlers / worker
  // helpers under test — they must stay exempt from the entry-surface bans.
  it('component test importing @/app does NOT error (tests exempt)', async () => {
    const msgs = await restrictedMessages(
      "import { handler } from '@/app/api/x/route';\nexport const c = handler;\n",
      'src/components/dashboard/__tests__/x.test.tsx',
    );
    expect(msgs).toHaveLength(0);
  });

  it('app route test importing bullmq at runtime does NOT error (tests exempt)', async () => {
    const msgs = await restrictedMessages(
      "import { Queue } from 'bullmq';\nexport const q = Queue;\n",
      'src/app/api/admin/jobs/__tests__/route.test.ts',
    );
    expect(msgs).toHaveLength(0);
  });

  // --- Dynamic import() bans (no-restricted-syntax) ------------------------
  it.each(FORBIDDEN_DYNAMIC)('app route dynamic-importing %s errors', async (expr) => {
    const msgs = await restrictedMessages(
      `export async function GET() { ${expr} return new Response('ok'); }\n`,
      'src/app/api/_fixture/route.ts',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('component (non-ui) dynamic-importing openai errors', async () => {
    const msgs = await restrictedMessages(
      "export const C = () => import('openai');\n",
      'src/components/dashboard/_fixture.tsx',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('component (non-ui) dynamic-importing @/app still errors (restated dynamic ban)', async () => {
    const msgs = await restrictedMessages(
      "export const C = () => import('@/app/api/x/route');\n",
      'src/components/dashboard/_fixture.tsx',
    );
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('components/ui TEST importing bullmq does NOT error (ui tests exempt)', async () => {
    const msgs = await restrictedMessages(
      "import { Queue } from 'bullmq';\nexport const q = Queue;\n",
      'src/components/ui/__tests__/x.test.tsx',
    );
    expect(msgs).toHaveLength(0);
  });
});
