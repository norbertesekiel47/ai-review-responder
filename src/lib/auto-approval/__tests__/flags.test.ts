import { afterEach, describe, expect, it } from 'vitest';
import {
  autoApprovalRuntimeEnabled,
  governorEnabled,
  providerModerationEnabled,
  providerModerationValidated,
} from '../flags';

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
}

afterEach(() => {
  resetEnv();
});

describe('auto-approval flag helpers', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase true', 'TRUE'],
    ['mixed case true', 'True'],
    ['numeric true', '1'],
    ['padded true', ' true '],
  ])('keeps AUTO_APPROVAL_ENABLED disabled for %s values', (_label, value) => {
    if (value === undefined) {
      delete process.env.AUTO_APPROVAL_ENABLED;
    } else {
      process.env.AUTO_APPROVAL_ENABLED = value;
    }

    expect(autoApprovalRuntimeEnabled()).toBe(false);
  });

  it('enables auto approval only for exact string true', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';

    expect(autoApprovalRuntimeEnabled()).toBe(true);
  });

  it('reads provider moderation enabled only from exact OPENAI_MODERATION_ENABLED=true', () => {
    process.env.OPENAI_MODERATION_ENABLED = 'TRUE';
    expect(providerModerationEnabled()).toBe(false);

    process.env.OPENAI_MODERATION_ENABLED = 'true';
    expect(providerModerationEnabled()).toBe(true);
  });

  it('reads provider validation readiness only from exact AUTO_APPROVAL_PROVIDER_MODERATION_READY=true', () => {
    process.env.AUTO_APPROVAL_PROVIDER_MODERATION_READY = 'yes';
    expect(providerModerationValidated()).toBe(false);

    process.env.AUTO_APPROVAL_PROVIDER_MODERATION_READY = 'true';
    expect(providerModerationValidated()).toBe(true);
  });

  it('enables the autonomy governor only for exact GOVERNOR_ENABLED=true', () => {
    process.env.GOVERNOR_ENABLED = 'TRUE';
    expect(governorEnabled()).toBe(false);

    process.env.GOVERNOR_ENABLED = 'true';
    expect(governorEnabled()).toBe(true);
  });
});
