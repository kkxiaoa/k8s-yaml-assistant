export const APPLICATION_BASE_PATH = '';

/**
 * @param {`/${string}`} path
 */
export function applicationPath(path) {
  return `${APPLICATION_BASE_PATH}${path}`;
}
