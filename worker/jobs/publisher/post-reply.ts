import { zernioClient } from '../../../src/lib/zernio/client';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioReplyAlreadyExistsError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import {
  handlePublisherAuthErrorTerminal,
  handlePublisherPermanentErrorTerminal,
  PublisherTransientWithContext,
  verify409AndDispose,
  ZernioReplyVerificationIndeterminateError,
} from './publisher-error-handlers';
import { verifyOwnReplyAttached } from './verify-posted';
import type { ZernioConnectionRow } from './types';

export async function postReplyAndHandleTerminalOutcomes(input: {
  responseId: string;
  businessId: string;
  reviewId: string;
  zernioReviewId: string;
  approvedText: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  correlationId?: string;
  zernioConnection: ZernioConnectionRow;
  logger: WorkerLogger;
}): Promise<'posted' | 'completed'> {
  const {
    responseId,
    businessId,
    reviewId,
    zernioReviewId,
    approvedText,
    outboxId,
    outboxAttempt,
    correlationId,
    zernioConnection,
    logger,
  } = input;

  try {
    await zernioClient.postReply(
      zernioConnection.zernio_account_id,
      zernioReviewId,
      { comment: approvedText },
    );
    // Fall through to post-verification below — do NOT return 'posted' yet.
  } catch (err) {
    if (err instanceof ZernioReplyAlreadyExistsError) {
      const result = await verify409AndDispose({
        response_id: responseId,
        business_id: businessId,
        review_id: reviewId,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
        zernio_review_id: zernioReviewId,
        approved_text: approvedText,
        outboxId,
        outboxAttempt,
        logger,
      });

      switch (result.outcome) {
        case 'posted':
        case 'superseded':
          return 'completed';

        case 'transient':
          throw new PublisherTransientWithContext(result.lookupErr, {
            response_id: responseId,
            business_id: businessId,
            account_id: zernioConnection.zernio_account_id,
            location_id: zernioConnection.zernio_location_id,
          });

        case 'auth': {
          const lookupErr = result.lookupErr;
          await handlePublisherAuthErrorTerminal({
            response_id: responseId,
            business_id: businessId,
            account_id: zernioConnection.zernio_account_id,
            location_id: zernioConnection.zernio_location_id,
            error_body: lookupErr.body ? String(lookupErr.body).slice(0, 500) : lookupErr.message,
            outboxId,
            outboxAttempt,
            correlation_id: correlationId,
            logger,
          });
          return 'completed';
        }

        case 'permanent': {
          const lookupErr = result.lookupErr;
          const endpointKind =
            lookupErr instanceof ZernioPermanentError && typeof lookupErr.meta?.endpointKind === 'string'
              ? lookupErr.meta.endpointKind
              : 'list_reviews';
          const errBody =
            lookupErr instanceof ZernioPermanentError
              ? lookupErr.meta
              : { code: lookupErr.code, body: lookupErr.body };
          await handlePublisherPermanentErrorTerminal({
            response_id: responseId,
            business_id: businessId,
            review_id: reviewId,
            endpoint_kind: endpointKind,
            http_status: 400,
            error_body: errBody,
            outboxId,
            outboxAttempt,
            logger,
          });
          return 'completed';
        }

        case 'indeterminate':
          throw new ZernioReplyVerificationIndeterminateError({
            response_id: responseId,
            business_id: businessId,
            review_id: reviewId,
            account_id: zernioConnection.zernio_account_id,
            location_id: zernioConnection.zernio_location_id,
            zernio_review_id: zernioReviewId,
            reason: result.reason,
            ...result.meta,
          });
      }
    }

    if (err instanceof ZernioAuthError) {
      await handlePublisherAuthErrorTerminal({
        response_id: responseId,
        business_id: businessId,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
        error_body: err.body ? String(err.body).slice(0, 500) : err.message,
        outboxId,
        outboxAttempt,
        correlation_id: correlationId,
        logger,
      });
      return 'completed';
    }

    if (err instanceof ZernioPermanentError || err instanceof ZernioValidationError) {
      const endpointKind =
        err instanceof ZernioPermanentError && typeof err.meta?.endpointKind === 'string'
          ? err.meta.endpointKind
          : 'publish_reply';
      const errBody =
        err instanceof ZernioPermanentError ? err.meta : { code: err.code, body: err.body };

      await handlePublisherPermanentErrorTerminal({
        response_id: responseId,
        business_id: businessId,
        review_id: reviewId,
        endpoint_kind: endpointKind,
        http_status: 400,
        error_body: errBody,
        outboxId,
        outboxAttempt,
        logger,
      });
      return 'completed';
    }

    if (err instanceof ZernioTransientError) {
      throw new PublisherTransientWithContext(err, {
        response_id: responseId,
        business_id: businessId,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
      });
    }

    throw err;
  }

  // postReply returned 2xx. Confirm our reply is actually attached on Zernio
  // before reporting 'posted'. A stale/phantom review id can yield a 2xx while
  // the reply never reaches Google (staging 2026-05-31 false-positive). Throws
  // when unconfirmed: ZernioReplyVerificationIndeterminateError → failed +
  // review_exception + admin alert at retry exhaustion; PublisherTransientWith-
  // Context → BullMQ retry, whose next attempt 409s into verify409AndDispose.
  await verifyOwnReplyAttached({
    responseId,
    businessId,
    reviewId,
    zernioReviewId,
    approvedText,
    accountId: zernioConnection.zernio_account_id,
    locationId: zernioConnection.zernio_location_id,
    logger,
  });
  return 'posted';
}
