import { describe, it, expect } from 'vitest';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
} from '../errors';

describe('link-state typed errors', () => {
  it('ConsumedLinkError has correct name and message', () => {
    const err = new ConsumedLinkError();
    expect(err.name).toBe('ConsumedLinkError');
    expect(err.message).toMatch(/already been used/i);
    expect(err).toBeInstanceOf(Error);
  });

  it('RevokedLinkError has correct name and message', () => {
    const err = new RevokedLinkError();
    expect(err.name).toBe('RevokedLinkError');
    expect(err.message).toMatch(/revoked/i);
    expect(err).toBeInstanceOf(Error);
  });

  it('ExpiredLinkError has correct name and message', () => {
    const err = new ExpiredLinkError();
    expect(err.name).toBe('ExpiredLinkError');
    expect(err.message).toMatch(/expired/i);
    expect(err).toBeInstanceOf(Error);
  });

  it('ChannelMismatchError carries expected and actual channel', () => {
    const err = new ChannelMismatchError('telegram', 'sms');
    expect(err.name).toBe('ChannelMismatchError');
    expect(err.expectedChannel).toBe('telegram');
    expect(err.actualChannel).toBe('sms');
    expect(err.message).toContain('telegram');
    expect(err.message).toContain('sms');
  });
});
