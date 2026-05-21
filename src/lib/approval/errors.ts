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
