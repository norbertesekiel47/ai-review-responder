import { ESLint } from 'eslint';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// Drives the resolved flat config over in-memory fixtures via the ESLint Node
// API. This is the permanent regression guard for the no-restricted-imports
// no-merge footgun: a future zone edit that silently drops a ban fails here.
const RESTRICTED_RULE_IDS = new Set([
  'no-restricted-imports',
  '@typescript-eslint/no-restricted-imports',
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
});
