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
