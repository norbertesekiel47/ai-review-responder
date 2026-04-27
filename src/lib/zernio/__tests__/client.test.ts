import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyAndParse, zernioClient } from '../client';
import {
  ZernioAuthError,
  ZernioValidationError,
  ZernioTransientError,
  ZernioPermanentError,
  ZernioReviewNotFoundError,
  ZernioReplyAlreadyExistsError,
} from '../errors';

function mkRes(opts: { status: number; body?: unknown }): Response {
  return new Response(opts.body !== undefined ? JSON.stringify(opts.body) : null, {
    status: opts.status,
  });
}

describe('classifyAndParse', () => {
  describe('success paths', () => {
    it('parses 200 JSON response', async () => {
      const res = mkRes({ status: 200, body: { foo: 'bar' } });
      const result = await classifyAndParse<{ foo: string }>(res, 'list_reviews');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('returns undefined for 204 No Content', async () => {
      const res = mkRes({ status: 204 });
      const result = await classifyAndParse(res, 'delete_account');
      expect(result).toBeUndefined();
    });

    it('returns undefined for delete_account endpoint regardless of body', async () => {
      const res = mkRes({ status: 200 });
      const result = await classifyAndParse(res, 'delete_account');
      expect(result).toBeUndefined();
    });

    it('throws ZernioTransientError on malformed JSON in 200 response', async () => {
      const res = new Response('not json{', { status: 200 });
      await expect(classifyAndParse(res, 'list_reviews')).rejects.toBeInstanceOf(
        ZernioTransientError,
      );
    });
  });

  describe('error classification', () => {
    it('401 → ZernioAuthError', async () => {
      const res = mkRes({ status: 401 });
      await expect(classifyAndParse(res, 'select_location')).rejects.toBeInstanceOf(
        ZernioAuthError,
      );
    });

    it('403 → ZernioAuthError', async () => {
      const res = mkRes({ status: 403 });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(
        ZernioAuthError,
      );
    });

    it('409 on publish_reply → ZernioReplyAlreadyExistsError', async () => {
      const res = mkRes({ status: 409, body: { message: 'reply exists' } });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(
        ZernioReplyAlreadyExistsError,
      );
    });

    it('409 on non-publish_reply → ZernioTransientError', async () => {
      const res = mkRes({ status: 409, body: {} });
      await expect(classifyAndParse(res, 'select_location')).rejects.toBeInstanceOf(
        ZernioTransientError,
      );
    });

    it('404 on publish_reply → ZernioReviewNotFoundError', async () => {
      const res = mkRes({ status: 404, body: {} });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(
        ZernioReviewNotFoundError,
      );
    });

    it('400 with allowlisted code on select_location → ZernioValidationError', async () => {
      const res = mkRes({ status: 400, body: { code: 'invalid_connect_token' } });
      await expect(classifyAndParse(res, 'select_location')).rejects.toBeInstanceOf(
        ZernioValidationError,
      );
    });

    it('400 with non-allowlisted code on select_location → ZernioTransientError unknown_4xx_unknown_outcome', async () => {
      const res = mkRes({ status: 400, body: { code: 'random_other' } });
      await expect(classifyAndParse(res, 'select_location')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'unknown_4xx_unknown_outcome',
      });
    });

    it('400 on publish_reply → ZernioPermanentError (NOT ValidationError, even with allowlisted code)', async () => {
      const res = mkRes({ status: 400, body: { code: 'invalid_connect_token' } });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(
        ZernioPermanentError,
      );
    });

    it('500 → ZernioTransientError http_500', async () => {
      const res = mkRes({ status: 500 });
      await expect(classifyAndParse(res, 'select_location')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_500',
      });
    });

    it('429 → ZernioTransientError http_429', async () => {
      const res = mkRes({ status: 429 });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_429',
      });
    });
  });
});
