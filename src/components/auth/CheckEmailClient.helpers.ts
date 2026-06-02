export function redirectAfterServerSessionCookie(
  value: unknown,
  assign: (url: string) => void = (url) => window.location.assign(url),
): void {
  const destination =
    typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
      ? value
      : '/onboarding/pay';
  assign(destination);
}
