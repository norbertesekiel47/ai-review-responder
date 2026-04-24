export class SameOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SameOriginError';
  }
}

export function assertSameOrigin(request: Request): void {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new SameOriginError('NEXT_PUBLIC_APP_URL not configured — cannot validate Origin header');
  }
  const origin = request.headers.get('origin');
  if (!origin) {
    throw new SameOriginError('Missing Origin header');
  }
  const normalize = (u: string) => u.replace(/\/+$/, '');
  if (normalize(origin) !== normalize(appUrl)) {
    throw new SameOriginError(`Origin ${origin} does not match APP_URL ${appUrl}`);
  }
}
