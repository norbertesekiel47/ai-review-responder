export class ZernioAuthError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Zernio auth error (${status}): ${body.slice(0, 200)}`);
    this.name = 'ZernioAuthError';
  }
}

export class ZernioValidationError extends Error {
  constructor(public readonly code: string, public readonly body: unknown) {
    super(`Zernio validation: ${code}`);
    this.name = 'ZernioValidationError';
  }
}

export class ZernioTransientError extends Error {
  constructor(
    public readonly kind: string,
    public readonly meta: Record<string, unknown>,
  ) {
    super(`Zernio transient: ${kind}`);
    this.name = 'ZernioTransientError';
  }
}

export class ZernioPermanentError extends Error {
  constructor(
    public readonly kind: string,
    public readonly meta: Record<string, unknown>,
  ) {
    super(`Zernio permanent: ${kind}`);
    this.name = 'ZernioPermanentError';
  }
}

export class ZernioReviewNotFoundError extends Error {
  constructor(public readonly meta: Record<string, unknown>) {
    super('Zernio review not found');
    this.name = 'ZernioReviewNotFoundError';
  }
}

export class ZernioReplyAlreadyExistsError extends Error {
  constructor(public readonly body: unknown) {
    super('Zernio reply already exists');
    this.name = 'ZernioReplyAlreadyExistsError';
  }
}

export class ZernioRouteError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(`Zernio route error: ${statusCode} ${code}`);
    this.name = 'ZernioRouteError';
  }
}
