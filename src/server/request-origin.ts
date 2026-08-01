type OriginEnvironment = Readonly<Record<string, string | undefined>>;

export function hasValidApplicationOrigin(
  request: Request,
  environment: OriginEnvironment = process.env,
): boolean {
  const configured = environment.APP_PUBLIC_ORIGIN;
  if (configured === undefined) return false;
  try {
    const url = new URL(configured);
    const developmentLoopback =
      environment.NODE_ENV === 'development' &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.origin !== configured ||
      (url.protocol !== 'https:' && !developmentLoopback) ||
      url.username ||
      url.password
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return request.headers.get('origin') === configured;
}
