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
    return 'posted';
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
}
