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
  // Compare URL.origin (scheme + host + port) so subpath APP_URLs like
  // `https://app.example.com/prefix` still match an Origin header of
  // `https://app.example.com`. The previous string-trim approach broke
  // for any non-empty path component.
  let expectedOrigin: string;
  let actualOrigin: string;
  try {
    expectedOrigin = new URL(appUrl).origin;
    actualOrigin = new URL(origin).origin;
  } catch {
    throw new SameOriginError(
      `Malformed Origin or APP_URL — origin=${origin}, APP_URL=${appUrl}`,
    );
  }
  if (actualOrigin !== expectedOrigin) {
    throw new SameOriginError(`Origin ${origin} does not match APP_URL ${appUrl}`);
  }
}
