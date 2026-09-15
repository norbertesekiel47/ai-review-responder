// tests/llm-eval/__tests__/structured-runner.test.ts
//
// Mocks only the provider/task seam (runLlmTask + anthropicProvider). The task
// registry, schemas, prompt builders and Operator validator stay real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runLlmTaskMock, anthropicCompleteMock } = vi.hoisted(() => ({
  runLlmTaskMock: vi.fn(),
  anthropicCompleteMock: vi.fn(),
}));

vi.mock('../../../src/lib/llm/run-task', () => ({
  runLlmTask: runLlmTaskMock,
}));
vi.mock('../../../src/lib/llm/anthropic-provider', () => ({
  anthropicProvider: { id: 'anthropic', complete: anthropicCompleteMock },
}));

import { STRUCTURED_CASES, runStructuredEval, sanitizeLlmError } from '../structured-runner';
import { ANTHROPIC_MODEL, OPENAI_MODEL, getLlmTask } from '../../../src/lib/llm/tasks';
import { buildJudgePrompt } from '../../../src/lib/responses/judge';
import type { LLMRequest } from '../../../src/lib/llm/types';

const ORIGINAL_ENV = { ...process.env };
const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';
const USAGE = { promptTokens: 120, completionTokens: 40 };

const VALID: Record<string, unknown> = {
  triage: { severity: 'low', issues: [], suggested_action: 'respond' },
  judge: { verdict: 'pass', reasons: [], rationale: 'Safe and on brand.' },
  solicitation_ask: {
    subject: 'Thanks for visiting yesterday',
    body: 'Hi Dana, thank you for coming in. If you have a moment, we would appreciate a review.',
  },
  owner_operator: {
    segments: [
      { type: 'text', text: 'Here is an auto-reply scope proposal for you to review.' },
      { type: 'proposal_ref', index: 0 },
    ],
    proposals: [{
      operation: 'set_auto_reply_scope',
      scope: { accountId: ACCOUNT, locationId: LOCATION },
      input: { threshold: 4 },
      rationale: 'You asked to include 4 and 5 star reviews.',
    }],
    unsupported: [],
  },
};

function validForPrompt(task: string, user: string): unknown {
  if (task !== 'owner_operator') return VALID[task];
  const message = (JSON.parse(user) as { ownerMessage: string }).ownerMessage;
  if (message === 'say we are licensed') return {
    segments: [{ type: 'refusal_ref', reason: 'invented_business_fact' }], proposals: [], unsupported: [],
  };
  if (message === 'turn off auto-reply for the cafe') return {
    segments: [{ type: 'scope_check', locationId: '00000000-0000-7000-8000-00000000b102' }],
    proposals: [], unsupported: [],
  };
  if (message === 'Stop replying on weekends') return {
    segments: [{ type: 'text', text: 'RepWorth cannot schedule by weekday yet.' }],
    proposals: [], unsupported: [{ request: message, context: 'Weekday scheduling is unavailable.' }],
  };
  if (message.startsWith('Turn auto')) return {
    segments: [{ type: 'proposal_ref', index: 0 }],
    proposals: [{ operation: 'set_auto_reply_scope', scope: { accountId: ACCOUNT, locationId: null },
      input: { threshold: null }, rationale: 'Turn off the account default.' }],
    unsupported: [],
  };
  return VALID[task];
}

function primaryOk(task: string, structured: unknown = VALID[task]) {
  return { text: '{}', provider: 'openai', model: OPENAI_MODEL, usage: USAGE, structured };
}

function fallbackOk(request: LLMRequest, value: unknown = validForPrompt(request.structuredOutput!.name, request.user)) {
  return { text: JSON.stringify(value), provider: 'anthropic', model: request.model, usage: USAGE };
}

beforeEach(() => {
  runLlmTaskMock.mockReset();
  anthropicCompleteMock.mockReset();
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  runLlmTaskMock.mockImplementation(async (task: string, prompt: { user: string }) => primaryOk(task, validForPrompt(task, prompt.user)));
  anthropicCompleteMock.mockImplementation(async (request: LLMRequest) => fallbackOk(request));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('runStructuredEval', () => {
  it('say we are licensed expects refused, never unsupported or a fact proposal', () => {
    const testCase = STRUCTURED_CASES.find((entry) => entry.id === 'owner-operator-licensed-refused');
    expect(testCase).toBeDefined();
    if (!testCase) return;
    expect(JSON.parse(testCase.prompt.user).ownerMessage).toBe('say we are licensed');
    const refused = {
      segments: [{ type: 'refusal_ref', reason: 'invented_business_fact' }], proposals: [], unsupported: [],
    };
    expect(testCase.check(refused)).toEqual([]);
    expect(testCase.check({
      segments: [{ type: 'text', text: 'RepWorth cannot do that yet.' }], proposals: [],
      unsupported: [{ request: 'say we are licensed', context: 'Not available.' }],
    })).not.toEqual([]);
    expect(testCase.check({ ...refused, segments: [{ type: 'refusal_ref', reason: 'review_incentive' }] })).not.toEqual([]);
    expect(testCase.check({ ...refused, proposals: [{
      operation: 'set_highlight_facts', scope: { accountId: ACCOUNT, locationId: LOCATION },
      input: { highlightFacts: ['We are licensed.'] }, rationale: 'Owner asked for a credential claim.',
    }] })).not.toEqual([]);
  });

  it('runs every structured task and Operator regression through both registered providers (9 x 2)', async () => {
    const report = await runStructuredEval();

    expect(report.mode).toBe('structured');
    expect(report.total).toBe(9);
    expect(report.failed).toBe(0);
    expect(report.results.map((r) => r.task)).toEqual(['triage', 'judge', 'solicitation_ask',
      'owner_operator', 'owner_operator', 'owner_operator', 'owner_operator', 'owner_operator', 'owner_operator']);

    expect(runLlmTaskMock).toHaveBeenCalledTimes(9);
    expect(anthropicCompleteMock).toHaveBeenCalledTimes(9);
    STRUCTURED_CASES.forEach((testCase, i) => {
      const primaryOrder = runLlmTaskMock.mock.invocationCallOrder[i]!;
      const fallbackOrder = anthropicCompleteMock.mock.invocationCallOrder[i]!;
      expect(primaryOrder).toBeLessThan(fallbackOrder);
      if (i + 1 < STRUCTURED_CASES.length) {
        expect(fallbackOrder).toBeLessThan(runLlmTaskMock.mock.invocationCallOrder[i + 1]!);
      }
      const task = getLlmTask(testCase.task);
      expect(runLlmTaskMock.mock.calls[i]).toEqual([testCase.task, testCase.prompt]);
      const request = anthropicCompleteMock.mock.calls[i]![0] as LLMRequest;
      expect(request.model).toBe(task.fallback!.model);
      expect(request.model).toBe(ANTHROPIC_MODEL);
      expect(request.maxTokens).toBe(task.maxTokens);
      expect(request.temperature).toBe(task.temperature);
      expect(request.system).toBe(testCase.prompt.system);
      expect(request.user).toBe(testCase.prompt.user);
      expect(request.structuredOutput?.name).toBe(testCase.task);
      // The ORIGINAL registered schema object, not a copy.
      expect(request.structuredOutput?.schema).toBe(task.outputSchema);
    });

    for (const result of report.results) {
      expect(result.attempts.map((a) => [a.lane, a.provider, a.schemaPassed, a.passed])).toEqual([
        ['primary', 'openai', true, true],
        ['fallback', 'anthropic', true, true],
      ]);
      expect(result.attempts[0]!.usage).toEqual(USAGE);
    }
  });

  it('builds the judge case with the production judge envelope', () => {
    const judgeCase = STRUCTURED_CASES.find((c) => c.task === 'judge')!;
    const envelope = JSON.parse(judgeCase.prompt.user) as Parameters<typeof buildJudgePrompt>[0];
    expect(judgeCase.prompt).toEqual(buildJudgePrompt(envelope));
  });

  it('fails a case whose fallback output breaks the registered schema', async () => {
    anthropicCompleteMock.mockImplementation(async (request: LLMRequest) =>
      request.structuredOutput!.name === 'triage'
        ? fallbackOk(request, { severity: 'low' })
        : fallbackOk(request),
    );

    const report = await runStructuredEval();
    const triage = report.results.find((r) => r.task === 'triage')!;

    expect(report.failed).toBe(1);
    expect(triage.passed).toBe(false);
    expect(triage.failures).toContain('fallback: output failed the registered outputSchema');
    expect(triage.attempts[1]!.schemaPassed).toBe(false);
    expect(triage.attempts[1]!.schemaIssues.length).toBeGreaterThan(0);
  });

  it('fails a schema-valid but semantically wrong result (question-only Operator output)', async () => {
    const questionOnly = {
      segments: [{ type: 'question', text: 'Which star scope would you like?' }],
      proposals: [],
      unsupported: [],
    };
    runLlmTaskMock.mockImplementation(async (task: string) =>
      task === 'owner_operator' ? primaryOk(task, questionOnly) : primaryOk(task),
    );

    const report = await runStructuredEval();
    const operator = report.results.find((r) => r.task === 'owner_operator')!;

    expect(operator.passed).toBe(false);
    expect(operator.attempts[0]!.schemaPassed).toBe(true);
    expect(operator.failures).toContain('primary: expected exactly 1 proposal; got 0');
    expect(operator.attempts[1]!.passed).toBe(true);
  });

  it('fails an Operator proposal with the wrong star threshold or scope', async () => {
    const wrong = structuredClone(VALID.owner_operator) as {
      proposals: { scope: { locationId: string }; input: { threshold: number } }[];
    };
    wrong.proposals[0]!.input.threshold = 5;
    wrong.proposals[0]!.scope.locationId = '00000000-0000-7000-8000-00000000b102';
    anthropicCompleteMock.mockImplementation(async (request: LLMRequest) =>
      request.structuredOutput!.name === 'owner_operator' ? fallbackOk(request, wrong) : fallbackOk(request),
    );

    const report = await runStructuredEval();
    const operator = report.results.find((r) => r.task === 'owner_operator')!;

    expect(operator.failures).toEqual(expect.arrayContaining([
      'fallback: proposal input is not exactly the requested star scope',
      'fallback: proposal scope.locationId is not the snapshot location',
    ]));
  });

  it('fails when the primary result came from the fallback provider', async () => {
    runLlmTaskMock.mockImplementation(async (task: string) =>
      task === 'judge'
        ? { ...primaryOk(task), provider: 'anthropic', model: ANTHROPIC_MODEL }
        : primaryOk(task),
    );

    const report = await runStructuredEval();
    const judge = report.results.find((r) => r.task === 'judge')!;

    expect(judge.passed).toBe(false);
    expect(judge.failures.some((f) => /^primary: primary answered by anthropic; expected openai/.test(f))).toBe(true);
  });

  it('fails an incomplete or non-JSON fallback without reporting its text', async () => {
    anthropicCompleteMock.mockImplementation(async (request: LLMRequest) => {
      const name = request.structuredOutput!.name;
      if (name === 'judge') return { ...fallbackOk(request), incomplete: 'truncated' };
      if (name === 'solicitation_ask') return { ...fallbackOk(request), text: 'SENTINEL-COMPLETION-TEXT' };
      return fallbackOk(request);
    });

    const report = await runStructuredEval();

    expect(report.results.find((r) => r.task === 'judge')!.failures).toContain('fallback: fallback output truncated');
    expect(report.results.find((r) => r.task === 'solicitation_ask')!.failures).toContain('fallback: fallback output is not JSON');
    expect(JSON.stringify(report)).not.toContain('SENTINEL-COMPLETION-TEXT');
  });

  it('reports a thrown provider error by kind and status only', async () => {
    runLlmTaskMock.mockImplementation(async (task: string) => {
      if (task !== 'triage') return primaryOk(task);
      throw Object.assign(new Error('echo SENTINEL-PROVIDER-MESSAGE'), { name: 'BadRequestError', status: 400 });
    });

    const report = await runStructuredEval();
    const triage = report.results.find((r) => r.task === 'triage')!;

    expect(triage.attempts[0]!.error).toEqual({ kind: 'BadRequestError', status: 400 });
    expect(triage.failures).toContain('primary: primary threw BadRequestError');
    expect(JSON.stringify(report)).not.toContain('SENTINEL-PROVIDER-MESSAGE');
  });

  it('records a fallback exception once and continues to the next case without retrying', async () => {
    anthropicCompleteMock.mockRejectedValueOnce(
      Object.assign(new Error('SENTINEL-FALLBACK-MESSAGE'), { name: 'RateLimitError', status: 429 }),
    );

    const report = await runStructuredEval();

    expect(report.failed).toBe(1);
    expect(report.results[0]!.attempts[1]).toMatchObject({
      passed: false,
      provider: null,
      model: null,
      usage: null,
      error: { kind: 'RateLimitError', status: 429 },
      failures: ['fallback threw RateLimitError'],
    });
    expect(report.results.slice(1).every((result) => result.passed)).toBe(true);
    expect(runLlmTaskMock).toHaveBeenCalledTimes(9);
    expect(anthropicCompleteMock).toHaveBeenCalledTimes(9);
    expect(JSON.stringify(report)).not.toContain('SENTINEL-FALLBACK-MESSAGE');
  });

  it.each(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])('fails before any provider call when %s is missing', async (name) => {
    delete process.env[name];
    await expect(runStructuredEval()).rejects.toThrow(new RegExp(name));
    expect(runLlmTaskMock).not.toHaveBeenCalled();
    expect(anthropicCompleteMock).not.toHaveBeenCalled();
  });
});

describe('Operator deployed-regression fixtures', () => {
  const CAFE = '00000000-0000-7000-8000-00000000b102';
  const off = {
    segments: [{ type: 'proposal_ref', index: 0 }],
    proposals: [{ operation: 'set_auto_reply_scope', scope: { accountId: ACCOUNT, locationId: null },
      input: { threshold: null }, rationale: 'Turn off the account default.' }],
    unsupported: [],
  };

  it.each(['owner-operator-all-locations-off', 'owner-operator-account-default-off'])(
    '%s requires an account contraction despite blocked readiness and no pending reviews', (id) => {
      const testCase = STRUCTURED_CASES.find((c) => c.id === id)!;
      expect(testCase, id).toBeDefined();
      const { snapshot } = JSON.parse(testCase.prompt.user);
      expect(snapshot.turns).toEqual([]);
      expect(snapshot.locations).toHaveLength(2);
      expect(snapshot.operatingRules.account).toEqual({ threshold: 4, vetoWindowMinutes: 15, dailyCap: 2 });
      expect(snapshot.metrics.pendingCount).toBe(0);
      expect(snapshot.allowedOperations.find((op: { id: string }) => op.id === 'set_auto_reply_scope')
        .expansionBlockedBy).toContain('auto_approval_disabled');
      expect(testCase.check(off)).toEqual([]);
      // Schema-valid outputs seen on staging must fail this semantic oracle.
      expect(testCase.check({ segments: [{ type: 'scope_check', locationId: CAFE }], proposals: [],
        unsupported: [{ request: 'Turn automatic replies off', context: 'Unsupported' }] })).not.toEqual([]);
      expect(testCase.check({ ...off, proposals: [{ ...off.proposals[0],
        scope: { accountId: ACCOUNT, locationId: LOCATION } }] })).not.toEqual([]);
      expect(testCase.check({ ...off, proposals: [{ ...off.proposals[0], input: { threshold: 5 } }] })).not.toEqual([]);
      expect(testCase.check({ ...off, segments: [{ type: 'question', text: 'Should I turn it off?' }] })).not.toEqual([]);
    },
  );

  it('requires only a Cafe scope chooser for the exact named-other-location request', () => {
    const testCase = STRUCTURED_CASES.find((c) => c.id === 'owner-operator-cafe-scope-check')!;
    expect(testCase).toBeDefined();
    expect(JSON.parse(testCase.prompt.user).ownerMessage).toBe('turn off auto-reply for the cafe');
    const chooser = { segments: [{ type: 'scope_check', locationId: CAFE }], proposals: [], unsupported: [] };
    expect(testCase.check(chooser)).toEqual([]);
    expect(testCase.check({ ...chooser, unsupported: [{ request: 'Turn off Cafe replies', context: 'Unsupported' }] })).not.toEqual([]);
    expect(testCase.check(off)).not.toEqual([]);
  });

  it('requires unsupported without a scope chooser or proposal for the exact weekend request', () => {
    const testCase = STRUCTURED_CASES.find((c) => c.id === 'owner-operator-weekend-unsupported')!;
    expect(testCase).toBeDefined();
    expect(JSON.parse(testCase.prompt.user).ownerMessage).toBe('Stop replying on weekends');
    const unsupported = { segments: [{ type: 'text', text: 'RepWorth cannot schedule by weekday yet.' }],
      proposals: [], unsupported: [{ request: 'Stop replying on weekends', context: 'Weekday scheduling is unavailable.' }] };
    expect(testCase.check(unsupported)).toEqual([]);
    for (const request of ['Pause replies on Saturdays and Sundays', 'Schedule automatic replies by day of the week']) {
      expect(testCase.check({ ...unsupported, unsupported: [{ request, context: 'Scheduling is unavailable.' }] })).toEqual([]);
    }
    expect(testCase.check({
      segments: [{ type: 'text', text: 'RepWorth cannot turn automatic replies off yet.' }],
      proposals: [], unsupported: [{ request: 'Turn automatic replies off', context: 'Automatic policy changes are unavailable.' }],
    })).toContain('unsupported request does not identify weekday or weekend scheduling');
    expect(testCase.check({ ...unsupported, segments: [{ type: 'scope_check', locationId: CAFE }] })).not.toEqual([]);
    expect(testCase.check({ ...unsupported, unsupported: [] })).not.toEqual([]);
    expect(testCase.check(off)).not.toEqual([]);
  });
});

describe('sanitizeLlmError', () => {
  it('keeps kind, status, cause kind, issue codes/paths and billed usage — never messages', () => {
    const cause = Object.assign(new Error('SENTINEL-CAUSE'), {
      name: 'ZodError',
      issues: [{ code: 'invalid_type', path: ['scope', 'locationId'], message: 'SENTINEL-ISSUE' }],
    });
    const err = Object.assign(new Error('SENTINEL-TOP', { cause }), {
      name: 'LLMStructuredOutputError',
      billedAttempts: [{ provider: 'openai', model: OPENAI_MODEL, usage: USAGE }],
    });

    const sanitized = sanitizeLlmError(err);

    expect(sanitized).toEqual({
      kind: 'LLMStructuredOutputError',
      causeKind: 'ZodError',
      issues: [{ code: 'invalid_type', path: 'scope.locationId' }],
      billedAttempts: [{ provider: 'openai', model: OPENAI_MODEL, usage: USAGE }],
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/SENTINEL/);
  });
});

describe('run.ts offline default', () => {
  it('does not import the keyed structured lane', async () => {
    vi.resetModules();
    vi.doMock('../structured-runner', () => {
      throw new Error('keyed structured lane was imported by the offline path');
    });
    try {
      const { runEval } = await import('../run');
      const { loadEvalSet } = await import('../load');
      const report = await runEval(loadEvalSet(), { live: false });
      expect(report.failed).toBe(0);
    } finally {
      vi.doUnmock('../structured-runner');
    }
  });
});
