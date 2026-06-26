import { afterEach, describe, expect, it } from 'vitest';
import {
  zernioPublishingEnabled,
  externalReplyImportEnabled,
  zernioRecentReviewPollDisabled,
} from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const FALSE_CASES: ReadonlyArray<[string, string | undefined]> = [
  ['missing', undefined],
  ['empty', ''],
  ['false', 'false'],
  ['uppercase TRUE', 'TRUE'],
  ['mixed case True', 'True'],
  ['numeric 1', '1'],
  ['padded true', ' true '],
];

const ACCESSORS: ReadonlyArray<[string, () => boolean]> = [
  ['ZERNIO_PUBLISHING_ENABLED', zernioPublishingEnabled],
  ['EXTERNAL_REPLY_IMPORT_ENABLED', externalReplyImportEnabled],
  ['ZERNIO_RECENT_REVIEW_POLL_DISABLED', zernioRecentReviewPollDisabled],
];

describe.each(ACCESSORS)('%s accessor', (envName, accessor) => {
  it.each(FALSE_CASES)('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
    expect(accessor()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env[envName] = 'true';
    expect(accessor()).toBe(true);
  });
});
