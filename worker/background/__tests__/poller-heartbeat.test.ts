import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  maybeLogPollerHeartbeat,
  notePollerActivity,
  __resetPollerHeartbeatState,
} from '../poller-heartbeat';

const HEARTBEAT_MS = 30 * 60_000;

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  __resetPollerHeartbeatState();
});

describe('poller-heartbeat', () => {
  it('stays silent on the first idle tick for a cold key', () => {
    const logger = makeLogger();
    maybeLogPollerHeartbeat(logger, '[P]', 0);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('emits one heartbeat once the idle interval has elapsed', () => {
    const logger = makeLogger();
    maybeLogPollerHeartbeat(logger, '[P]', 0); // cold: starts clock, silent
    maybeLogPollerHeartbeat(logger, '[P]', HEARTBEAT_MS - 1); // not yet due
    expect(logger.log).not.toHaveBeenCalled();
    maybeLogPollerHeartbeat(logger, '[P]', HEARTBEAT_MS); // due
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith('Idle heartbeat', { idle_min: 30 });
  });

  it('resets the clock after each heartbeat so it does not double-fire', () => {
    const logger = makeLogger();
    maybeLogPollerHeartbeat(logger, '[P]', 0);
    maybeLogPollerHeartbeat(logger, '[P]', HEARTBEAT_MS); // fires
    maybeLogPollerHeartbeat(logger, '[P]', HEARTBEAT_MS + 1); // silent again
    expect(logger.log).toHaveBeenCalledTimes(1);
  });

  it('notePollerActivity resets the idle clock so the next idle stays silent', () => {
    const logger = makeLogger();
    maybeLogPollerHeartbeat(logger, '[P]', 0); // cold
    notePollerActivity('[P]', HEARTBEAT_MS); // real work at +30m resets the clock
    maybeLogPollerHeartbeat(logger, '[P]', HEARTBEAT_MS + 5); // only 5ms since work
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('keeps independent clocks per key', () => {
    const logger = makeLogger();
    maybeLogPollerHeartbeat(logger, '[A]', 0);
    maybeLogPollerHeartbeat(logger, '[B]', 0);
    maybeLogPollerHeartbeat(logger, '[A]', HEARTBEAT_MS); // A due
    expect(logger.log).toHaveBeenCalledTimes(1);
    maybeLogPollerHeartbeat(logger, '[B]', HEARTBEAT_MS + 100); // B due
    expect(logger.log).toHaveBeenCalledTimes(2);
  });

  it('__resetPollerHeartbeatState clears all clocks', () => {
    const logger = makeLogger();
    maybeLogPollerHeartbeat(logger, '[P]', 0); // sets clock
    __resetPollerHeartbeatState();
    // Cold again: treated as a first idle tick, so it stays silent.
    maybeLogPollerHeartbeat(logger, '[P]', HEARTBEAT_MS);
    expect(logger.log).not.toHaveBeenCalled();
  });
});
