// Unit tests for handleDeleteError — focused on the #355 Pass-1 instrumentation
// for the http_400 / delete_reply disposition. Style mirrors
// publisher-error-handlers.test.ts (spy logger + count-tagged tx result).

import { describe, it, expect, vi } from 'vitest';
import { handleDeleteError } from '../edit-publish-errors';
import { ZernioPermanentError } from '../../../../src/lib/zernio/errors';
import type { WorkerLogger } from '../../../../src/lib/shared/logger';

// Minimal tx stub: every tagged call resolves to a count-tagged array. The
// handler only inspects `.count` on the UPDATE result, so count:1 = "candidate
// row updated" (the happy disposition path).
function mkTxReturning(count: number) {
  return vi.fn(() =>
    Promise.resolve(Object.assign([], { count })),
  ) as unknown as Parameters<typeof handleDeleteError>[0];
}

const mkLogger = (): WorkerLogger => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

function mkArgs(logger: WorkerLogger) {
  return {
    responseId: 'resp-1',
    businessId: 'biz-1',
    zernioAccountId: 'acct-1',
    zernioLocationId: 'loc-1',
    logger,
  };
}

function capturedLogText(logger: WorkerLogger): string {
  return JSON.stringify([
    ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
    ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
  ]);
}

describe('handleDeleteError — http_400 / delete_reply instrumentation (Pass 1)', () => {
  it('logs the Zernio body.code and still returns permanent_failed', async () => {
    const logger = mkLogger();
    const tx = mkTxReturning(1);
    const err = new ZernioPermanentError('http_400', {
      status: 400,
      body: { code: 'some_test_code' },
      endpointKind: 'delete_reply',
    });

    const outcome = await handleDeleteError(tx, err, mkArgs(logger));

    expect(outcome).toEqual({ kind: 'permanent_failed' });

    const serialized = capturedLogText(logger);
    expect(serialized).toContain('some_test_code');
    expect(serialized).toContain('delete_reply_400_body');
  });

  it('does not emit the 400 instrumentation for a non-400 permanent error', async () => {
    const logger = mkLogger();
    const tx = mkTxReturning(1);
    const err = new ZernioPermanentError('inbox_addon_required', { endpointKind: 'delete_reply' });

    const outcome = await handleDeleteError(tx, err, mkArgs(logger));

    expect(outcome).toEqual({ kind: 'permanent_failed' });
    expect(capturedLogText(logger)).not.toContain('delete_reply_400_body');
  });
});
