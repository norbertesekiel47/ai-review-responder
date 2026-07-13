import { SKIP_REASON_ARCHIVED_LOCATION } from '@/lib/shared/worker-types';

export class InvalidTokenError extends Error {
  constructor() {
    super('Invalid or unknown approval token');
    this.name = 'InvalidTokenError';
  }
}

export class ExpiredTokenError extends Error {
  constructor() {
    super('This approval link has expired');
    this.name = 'ExpiredTokenError';
  }
}

export class RevokedTokenError extends Error {
  constructor() {
    super('This approval link has been revoked');
    this.name = 'RevokedTokenError';
  }
}

export class ConsumedTokenError extends Error {
  constructor() {
    super('This approval link has already been used');
    this.name = 'ConsumedTokenError';
  }
}

export class DeviceConflictError extends Error {
  constructor() {
    super('This approval link is bound to a different device');
    this.name = 'DeviceConflictError';
  }
}

export class ResponseNotPendingError extends Error {
  constructor(public readonly currentStatus: string) {
    super(`Response is no longer pending approval (current status: ${currentStatus})`);
    this.name = 'ResponseNotPendingError';
  }
}

/**
 * Thrown when an approval action targets a location that has been archived.
 *
 * Extends ResponseNotPendingError deliberately: every existing lane already
 * classifies that class as a permanent conflict (token/dashboard routes map
 * it to 409; the Telegram/WhatsApp callback ingress treats it as terminal,
 * never retried), so archived rejections inherit correct handling everywhere
 * without each lane adding a new mapping.
 */
export class ArchivedLocationError extends ResponseNotPendingError {
  constructor() {
    super(SKIP_REASON_ARCHIVED_LOCATION);
    this.name = 'ArchivedLocationError';
    this.message = 'This location has been archived — approval actions are no longer available for this draft.';
  }
}

/**
 * Thrown when a veto arrives after the publish outbox row was already claimed
 * (posting/posted) OR the response left the scheduled auto-post state by
 * another path (e.g. the kill-switch downgrade already returned it to the
 * owner's queue). Deliberately non-committal — the caller only learns "this
 * link can no longer cancel", never a guess about which of those happened.
 */
export class VetoTooLateError extends Error {
  constructor() {
    super('This link can no longer cancel the post — check the dashboard for current status.');
    this.name = 'VetoTooLateError';
  }
}

export class EmptyEditedResponseError extends Error {
  constructor() {
    super('editedText is required');
    this.name = 'EmptyEditedResponseError';
  }
}

export class ConsumedLinkError extends Error {
  constructor() {
    super('This approval link has already been used');
    this.name = 'ConsumedLinkError';
  }
}

export class RevokedLinkError extends Error {
  constructor() {
    super('This approval link has been revoked');
    this.name = 'RevokedLinkError';
  }
}

export class ExpiredLinkError extends Error {
  constructor() {
    super('This approval link has expired');
    this.name = 'ExpiredLinkError';
  }
}

export class ChannelMismatchError extends Error {
  constructor(
    public readonly expectedChannel: string,
    public readonly actualChannel: string,
  ) {
    super(`Approval link channel mismatch — expected ${expectedChannel}, got ${actualChannel}`);
    this.name = 'ChannelMismatchError';
  }
}
