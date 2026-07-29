export const APPLICATION_BASE_PATH = '/k8s-yaml-assistant';

/**
 * @param {`/${string}`} path
 */
export function applicationPath(path) {
  return `${APPLICATION_BASE_PATH}${path}`;
}

export function rootHealthRedirects() {
  return ['/api/health/live', '/api/health/ready'].map((source) => ({
    source,
    destination: applicationPath(source),
    permanent: false,
    basePath: false,
  }));
}
