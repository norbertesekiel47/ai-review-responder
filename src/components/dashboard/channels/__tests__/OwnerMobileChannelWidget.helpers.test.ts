import { describe, expect, it } from 'vitest';
import type { EnrollmentState } from '@/lib/notifications/channels/enrollment-reducer';
import {
  DISCONNECT_CONSEQUENCE,
  channelHandleText,
  enrollmentTransitionToast,
  formatQrTtl,
  isConnectableState,
  maskHandle,
  rowToInitialSnapshot,
} from '../OwnerMobileChannelWidget.helpers';

const COPY = { idleText: 'Get approvals in Telegram.', unsubscribedText: 'You blocked the bot.' };

describe('rowToInitialSnapshot', () => {
  it('hydrates only a verified row', () => {
    expect(rowToInitialSnapshot({ handle: '+15551234567', status: 'verified' })).toMatchObject({
      state: 'verified',
      handle: '+15551234567',
      deepLink: null,
      qrDataUrl: null,
    });
  });

  it('leaves every other status to the first fetch', () => {
    expect(rowToInitialSnapshot({ handle: null, status: 'pending_verification' })).toBeUndefined();
    expect(rowToInitialSnapshot({ handle: null, status: 'disabled' })).toBeUndefined();
    expect(rowToInitialSnapshot(null)).toBeUndefined();
  });
});

describe('maskHandle', () => {
  it('keeps the last four characters and hides the rest', () => {
    expect(maskHandle('+15551234567')).toBe('••• 4567');
  });

  it('shows only dots for a missing or too-short handle', () => {
    expect(maskHandle(null)).toBe('•••');
    expect(maskHandle('1234')).toBe('•••');
  });
});

describe('isConnectableState', () => {
  it('allows a (re)connect from idle, disabled, unsubscribed and expired only', () => {
    const connectable: EnrollmentState[] = ['idle', 'disabled', 'unsubscribed', 'expired'];
    const notConnectable: EnrollmentState[] = ['generating', 'awaiting_scan', 'verified', 'error'];
    for (const state of connectable) expect(isConnectableState(state)).toBe(true);
    for (const state of notConnectable) expect(isConnectableState(state)).toBe(false);
  });
});

describe('channelHandleText', () => {
  it('uses the channel copy for idle and unsubscribed', () => {
    expect(channelHandleText({ state: 'idle', handle: null, errorMessage: null }, COPY)).toBe(COPY.idleText);
    expect(channelHandleText({ state: 'unsubscribed', handle: null, errorMessage: null }, COPY)).toBe(
      COPY.unsubscribedText,
    );
  });

  it('masks the handle when connected', () => {
    expect(channelHandleText({ state: 'verified', handle: '+15551234567', errorMessage: null }, COPY)).toBe(
      'Connected · ••• 4567',
    );
  });

  it('renders the reducer error, with a fallback when it carries none', () => {
    expect(channelHandleText({ state: 'error', handle: null, errorMessage: 'Rate limited' }, COPY)).toBe(
      'Rate limited',
    );
    expect(channelHandleText({ state: 'error', handle: null, errorMessage: null }, COPY)).toBe(
      'Something went wrong.',
    );
  });

  it('has a sentence for every remaining state', () => {
    const states: EnrollmentState[] = ['generating', 'awaiting_scan', 'disabled', 'expired'];
    for (const state of states) {
      expect(channelHandleText({ state, handle: null, errorMessage: null }, COPY)).not.toBe('');
    }
  });
});

describe('enrollmentTransitionToast', () => {
  it('confirms a scan landing', () => {
    expect(enrollmentTransitionToast('awaiting_scan', 'verified', 'Telegram')).toEqual({
      tone: 'success',
      title: 'Telegram connected',
    });
  });

  it('confirms a disconnect and names the consequence', () => {
    expect(enrollmentTransitionToast('verified', 'disabled', 'WhatsApp')).toEqual({
      tone: 'success',
      title: 'WhatsApp disconnected',
      body: DISCONNECT_CONSEQUENCE,
    });
  });

  it('is silent for every other transition, including no transition', () => {
    expect(enrollmentTransitionToast('verified', 'verified', 'Telegram')).toBeNull();
    expect(enrollmentTransitionToast('idle', 'generating', 'Telegram')).toBeNull();
    expect(enrollmentTransitionToast('idle', 'verified', 'Telegram')).toBeNull();
    expect(enrollmentTransitionToast('awaiting_scan', 'expired', 'Telegram')).toBeNull();
  });
});

describe('formatQrTtl', () => {
  it('formats minutes and seconds', () => {
    expect(formatQrTtl(125)).toBe('2m 5s');
    expect(formatQrTtl(0)).toBe('0m 0s');
    expect(formatQrTtl(59)).toBe('0m 59s');
  });
});
