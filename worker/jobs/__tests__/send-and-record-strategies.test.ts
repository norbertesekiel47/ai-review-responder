import { describe, it, expect, vi } from 'vitest';
import { sendMarkedFirst, sendKeyed } from '../send-and-record-strategies';

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('sendMarkedFirst', () => {
  it('marks BEFORE sending', async () => {
    const mark = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockImplementation(() => {
      expect(mark).toHaveBeenCalled();
      return Promise.resolve({ messageId: 'msg-1' });
    });

    await sendMarkedFirst({
      logger: makeLogger(),
      label: 'test',
      mark,
      send,
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    });

    expect(mark).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never rethrows a send failure — records it durably instead', async () => {
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const recordSuccess = vi.fn();

    await expect(
      sendMarkedFirst({
        logger: makeLogger(),
        label: 'test',
        mark: vi.fn(),
        send: vi.fn().mockRejectedValue(new Error('boom')),
        recordFailure,
        recordSuccess,
      }),
    ).resolves.toBeUndefined();

    expect(recordFailure).toHaveBeenCalledWith('boom');
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it('calls recordSuccess with the send result only on success', async () => {
    const recordSuccess = vi.fn().mockResolvedValue(undefined);

    await sendMarkedFirst({
      logger: makeLogger(),
      label: 'test',
      mark: vi.fn(),
      send: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      recordFailure: vi.fn(),
      recordSuccess,
    });

    expect(recordSuccess).toHaveBeenCalledWith({ messageId: 'msg-1' });
  });

  it('never escapes when recordFailure itself rejects (best-effort, own try/catch)', async () => {
    const logger = makeLogger();

    await expect(
      sendMarkedFirst({
        logger,
        label: 'test',
        mark: vi.fn(),
        send: vi.fn().mockRejectedValue(new Error('boom')),
        recordFailure: vi.fn().mockRejectedValue(new Error('pool exhausted')),
        recordSuccess: vi.fn(),
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool exhausted'));
  });

  it('propagates a mark failure — mark is not guarded by this function', async () => {
    const send = vi.fn();

    await expect(
      sendMarkedFirst({
        logger: makeLogger(),
        label: 'test',
        mark: vi.fn().mockRejectedValue(new Error('db down')),
        send,
        recordFailure: vi.fn(),
        recordSuccess: vi.fn(),
      }),
    ).rejects.toThrow('db down');

    expect(send).not.toHaveBeenCalled();
  });
});

describe('sendKeyed', () => {
  it('propagates a send failure unchanged (no catch — caller can retry)', async () => {
    const recordSuccess = vi.fn();

    await expect(
      sendKeyed({
        send: vi.fn().mockRejectedValue(new Error('Resend 503')),
        recordSuccess,
      }),
    ).rejects.toThrow('Resend 503');

    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it('calls recordSuccess with the send result, including an idempotent replay', async () => {
    const recordSuccess = vi.fn().mockResolvedValue(undefined);
    const result = { messageId: 'idempotent-replay:key', idempotentReplay: true };

    await sendKeyed({ send: vi.fn().mockResolvedValue(result), recordSuccess });

    expect(recordSuccess).toHaveBeenCalledWith(result);
  });
});
